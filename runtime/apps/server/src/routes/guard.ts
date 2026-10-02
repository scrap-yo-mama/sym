// SPDX-License-Identifier: AGPL-3.0-only
// Garde unique de toutes les routes (13 § 2-5, 13.1) : 503 avant l'owner, identité (clé d'API ou session), rôle et
// statut relus en base à chaque requête (ASVS 8.3.2), scope de clé, permission de rôle, contrôle d'Origin sur les
// mutations d'interface. Aucune route ne choisit l'identité : elle vient d'ici seulement (pas d'impersonation, INV5).
import { can, hashApiKey, isApiKeyFormat, isExtensionTokenFormat, isRole, mfaRequiredFor, type ApiKeyScope, type Role } from '@runtime/core';
import { appendAudit, resolveExtensionToken, withActor, type AuditEvent } from '@runtime/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MfaMethod } from '../auth/better-auth.js';
import { readSecuritySettings } from '../auth/security-settings.js';
import type { ServerContext } from '../context.js';
import { findRoute, type RouteSpec } from './registry.js';

/** Une session en attente du second facteur expire après 10 minutes (mot de passe à ressaisir). */
const MFA_PENDING_TTL_MS = 10 * 60 * 1000;

export type Actor = {
  userId: string;
  role: Role;
  email: string;
  via: 'ui' | 'apikey' | 'extension';
  /** Scopes de la clé (null pour une session d'interface). */
  scopes: ApiKeyScope[] | null;
  apiKey?: { id: string; prefix: string };
  /** Session d’interface utilisée (pour la révoquer, ex. ré-authentification échouée en boucle). */
  sessionId?: string;
  /** Appareil appairé (jeton d'extension, 07 § 1) : l'identité vient du jeton, jamais du corps de la requête. */
  tunnelId?: string;
  /** Session d'interface : mot de passe vérifié, second facteur attendu (13 § 7). */
  mfaPending?: boolean;
  /** Facteur qui a complété la session (TOTP, code de secours, amr de l'IdP). */
  mfaMethod?: MfaMethod | null;
  /** 2FA confirmée et lisible (compte en règle avec MFA_ENFORCED). */
  mfaEnrolled?: boolean;
  /** Création de la session (ré-authentification récente des comptes sans mot de passe). */
  sessionCreatedAt?: Date;
  /** `users.locale` (21 § 3) : langue des messages REST quand `Accept-Language` ne dit rien. Absent pour un appareil d'extension. */
  locale?: string;
  /** `users.timezone` : fuseau des heures écrites dans les messages ; absent = UTC étiqueté. */
  timezone?: string | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    routeSpec: RouteSpec | null;
  }
}

export function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

/** 404 uniforme : objet inexistant, objet d'autrui ou chemin inconnu (aucun indice d'existence, 13 § 3). */
export function notFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, 'not_found', 'ressource introuvable');
}

function requestMeta(request: FastifyRequest): { ip: string; userAgent: string | null } {
  const ua = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof ua === 'string' ? ua : null };
}

/** En-têtes Node → Headers Web (pour Better Auth). */
export function webHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

type Resolution = { actor: Actor } | { status: 401 };

type KeyRow = {
  id: string;
  user_id: string;
  prefix: string;
  scopes: string[];
  expired: boolean;
  revoked: boolean;
  first_use: boolean;
  role: string;
  status: string;
  email: string;
  locale: string;
  timezone: string | null;
};

async function resolveApiKey(ctx: ServerContext, request: FastifyRequest, key: string): Promise<Resolution> {
  if (!isApiKeyFormat(key)) return { status: 401 };
  // Authentification = étape système (avant de connaître l'utilisateur) : lecture par l'empreinte, hors runtime_app.
  const { rows } = await ctx.pool.query<KeyRow>(
    `SELECT k.id, k.user_id, k.prefix, k.scopes, k.expires_at <= now() AS expired, k.revoked_at IS NOT NULL AS revoked,
            k.last_used_at IS NULL AS first_use, u.role, u.status, u.email, u.locale, u.timezone
     FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1`,
    [hashApiKey(key)],
  );
  const row = rows[0];
  if (!row || row.expired || row.revoked || row.status !== 'active' || !isRole(row.role)) return { status: 401 };
  await ctx.pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]);
  const actor: Actor = {
    userId: row.user_id,
    role: row.role,
    email: row.email,
    via: 'apikey',
    scopes: row.scopes as ApiKeyScope[],
    apiKey: { id: row.id, prefix: row.prefix },
    locale: row.locale,
    timezone: row.timezone,
  };
  if (row.first_use) {
    await audit(ctx, request, actor, { action: 'apikey.first_use', targetType: 'api_key', targetId: row.id, outcome: 'success' });
  }
  return { actor };
}

/** Jeton d'extension (07 § 1) : lié à (utilisateur, appareil), révocable, 90 jours renouvelés à l'usage. */
async function resolveExtension(ctx: ServerContext, token: string): Promise<Resolution> {
  if (!isExtensionTokenFormat(token)) return { status: 401 };
  // Étape d'authentification (identité système), comme les clés d'API : lecture par l'empreinte du jeton.
  const identity = await resolveExtensionToken(ctx.pool, token);
  if (!identity) return { status: 401 };
  return { actor: { userId: identity.userId, role: identity.role, email: identity.email, via: 'extension', scopes: null, tunnelId: identity.tunnelId } };
}

async function resolveSession(ctx: ServerContext, request: FastifyRequest, reply: FastifyReply): Promise<Resolution> {
  const { headers, response } = await ctx.auth.api.getSession({ headers: webHeaders(request), returnHeaders: true });
  // Renouvellement glissant de la session : le cookie mis à jour est renvoyé au navigateur.
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
  if (!response) return { status: 401 };
  const session = response.session as typeof response.session & {
    absoluteExpiresAt?: Date | string | null;
    mfaPending?: boolean | null;
    mfaMethod?: string | null;
  };
  const absolute = session.absoluteExpiresAt;
  const createdAt = new Date(session.createdAt);
  const expired =
    !absolute ||
    new Date(absolute).getTime() <= Date.now() ||
    // Second facteur jamais fourni : la session en attente ne survit pas 10 minutes.
    (session.mfaPending === true && Date.now() - createdAt.getTime() > MFA_PENDING_TTL_MS);
  // Inactivité réglée par l'owner (13 § 5) : dernière activité tracée à la minute près.
  const { rows: seen } = await ctx.pool.query<{ idle: boolean }>(
    `WITH s AS (SELECT last_seen_at < now() - make_interval(mins => $2) AS idle FROM auth_sessions WHERE id = $1),
          touch AS (UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute' AND NOT (SELECT idle FROM s))
     SELECT idle FROM s`,
    [session.id, (await readSecuritySettings(ctx.pool)).session_idle_minutes],
  );
  if (expired || seen[0]?.idle !== false) {
    await ctx.pool.query('DELETE FROM auth_sessions WHERE id = $1', [session.id]);
    return { status: 401 };
  }
  const { rows } = await ctx.pool.query<{ role: string; status: string; email: string; locale: string; timezone: string | null; mfa_enrolled: boolean }>(
    `SELECT u.role, u.status, u.email, u.locale, u.timezone,
            EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL AND t.unreadable_since IS NULL) AS mfa_enrolled
     FROM users u WHERE u.id = $1`,
    [response.user.id],
  );
  const user = rows[0];
  if (!user || user.status !== 'active' || !isRole(user.role)) return { status: 401 };
  const method = session.mfaMethod;
  return {
    actor: {
      userId: response.user.id,
      role: user.role,
      email: user.email,
      via: 'ui',
      scopes: null,
      sessionId: session.id,
      mfaPending: session.mfaPending === true,
      mfaMethod: method === 'totp' || method === 'backup_code' || method === 'idp' ? method : null,
      mfaEnrolled: user.mfa_enrolled,
      sessionCreatedAt: createdAt,
      locale: user.locale,
      timezone: user.timezone,
    },
  };
}

/**
 * 2FA (13 § 7) pour une session d'interface : second facteur attendu → seules les routes `mfa: 'pending'` ; compte
 * que MFA_ENFORCED concerne sans 2FA (et sans amr d'IdP) → enrôlement forcé, seules les routes `mfa: 'enroll'`.
 * Renvoie le code d'erreur à opposer, ou null.
 */
function mfaBarrier(ctx: Pick<ServerContext, 'mfaEnforced'>, actor: Actor, spec: Pick<RouteSpec, 'mfa'>): 'mfa_required' | 'mfa_enrollment_required' | null {
  if (actor.via !== 'ui') return null;
  if (actor.mfaPending) return spec.mfa === 'pending' ? null : 'mfa_required';
  if (spec.mfa === 'pending') return 'mfa_required';
  if (spec.mfa === 'enroll') return null;
  if (mfaRequiredFor(ctx.mfaEnforced, actor.role) && !actor.mfaEnrolled && actor.mfaMethod !== 'idp') return 'mfa_enrollment_required';
  return null;
}

type AuditActor = (Pick<Actor, 'userId' | 'role' | 'apiKey'> & { via: Actor['via'] | 'sso' }) | null;
type RouteAuditEvent = { action: string; targetType?: string; targetId?: string; outcome: 'success' | 'denied' | 'error'; meta?: Record<string, unknown> };

/** Entrée d'audit d'une requête (acteur, IP, User-Agent du client), pour une écriture qui l'ajoute dans sa propre transaction. */
export function auditEvent(request: FastifyRequest, actor: AuditActor, event: RouteAuditEvent): AuditEvent {
  const { ip, userAgent } = requestMeta(request);
  return { actorUserId: actor?.userId ?? null, actorVia: actor?.via ?? 'ui', actorRef: actor?.apiKey?.prefix ?? null, ip, userAgent, ...event };
}

export async function audit(ctx: ServerContext, request: FastifyRequest, actor: AuditActor, event: RouteAuditEvent): Promise<void> {
  await withActor(ctx.pool, actor ? { userId: actor.userId, role: actor.role } : null, (client) => appendAudit(client, auditEvent(request, actor, event)));
}

/** Crochet `onRequest` global (enregistré par app.ts) : avant la lecture du corps. */
export function guard(ctx: ServerContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const spec = request.routeOptions.url ? findRoute(request.method, request.routeOptions.url) : undefined;
    request.routeSpec = spec ?? null;
    request.actor = null;
    if (!spec) return; // chemin inconnu : gestionnaire 404 uniforme

    // Démarrage en mode dégradé (schéma en retard, 14 § 5) : seules les sondes répondent.
    if (!spec.duringStartup && !(await ctx.startup.ready())) {
      await sendError(reply, 503, 'not_ready', 'instance en cours de démarrage : schéma de base pas encore à jour (runtime migrate)');
      return;
    }

    if (!spec.beforeInit && !(await ctx.isInitialized())) {
      await sendError(reply, 503, 'not_initialized', 'instance non initialisée : terminez l’assistant de premier démarrage');
      return;
    }
    if (spec.auth === 'public') return;

    const authorization = request.headers.authorization;
    let resolution: Resolution;
    if (spec.auth === 'extension') {
      // Routes de l'extension : jeton d'appareil seulement (ni session d'interface, ni clé d'API).
      const match = typeof authorization === 'string' ? /^Bearer (\S+)$/.exec(authorization) : null;
      resolution = match?.[1] ? await resolveExtension(ctx, match[1]) : { status: 401 };
    } else if (typeof authorization === 'string' && authorization.length > 0) {
      const match = /^Bearer (\S+)$/.exec(authorization);
      resolution = match?.[1] ? await resolveApiKey(ctx, request, match[1]) : { status: 401 };
    } else {
      resolution = await resolveSession(ctx, request, reply);
    }
    if ('status' in resolution) {
      // RFC 9728 (13 § 11) : la réponse 401 désigne les métadonnées de ressource protégée.
      reply.header('www-authenticate', `Bearer resource_metadata="${ctx.publicUrl}/.well-known/oauth-protected-resource"`);
      await sendError(reply, 401, 'unauthorized', 'identifiant absent, expiré ou révoqué');
      return;
    }
    const actor = resolution.actor;
    request.actor = actor;
    // Second facteur et enrôlement forcé (13 § 7) avant tout autre contrôle : une session à moitié authentifiée n'atteint rien d'autre.
    const barrier = mfaBarrier(ctx, actor, spec);
    if (barrier) {
      await sendError(reply, 403, barrier, barrier === 'mfa_required' ? 'second facteur attendu' : 'activez la double authentification pour continuer');
      return;
    }

    const denied = async (reason: string) => {
      await audit(ctx, request, actor, { action: 'access.denied', outcome: 'denied', meta: { route: `${spec.method} ${spec.url}`, reason } });
      await sendError(reply, 403, 'forbidden', 'action non autorisée');
    };
    if (actor.via === 'apikey') {
      if (spec.auth === 'session') return denied('session_required');
      if (spec.scope && !actor.scopes?.includes(spec.scope)) return denied('scope_missing');
    } else if (actor.via === 'ui' && request.method !== 'GET') {
      // Mutation d'interface : Origin identique à PUBLIC_URL (13 § 5).
      if (request.headers.origin !== ctx.publicUrl) return denied('origin_mismatch');
    }
    if (spec.permission && !can(actor.role, spec.permission)) return denied('role');
  };
}

/**
 * Identité d'une requête sur une route publique qui offre un complément réservé aux administrateurs
 * (`/api/ready?detail=1`) : même résolution que le garde (clé d'API ou session), sans audit ni contrôle d'Origin
 * (lecture seule). `null` : non authentifié.
 */
export async function identify(ctx: ServerContext, request: FastifyRequest, reply: FastifyReply): Promise<Actor | null> {
  const authorization = request.headers.authorization;
  let resolution: Resolution;
  if (typeof authorization === 'string' && authorization.length > 0) {
    const match = /^Bearer (\S+)$/.exec(authorization);
    resolution = match?.[1] ? await resolveApiKey(ctx, request, match[1]) : { status: 401 };
  } else {
    resolution = await resolveSession(ctx, request, reply);
  }
  if ('status' in resolution) return null;
  // Second facteur pas encore fourni, ou enrôlement exigé : pas d'identité pour un complément réservé.
  return mfaBarrier(ctx, resolution.actor, {}) ? null : resolution.actor;
}
