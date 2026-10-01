// SPDX-License-Identifier: AGPL-3.0-only
// Outils communs des routes de comptes (tâche 3.7) : ré-authentification, second facteur, appareils reconnus (D-15),
// e-mails de compte (SMTP de l'instance, garde SSRF `operator-config`), curseurs de pagination, en-têtes transmis à la
// bibliothèque d'auth (IP résolue par Fastify seulement).
import {
  can,
  generateOpaqueToken,
  hashBackupCode,
  hashOpaqueToken,
  isOpaqueTokenFormat,
  kekFor,
  KNOWN_DEVICE_TTL_DAYS,
  matchTotp,
  mfaRequiredFor,
  PERMISSIONS,
  verifyPassword,
  type Kek,
  type Permission,
  type Role,
} from '@runtime/core';
import { sendMail } from '@runtime/core/net';
import { consumeBackupCode, consumeTotpStep, loadSmtpConfig, loadTwoFactor } from '@runtime/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MfaMethod } from '../auth/better-auth.js';
import type { ServerContext } from '../context.js';
import { AttemptLimiter } from '../rate-limit.js';
import { audit, sendError, webHeaders, type Actor } from './guard.js';

/** En-têtes par lesquels un client choisirait son IP : jamais transmis à la bibliothèque. */
const CLIENT_IP_HEADERS = /^(x-forwarded-.*|forwarded|x-real-ip|x-client-ip|true-client-ip|cf-connecting-ip|x-cluster-client-ip)$/i;

/** En-têtes Web de la requête, IP du client = `request.ip` (TRUST_PROXY), seule source pour la bibliothèque. */
export function libraryHeaders(request: FastifyRequest): Headers {
  const headers = webHeaders(request);
  for (const name of [...headers.keys()]) if (CLIENT_IP_HEADERS.test(name)) headers.delete(name);
  headers.set('x-forwarded-for', request.ip);
  headers.delete('content-length');
  return headers;
}

// ---------------------------------------------------------------------------------------------------------------
// Ré-authentification (13 § 5, ASVS 7.5.1)
// ---------------------------------------------------------------------------------------------------------------

/** 5 échecs par utilisateur sur 15 min, toutes opérations sensibles confondues → 429 et fermeture de la session utilisée. */
const REAUTH_MAX_FAILURES = 5;
const reauthLimiter = new AttemptLimiter({ max: REAUTH_MAX_FAILURES, windowMs: 15 * 60 * 1000 });
/** Compte sans mot de passe (OIDC seul) : la ré-authentification est une connexion de moins de 10 minutes. */
const FRESH_SESSION_MS = 10 * 60 * 1000;

/**
 * Vérifie le mot de passe actuel de l'acteur avant une opération sensible (clé d'API, code d'appairage, 2FA, liaison
 * OIDC, transfert de propriété) ; compte OIDC sans mot de passe local : connexion de moins de 10 minutes, sinon 403
 * `reauth_required` (le champ du mot de passe, facultatif dans les schémas, est alors ignoré). Compte à mot de passe
 * local sans mot de passe fourni : 400 `current_password_required`, sans compter d'échec (rien n'a été deviné).
 * Répond lui-même en cas d'échec (403, ou 429 et session fermée après 5 échecs) et renvoie false ; true si l'appelant
 * peut continuer.
 */
export async function reauthenticate(
  ctx: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
  actor: Actor,
  password: string | undefined,
  action: string,
): Promise<boolean> {
  if (reauthLimiter.blocked(actor.userId)) {
    await sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
    return false;
  }
  const { rows } = await ctx.pool.query<{ password_hash: string | null }>(
    "SELECT password_hash FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'",
    [actor.userId],
  );
  const stored = rows[0]?.password_hash;
  if (!stored) {
    // Compte OIDC sans mot de passe local : une connexion récente tient lieu de ré-authentification.
    const fresh = actor.sessionCreatedAt !== undefined && Date.now() - actor.sessionCreatedAt.getTime() < FRESH_SESSION_MS;
    if (fresh) return true;
    // Pas un échec de secret (rien à deviner) : ni compteur ni fermeture de session, mais le refus est audité.
    await audit(ctx, request, actor, { action, outcome: 'denied', meta: { reason: 'reauth_required' } });
    await sendError(reply, 403, 'reauth_required', 'reconnectez-vous pour confirmer cette opération');
    return false;
  }
  if (password === undefined || password === '') {
    await sendError(reply, 400, 'current_password_required', 'mot de passe actuel requis');
    return false;
  }
  if (await verifyPassword(stored, password)) {
    reauthLimiter.reset(actor.userId);
    return true;
  }
  const failures = reauthLimiter.fail(actor.userId);
  await audit(ctx, request, actor, { action, outcome: 'denied', meta: { reason: 'reauth_failed', failures } });
  if (failures >= REAUTH_MAX_FAILURES) {
    if (actor.sessionId) await ctx.pool.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [actor.sessionId, actor.userId]);
    await audit(ctx, request, actor, { action: 'auth.session_revoked', outcome: 'success', meta: { reason: 'reauth_failures' } });
    await sendError(reply, 429, 'too_many_attempts', 'trop de tentatives : session fermée');
    return false;
  }
  await sendError(reply, 403, 'reauth_failed', 'mot de passe actuel incorrect');
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Second facteur (13 § 7) : TOTP à usage unique (anti-rejeu en base), code de secours à usage unique
// ---------------------------------------------------------------------------------------------------------------

/**
 * KEK des graines TOTP : la courante et, si le trousseau a `MASTER_KEY_PREVIOUS`, celle de la version précédente
 * (graine pas encore re-chiffrée par `rekey`). Une graine sous une autre version n'est jamais marquée illisible pour ça.
 */
export function twoFactorKeks(ctx: Pick<ServerContext, 'secretsKek' | 'keyring'>): Kek[] {
  const current = ctx.secretsKek;
  return ctx.keyring.previous && current.version > 1 ? [current, kekFor(ctx.keyring.previous, current.version - 1, 'secrets')] : [current];
}

/**
 * Vérifie un code TOTP (6 chiffres, pas strictement plus récent que le dernier accepté) ou un code de secours (usage
 * unique). Seule une 2FA confirmée compte. Graine illisible (MASTER_KEY perdue) : codes de secours seulement.
 * Sans limite d'essais : les routes passent par `checkSecondFactor`.
 */
async function verifySecondFactor(ctx: ServerContext, userId: string, code: string): Promise<Exclude<MfaMethod, 'idp'> | null> {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const state = await loadTwoFactor(ctx.pool, twoFactorKeks(ctx), userId);
    if (state.status !== 'confirmed') return null;
    const step = matchTotp(state.secret, trimmed, { lastUsedStep: state.lastUsedStep });
    state.secret.fill(0);
    if (step === null) return null;
    return (await consumeTotpStep(ctx.pool, userId, step)) ? 'totp' : null;
  }
  const hash = hashBackupCode(userId, trimmed);
  if (hash === null) return null;
  const { rowCount } = await ctx.pool.query('SELECT 1 FROM two_factor WHERE user_id = $1 AND confirmed_at IS NOT NULL', [userId]);
  if (rowCount !== 1) return null;
  return (await consumeBackupCode(ctx.pool, userId, hash)) ? 'backup_code' : null;
}

/** Échecs du second facteur tolérés par compte sur 15 min, TOUTES routes et IP confondues (connexion, lien de
 * réinitialisation, retrait de la 2FA, codes de secours, liaison OIDC, transfert de propriété). */
const MFA_MAX_FAILURES = 5;
const mfaLimiter = new AttemptLimiter({ max: MFA_MAX_FAILURES, windowMs: 15 * 60 * 1000 });

export type SecondFactorCheck = { ok: true; method: Exclude<MfaMethod, 'idp'> } | { ok: false; failures: number; blocked: boolean };

/**
 * Second facteur sous limite par compte (13 § 5, 6.1.1 ; 6.4.3 pour la réinitialisation) : un compte bloqué n'essaie
 * plus aucun code jusqu'à la fin de la fenêtre ; `blocked` vaut true dès le 5e échec (l'appelant ferme ce qui doit l'être).
 */
export async function checkSecondFactor(ctx: ServerContext, userId: string, code: string): Promise<SecondFactorCheck> {
  if (mfaLimiter.blocked(userId)) return { ok: false, failures: MFA_MAX_FAILURES, blocked: true };
  const method = await verifySecondFactor(ctx, userId, code);
  if (method) {
    mfaLimiter.reset(userId);
    return { ok: true, method };
  }
  const failures = mfaLimiter.fail(userId);
  return { ok: false, failures, blocked: failures >= MFA_MAX_FAILURES };
}

/**
 * Second facteur d'une opération sensible de l'acteur (retrait de la 2FA, codes de secours, liaison OIDC, transfert) :
 * répond lui-même en cas d'échec (400 `invalid_code`, 429 au-delà de la limite, audit `denied`) et renvoie la méthode,
 * ou null si l'appelant doit s'arrêter.
 */
export async function requireSecondFactor(
  ctx: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
  actor: Actor,
  code: string | undefined,
  action: string,
): Promise<Exclude<MfaMethod, 'idp'> | null> {
  if (!code) {
    await sendError(reply, 400, 'mfa_code_required', 'code de double authentification requis');
    return null;
  }
  const check = await checkSecondFactor(ctx, actor.userId, code);
  if (check.ok) return check.method;
  await audit(ctx, request, actor, { action, targetType: 'user', targetId: actor.userId, outcome: 'denied', meta: { reason: 'invalid_code', failures: check.failures } });
  if (check.blocked) await sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
  else await sendError(reply, 400, 'invalid_code', 'code invalide ou déjà utilisé');
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Appareils reconnus (D-15) : cookie HttpOnly posé après une authentification complète, empreinte en base
// ---------------------------------------------------------------------------------------------------------------

function deviceCookieName(publicUrl: string): string {
  return publicUrl.startsWith('https://') ? '__Host-sy.device' : 'sy.device';
}

/** Enregistre l'appareil (empreinte seulement) et renvoie l'en-tête Set-Cookie. 20 appareils au plus par compte. */
export async function rememberDevice(ctx: ServerContext, userId: string): Promise<string> {
  const { token, hash } = generateOpaqueToken();
  await ctx.pool.query(
    `INSERT INTO auth_known_devices (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [userId, hash, KNOWN_DEVICE_TTL_DAYS],
  );
  await ctx.pool.query(
    `DELETE FROM auth_known_devices WHERE user_id = $1 AND (expires_at <= now() OR id NOT IN (
       SELECT id FROM auth_known_devices WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT 20))`,
    [userId],
  );
  const secure = ctx.publicUrl.startsWith('https://') ? '; Secure' : '';
  return `${deviceCookieName(ctx.publicUrl)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${KNOWN_DEVICE_TTL_DAYS * 86400}${secure}`;
}

/** Utilisateur dont l'appareil est reconnu par le cookie de la requête (null sinon). */
export async function knownDeviceUser(ctx: ServerContext, request: FastifyRequest): Promise<string | null> {
  const name = deviceCookieName(ctx.publicUrl);
  const raw = request.headers.cookie ?? '';
  const token = raw
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!token || !isOpaqueTokenFormat(token)) return null;
  const { rows } = await ctx.pool.query<{ user_id: string }>(
    'UPDATE auth_known_devices SET last_seen_at = now() WHERE token_hash = $1 AND expires_at > now() RETURNING user_id',
    [hashOpaqueToken(token)],
  );
  return rows[0]?.user_id ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// E-mails de compte (invitation, réinitialisation) : relais SMTP de l'instance, garde SSRF `operator-config`
// ---------------------------------------------------------------------------------------------------------------

export type MailOutcome = 'sent' | 'not_configured' | 'failed';

/** SMTP configuré par l'admin ? (sinon : liens copiables, 13 § 6). */
export async function smtpConfigured(ctx: ServerContext): Promise<boolean> {
  const { rowCount } = await ctx.pool.query("SELECT 1 FROM settings WHERE key = 'smtp'");
  return rowCount === 1;
}

export async function sendAccountMail(ctx: ServerContext, request: FastifyRequest, to: string, subject: string, text: string): Promise<MailOutcome> {
  if (!ctx.secrets) return 'not_configured';
  const config = await loadSmtpConfig(ctx.pool, ctx.secrets);
  if (!config) return 'not_configured';
  try {
    await sendMail({ ...config, ...(ctx.extraCa ? { ca: ctx.extraCa } : {}) }, { to: [to], subject, text }, { guard: ctx.guard });
    return 'sent';
  } catch (error) {
    // Ni adresse ni contenu dans le journal : la classe d'échec seulement.
    request.log.warn({ code: (error as { code?: string }).code ?? 'error' }, 'envoi d’un e-mail de compte impossible');
    return 'failed';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pagination par curseur opaque (created_at, id)
// ---------------------------------------------------------------------------------------------------------------

/** Curseur opaque : valeurs de tri de la dernière ligne servie (texte exact renvoyé par PostgreSQL). */
export function encodeCursor(...parts: string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

/** Curseur de `size` valeurs texte ; absent → undefined ; illisible → null (l'appelant répond 400). */
export function decodeCursor(cursor: string | undefined, size: number): string[] | null | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && value.length === size && value.every((v) => typeof v === 'string' && v.length <= 128)) return value as string[];
  } catch {
    // curseur illisible
  }
  return null;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------------------------------------------
// Identité renvoyée à la console (`Me`)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Permissions que `can()` accorde au rôle : la console pilote ses écrans et ses routes par cette liste (06 § 4.1, 13.2 de la
 * tâche 3.8) au lieu de recopier la matrice des rôles. Elle ne dit que si le rôle peut tenter l'action ; le serveur reste
 * seul juge (rôle relu en base à chaque requête, 13 § 2).
 */
function permissionsOf(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => can(role, permission));
}

/**
 * Corps de `GET /api/me` et de `POST /api/invitations/accept` : identité, préférences, droits, état de la 2FA. `mfaEnrollmentRequired`
 * est vrai quand MFA_ENFORCED concerne le rôle, que la 2FA n'est pas confirmée et qu'aucun `amr` de l'IdP n'en tient lieu : la console
 * montre alors l'enrôlement seul (13 § 7), le garde refusant déjà toute autre route.
 */
export async function meView(
  ctx: Pick<ServerContext, 'pool' | 'mfaEnforced'>,
  who: { userId: string; email: string; role: Role; via: 'ui' | 'apikey' | 'extension'; scopes: string[] | null; mfaMethod?: MfaMethod | null },
) {
  const { rows } = await ctx.pool.query<{ display_name: string; locale: string; theme: string; mfa_enabled: boolean }>(
    `SELECT u.display_name, u.locale, u.theme,
            EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL AND t.unreadable_since IS NULL) AS mfa_enabled
     FROM users u WHERE u.id = $1`,
    [who.userId],
  );
  const row = rows[0];
  const mfaEnabled = row?.mfa_enabled === true;
  return {
    id: who.userId,
    email: who.email,
    displayName: row?.display_name ?? '',
    role: who.role,
    locale: row?.locale ?? 'en',
    theme: row?.theme ?? 'system',
    via: who.via,
    scopes: who.scopes,
    permissions: permissionsOf(who.role),
    mfaEnabled,
    mfaEnrollmentRequired: who.via === 'ui' && mfaRequiredFor(ctx.mfaEnforced, who.role) && !mfaEnabled && who.mfaMethod !== 'idp',
  };
}
