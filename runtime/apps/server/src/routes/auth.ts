// SPDX-License-Identifier: AGPL-3.0-only
// Routes de la bibliothèque d'auth, en liste blanche (13 § 5) : connexion, déconnexion, lecture de session. Tout
// autre chemin /api/auth/* (inscription, réinitialisation, listes de sessions…) répond 404. Chaque connexion, échec de
// connexion et déconnexion est audité (13 § 9) ; le jeton de session ne sort que dans le cookie HttpOnly.
// Débit (13 § 5, ASVS 6.1.1) : limite par IP (bibliothèque, sur request.ip seulement) ET par compte (e-mail normalisé).
import { hashPassword, isRole, needsRehash } from '@runtime/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { AttemptLimiter } from '../rate-limit.js';
import { audit, sendError, webHeaders } from './guard.js';

/** Échecs de connexion tolérés par compte sur 15 minutes, toutes IP confondues. */
const ACCOUNT_MAX_FAILURES = 10;
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

/** Réponse unique à tout échec de connexion (compte inconnu, désactivé, mauvais mot de passe…), 13 § 5 (6.3.8). */
const INVALID_CREDENTIALS = { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' };

/** En-têtes par lesquels un client choisirait son IP : jamais transmis à la bibliothèque. */
const CLIENT_IP_HEADERS = /^(x-forwarded-.*|forwarded|x-real-ip|x-client-ip|true-client-ip|cf-connecting-ip|x-cluster-client-ip)$/i;

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
  const headers = webHeaders(request);
  for (const name of [...headers.keys()]) if (CLIENT_IP_HEADERS.test(name)) headers.delete(name);
  // IP résolue par Fastify (TRUST_PROXY) : seule source pour la limite par IP et `auth_sessions.ip`.
  headers.set('x-forwarded-for', request.ip);
  headers.delete('content-length');
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

export function authRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const accounts = new AttemptLimiter({ max: ACCOUNT_MAX_FAILURES, windowMs: ACCOUNT_WINDOW_MS });

  app.post<{ Body: { email: string; password: string } }>('/api/auth/sign-in/email', { schema: { body: signInSchema } }, async (request, reply) => {
    const email = request.body.email.trim().toLowerCase();
    if (accounts.blocked(email)) {
      await audit(ctx, request, await userFor(ctx, 'email', email), { action: 'auth.login_failed', outcome: 'denied', meta: { reason: 'account_rate_limited' } });
      return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
    }
    const result = await forward(ctx, request);
    const user = (result.json as { user?: { id?: string } } | null)?.user;
    if (result.status === 200 && user?.id) {
      accounts.reset(email);
      await rehashIfNeeded(ctx, user.id, request.body.password);
      await audit(ctx, request, await userFor(ctx, 'id', user.id), { action: 'auth.login', targetType: 'user', targetId: user.id, outcome: 'success' });
      return relay(reply, { ...result, json: withoutTokens(result.json) });
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
}
