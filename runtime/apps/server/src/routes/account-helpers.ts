// SPDX-License-Identifier: AGPL-3.0-only
// Outils communs des routes de comptes (tâche 3.7) : ré-authentification, second facteur, appareils reconnus (D-15),
// e-mails de compte (SMTP de l'instance, garde SSRF `operator-config`), curseurs de pagination, en-têtes transmis à la
// bibliothèque d'auth (IP résolue par Fastify seulement).
import {
  generateOpaqueToken,
  hashBackupCode,
  hashOpaqueToken,
  isOpaqueTokenFormat,
  KNOWN_DEVICE_TTL_DAYS,
  matchTotp,
  verifyPassword,
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

/** 5 échecs par utilisateur sur 15 min → 429 et fermeture de la session utilisée (comme la création de clé, 0.3b). */
const REAUTH_MAX_FAILURES = 5;
const reauthLimiter = new AttemptLimiter({ max: REAUTH_MAX_FAILURES, windowMs: 15 * 60 * 1000 });
/** Compte sans mot de passe (OIDC seul) : la ré-authentification est une connexion de moins de 10 minutes. */
const FRESH_SESSION_MS = 10 * 60 * 1000;

/**
 * Vérifie le mot de passe actuel de l'acteur avant une opération sensible. Répond lui-même en cas d'échec (403, ou
 * 429 et session fermée après 5 échecs) et renvoie false ; true si l'appelant peut continuer.
 */
export async function reauthenticate(ctx: ServerContext, request: FastifyRequest, reply: FastifyReply, actor: Actor, password: string, action: string): Promise<boolean> {
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
    await sendError(reply, 403, 'reauth_required', 'reconnectez-vous pour confirmer cette opération');
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
 * Vérifie un code TOTP (6 chiffres, pas strictement plus récent que le dernier accepté) ou un code de secours (usage
 * unique). Seule une 2FA confirmée compte. Graine illisible (MASTER_KEY perdue) : codes de secours seulement.
 */
export async function verifySecondFactor(ctx: ServerContext, userId: string, code: string): Promise<Exclude<MfaMethod, 'idp'> | null> {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const state = await loadTwoFactor(ctx.pool, ctx.secretsKek, userId);
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
