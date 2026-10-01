// SPDX-License-Identifier: AGPL-3.0-only
// Routes de la bibliothèque d'auth, en liste blanche (13 § 5) : connexion, déconnexion, lecture de session. Tout
// autre chemin /api/auth/* de la bibliothèque (inscription, réinitialisation, listes de sessions…) répond 404.
// Chaque connexion, échec de connexion et déconnexion est audité (13 § 9) ; le jeton de session ne sort que dans le
// cookie HttpOnly.
// Débit (13 § 5, ASVS 6.1.1) : limite par IP (bibliothèque, sur request.ip seulement) ET par compte (e-mail normalisé).
// D-15 (tâche 3.7) : la limite du compte n'est pas opposée à une connexion depuis un appareil reconnu (cookie posé
// après une authentification complète) ni depuis une session ouverte du même compte ; la limite par IP reste.
// 2FA « maison » (13 § 7, tâche 3.7) : un compte à 2FA confirmée reçoit une session EN ATTENTE ; le second facteur
// (`/api/auth/two-factor/verify`) la remplace par une session complète (nouveau jeton). Réinitialisation du mot de
// passe par lien à usage unique : jamais sans le second facteur d'un compte qui en a un (6.4.3).
import {
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  isOpaqueTokenFormat,
  isRole,
  needsRehash,
  passwordPolicyViolation,
  RESET_LINK_TTL_HOURS,
} from '@runtime/core';
import { hasConfirmedTwoFactor, revokeUserAccess } from '@runtime/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { issueSession } from '../auth/better-auth.js';
import { hashSessionToken } from '../auth/hashed-session-adapter.js';
import { readSsoSettings } from '../auth/security-settings.js';
import type { ServerContext } from '../context.js';
import { AttemptLimiter } from '../rate-limit.js';
import { knownDeviceUser, libraryHeaders, rememberDevice, sendAccountMail, smtpConfigured, verifySecondFactor } from './account-helpers.js';
import { audit, sendError, webHeaders } from './guard.js';

/** Échecs de connexion tolérés par compte sur 15 minutes, toutes IP confondues. */
const ACCOUNT_MAX_FAILURES = 10;
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
/** Second facteur : 5 échecs par compte sur 15 min → session en attente fermée, 429. */
const MFA_MAX_FAILURES = 5;

/** Réponse unique à tout échec de connexion (compte inconnu, désactivé, mauvais mot de passe…), 13 § 5 (6.3.8). */
const INVALID_CREDENTIALS = { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' };

const signInSchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', maxLength: 254 },
    password: { type: 'string', maxLength: 1024 },
    rememberMe: { type: 'boolean' },
  },
} as const;

type Result = { status: number; headers: Headers; json: unknown };

async function forward(ctx: ServerContext, request: FastifyRequest): Promise<Result> {
  const headers = libraryHeaders(request);
  let body: string | undefined;
  if (request.method !== 'GET') {
    body = JSON.stringify(request.body ?? {});
    headers.set('content-type', 'application/json');
  }
  const response = await ctx.auth.handler(new Request(new URL(request.url, ctx.publicUrl), { method: request.method, headers, body }));
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: { code: 'auth_error', message: 'erreur d’authentification' } };
  }
  return { status: response.status, headers: response.headers, json };
}

function relay(reply: FastifyReply, result: Result): FastifyReply {
  const cookies = result.headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
  return reply.code(result.status).send(result.json);
}

/** Retire tout champ `token` d'une réponse de la bibliothèque (le jeton ne vit que dans le cookie). */
function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'token').map(([k, v]) => [k, withoutTokens(v)]));
}

async function userFor(ctx: ServerContext, where: 'id' | 'email', value: string) {
  const { rows } = await ctx.pool.query<{ id: string; role: string }>(`SELECT id, role FROM users WHERE ${where} = $1`, [value]);
  const row = rows[0];
  return row && isRole(row.role) ? { userId: row.id, role: row.role, via: 'ui' as const } : null;
}

/** Re-hachage si les paramètres argon2 cibles ont changé (13 § 5) : le mot de passe vient d'être vérifié. */
async function rehashIfNeeded(ctx: ServerContext, userId: string, password: string): Promise<void> {
  const { rows } = await ctx.pool.query<{ password_hash: string | null }>(
    "SELECT password_hash FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'",
    [userId],
  );
  const stored = rows[0]?.password_hash;
  if (!stored || !needsRehash(stored)) return;
  await ctx.pool.query("UPDATE auth_accounts SET password_hash = $1, updated_at = now() WHERE user_id = $2 AND provider_id = 'credential' AND password_hash = $3", [
    await hashPassword(password),
    userId,
    stored,
  ]);
}

/** D-15 : l'appareil (cookie d'appareil reconnu) ou la session ouverte de la requête appartiennent-ils à `userId` ? */
async function recognized(ctx: ServerContext, request: FastifyRequest, userId: string): Promise<'device' | 'session' | null> {
  if ((await knownDeviceUser(ctx, request)) === userId) return 'device';
  const current = await ctx.auth.api.getSession({ headers: webHeaders(request) }).catch(() => null);
  return current?.user.id === userId && (current.session as { mfaPending?: boolean }).mfaPending !== true ? 'session' : null;
}

export function authRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const accounts = new AttemptLimiter({ max: ACCOUNT_MAX_FAILURES, windowMs: ACCOUNT_WINDOW_MS });
  const mfaFailures = new AttemptLimiter({ max: MFA_MAX_FAILURES, windowMs: 15 * 60 * 1000 });
  const resetByIp = new AttemptLimiter({ max: 10, windowMs: 15 * 60 * 1000, maxEntries: 10_000 });

  app.post<{ Body: { email: string; password: string } }>('/api/auth/sign-in/email', { schema: { body: signInSchema } }, async (request, reply) => {
    const email = request.body.email.trim().toLowerCase();
    if (accounts.blocked(email)) {
      const target = await userFor(ctx, 'email', email);
      const known = target ? await recognized(ctx, request, target.userId) : null;
      if (!known) {
        await audit(ctx, request, target, { action: 'auth.login_failed', outcome: 'denied', meta: { reason: 'account_rate_limited' } });
        return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
      }
      // D-15 : appareil ou session reconnus, la limite du compte n'est pas opposée (celle par IP reste active).
      await audit(ctx, request, target, { action: 'auth.login_rate_limit_waived', targetType: 'user', targetId: target!.userId, outcome: 'success', meta: { recognized: known } });
    }
    const result = await forward(ctx, request);
    const user = (result.json as { user?: { id?: string } } | null)?.user;
    if (result.status === 200 && user?.id) {
      const actor = await userFor(ctx, 'id', user.id);
      // SSO exigé (13 § 7) : connexion locale refusée, sauf pour l'owner (connexion de secours). Mot de passe déjà vérifié.
      const sso = await readSsoSettings(ctx.pool);
      if (sso?.enabled && sso.sso_required && actor?.role !== 'owner') {
        const token = (result.json as { token?: unknown }).token;
        if (typeof token === 'string') await ctx.pool.query('DELETE FROM auth_sessions WHERE token_hash = $1 AND user_id = $2', [hashSessionToken(token), user.id]);
        await audit(ctx, request, actor, { action: 'auth.login_failed', targetType: 'user', targetId: user.id, outcome: 'denied', meta: { reason: 'sso_required' } });
        return sendError(reply, 403, 'sso_required', 'connexion par le fournisseur d’identité de l’instance exigée');
      }
      accounts.reset(email);
      await rehashIfNeeded(ctx, user.id, request.body.password);
      const pending = await hasConfirmedTwoFactor(ctx.pool, user.id);
      await audit(ctx, request, actor, { action: 'auth.login', targetType: 'user', targetId: user.id, outcome: 'success', meta: pending ? { mfa: 'pending' } : {} });
      if (!pending) reply.header('set-cookie', await rememberDevice(ctx, user.id));
      const body = withoutTokens(result.json) as Record<string, unknown>;
      return relay(reply, { ...result, json: pending ? { ...body, twoFactorRequired: true } : body });
    }
    // Échec : l'identifiant du compte visé (s'il existe) est gardé, pas l'adresse saisie ni le mot de passe.
    const target = await userFor(ctx, 'email', email);
    await audit(ctx, request, target, {
      action: 'auth.login_failed',
      targetType: 'user',
      ...(target ? { targetId: target.userId } : {}),
      outcome: 'denied',
      meta: { status: result.status },
    });
    // 429 de la limite par IP : transmis tel quel ; tout autre échec compte pour le compte et répond à l'identique.
    if (result.status === 429) return relay(reply, result);
    accounts.fail(email);
    return reply.code(401).send(INVALID_CREDENTIALS);
  });

  app.post('/api/auth/sign-out', { schema: { body: { type: 'object', additionalProperties: false, properties: {} } } }, async (request, reply) => {
    const session = await ctx.auth.api.getSession({ headers: webHeaders(request) });
    const result = await forward(ctx, request);
    if (session && result.status === 200) {
      await audit(ctx, request, await userFor(ctx, 'id', session.user.id), { action: 'auth.logout', targetType: 'user', targetId: session.user.id, outcome: 'success' });
    }
    return relay(reply, result);
  });

  app.get('/api/auth/get-session', async (request, reply) => {
    const result = await forward(ctx, request);
    return relay(reply, { ...result, json: withoutTokens(result.json) });
  });

  // Second facteur (13 § 7) : code TOTP (anti-rejeu) ou code de secours (usage unique). Succès : la session en attente
  // est remplacée par une session complète (nouveau jeton, 13 § 5), l'appareil est reconnu (D-15).
  app.post<{ Body: { code: string } }>(
    '/api/auth/two-factor/verify',
    { schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', minLength: 1, maxLength: 32 } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      const closePending = () => ctx.pool.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [actor.sessionId, actor.userId]);
      if (mfaFailures.blocked(actor.userId)) {
        await closePending();
        return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, reconnectez-vous plus tard');
      }
      const method = await verifySecondFactor(ctx, actor.userId, request.body.code);
      if (!method) {
        const failures = mfaFailures.fail(actor.userId);
        await audit(ctx, request, actor, { action: 'auth.mfa_failed', targetType: 'user', targetId: actor.userId, outcome: 'denied', meta: { failures } });
        if (failures >= MFA_MAX_FAILURES) {
          await closePending();
          return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, reconnectez-vous plus tard');
        }
        return sendError(reply, 400, 'invalid_code', 'code invalide ou déjà utilisé');
      }
      mfaFailures.reset(actor.userId);
      const issued = await issueSession(ctx.auth, libraryHeaders(request), actor.userId, method);
      await closePending();
      const remaining =
        method === 'backup_code'
          ? (await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM backup_codes WHERE user_id = $1 AND used_at IS NULL', [actor.userId])).rows[0]?.n
          : undefined;
      await audit(ctx, request, actor, { action: 'auth.mfa_verified', targetType: 'user', targetId: actor.userId, outcome: 'success', meta: { method } });
      reply.header('set-cookie', [...issued.cookies, await rememberDevice(ctx, actor.userId)]);
      return { ok: true, method, ...(remaining === undefined ? {} : { backup_codes_remaining: remaining }) };
    },
  );

  // Mot de passe oublié (13 § 4) : avec SMTP seulement, lien par e-mail. Réponse et délai identiques que le compte
  // existe ou non (6.3.8) : tout le traitement a lieu après la réponse.
  app.post<{ Body: { email: string } }>(
    '/api/auth/password-reset/request',
    { schema: { body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', minLength: 3, maxLength: 254 } } } } },
    async (request, reply) => {
      if (resetByIp.blocked(request.ip)) return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
      resetByIp.fail(request.ip);
      const email = request.body.email.trim().toLowerCase();
      // Tout le travail (recherche du compte, jeton, audit, e-mail) après la réponse : délai identique (6.3.8).
      void (async () => {
        const { rows } = await ctx.pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1 AND status = 'active' AND deleted_at IS NULL", [email]);
        const user = rows[0];
        if (!user || !(await smtpConfigured(ctx))) return;
        const { token, hash } = generateOpaqueToken();
        await ctx.pool.query("DELETE FROM verifications WHERE identifier = 'reset:' || $1::text", [user.id]);
        await ctx.pool.query("INSERT INTO verifications (identifier, value, expires_at) VALUES ('reset:' || $1::text, $2, now() + make_interval(hours => $3))", [
          user.id,
          hash,
          RESET_LINK_TTL_HOURS,
        ]);
        await audit(ctx, request, null, { action: 'auth.password_reset_requested', targetType: 'user', targetId: user.id, outcome: 'success' });
        const link = `${ctx.publicUrl}/reset-password/${token}`;
        await sendAccountMail(
          ctx,
          request,
          email,
          'Scrapyomama Runtime: reset your password / réinitialiser votre mot de passe',
          `A password reset was requested for your account. Open this link within ${RESET_LINK_TTL_HOURS} hours:\n${link}\n\n` +
            `Une réinitialisation du mot de passe a été demandée pour votre compte. Ouvrez ce lien sous ${RESET_LINK_TTL_HOURS} h :\n${link}\n\n` +
            'If you did not ask for it, ignore this message. / Si vous n’êtes pas à l’origine de la demande, ignorez ce message.\n',
        );
      })().catch((error: unknown) => request.log.warn({ code: (error as { code?: string }).code ?? 'error' }, 'demande de réinitialisation non traitée'));
      return reply.code(202).send({ status: 'accepted' });
    },
  );

  // Consommation d'un lien de réinitialisation (e-mail, ou lien copiable d'un admin pour un compte à 2FA) : réponse
  // uniforme pour un lien inconnu, expiré ou consommé ; second facteur exigé si le compte en a un ; toutes les sessions,
  // clés, jetons de tunnel, cookies serveur et appareils reconnus du compte sont révoqués (13 § 5).
  app.post<{ Body: { token: string; password: string; code?: string } }>(
    '/api/auth/password-reset/confirm',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 1, maxLength: 128 }, password: { type: 'string', minLength: 1, maxLength: 1024 }, code: { type: 'string', maxLength: 32 } },
        },
      },
    },
    async (request, reply) => {
      if (resetByIp.blocked(request.ip)) return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
      // Hachage fait d'avance : même délai qu'un lien valide (aucun indice sur l'état du lien).
      const passwordHash = await hashPassword(request.body.password);
      const invalid = async () => {
        resetByIp.fail(request.ip);
        await audit(ctx, request, null, { action: 'auth.password_reset', outcome: 'denied', meta: { reason: 'invalid_link' } });
        return sendError(reply, 400, 'reset_link_invalid', 'lien invalide ou expiré');
      };
      if (!isOpaqueTokenFormat(request.body.token)) return invalid();
      const { rows } = await ctx.pool.query<{ user_id: string }>(
        `SELECT substr(v.identifier, 7) AS user_id FROM verifications v JOIN users u ON u.id::text = substr(v.identifier, 7)
         WHERE v.identifier LIKE 'reset:%' AND v.value = $1 AND v.expires_at > now() AND u.status = 'active' AND u.deleted_at IS NULL`,
        [hashOpaqueToken(request.body.token)],
      );
      const userId = rows[0]?.user_id;
      if (!userId) return invalid();
      const violation = passwordPolicyViolation(request.body.password);
      if (violation) return sendError(reply, 400, 'weak_password', `mot de passe refusé (${violation})`);
      // 6.4.3 : la réinitialisation ne remplace jamais le second facteur.
      if (await hasConfirmedTwoFactor(ctx.pool, userId)) {
        const method = request.body.code ? await verifySecondFactor(ctx, userId, request.body.code) : null;
        if (!method) {
          resetByIp.fail(request.ip);
          await audit(ctx, request, null, { action: 'auth.password_reset', targetType: 'user', targetId: userId, outcome: 'denied', meta: { reason: 'mfa_code_invalid' } });
          return sendError(reply, 400, 'mfa_code_required', 'code de double authentification requis ou invalide');
        }
      }
      const client = await ctx.pool.connect();
      let revoked: Awaited<ReturnType<typeof revokeUserAccess>>;
      try {
        await client.query('BEGIN');
        const consumed = await client.query("DELETE FROM verifications WHERE identifier = 'reset:' || $1::text AND value = $2", [userId, hashOpaqueToken(request.body.token)]);
        if (consumed.rowCount !== 1) {
          await client.query('ROLLBACK');
          return invalid();
        }
        await client.query(
          `INSERT INTO auth_accounts (user_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)
           ON CONFLICT (provider_id, account_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
          [userId, userId, passwordHash],
        );
        revoked = await revokeUserAccess(client, userId, null, { wipeCookies: true });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      const owner = await userFor(ctx, 'id', userId);
      await audit(ctx, request, owner, { action: 'auth.password_reset', targetType: 'user', targetId: userId, outcome: 'success', meta: { revoked } });
      return reply.code(204).send();
    },
  );
}
