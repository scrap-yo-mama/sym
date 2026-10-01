// SPDX-License-Identifier: AGPL-3.0-only
// Garde unique de toutes les routes (13 § 2-5, 13.1) : 503 avant l'owner, identité (clé d'API ou session), rôle et
// statut relus en base à chaque requête (ASVS 8.3.2), scope de clé, permission de rôle, contrôle d'Origin sur les
// mutations d'interface. Aucune route ne choisit l'identité : elle vient d'ici seulement (pas d'impersonation, INV5).
import { can, hashApiKey, isApiKeyFormat, isExtensionTokenFormat, isRole, type ApiKeyScope, type Role } from '@runtime/core';
import { appendAudit, resolveExtensionToken, withActor } from '@runtime/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { findRoute, type RouteSpec } from './registry.js';

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
};

async function resolveApiKey(ctx: ServerContext, request: FastifyRequest, key: string): Promise<Resolution> {
  if (!isApiKeyFormat(key)) return { status: 401 };
  // Authentification = étape système (avant de connaître l'utilisateur) : lecture par l'empreinte, hors runtime_app.
  const { rows } = await ctx.pool.query<KeyRow>(
    `SELECT k.id, k.user_id, k.prefix, k.scopes, k.expires_at <= now() AS expired, k.revoked_at IS NOT NULL AS revoked,
            k.last_used_at IS NULL AS first_use, u.role, u.status, u.email
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
  const absolute = (response.session as { absoluteExpiresAt?: Date | string | null }).absoluteExpiresAt;
  if (!absolute || new Date(absolute).getTime() <= Date.now()) {
    await ctx.pool.query('DELETE FROM auth_sessions WHERE id = $1', [response.session.id]);
    return { status: 401 };
  }
  const { rows } = await ctx.pool.query<{ role: string; status: string; email: string }>(
    'SELECT role, status, email FROM users WHERE id = $1',
    [response.user.id],
  );
  const user = rows[0];
  if (!user || user.status !== 'active' || !isRole(user.role)) return { status: 401 };
  return { actor: { userId: response.user.id, role: user.role, email: user.email, via: 'ui', scopes: null, sessionId: response.session.id } };
}

export async function audit(
  ctx: ServerContext,
  request: FastifyRequest,
  actor: Pick<Actor, 'userId' | 'role' | 'via' | 'apiKey'> | null,
  event: { action: string; targetType?: string; targetId?: string; outcome: 'success' | 'denied' | 'error'; meta?: Record<string, unknown> },
): Promise<void> {
  const { ip, userAgent } = requestMeta(request);
  await withActor(ctx.pool, actor ? { userId: actor.userId, role: actor.role } : null, (client) =>
    appendAudit(client, {
      actorUserId: actor?.userId ?? null,
      actorVia: actor?.via ?? 'ui',
      actorRef: actor?.apiKey?.prefix ?? null,
      ip,
      userAgent,
      ...event,
    }),
  );
}

/** Crochet `onRequest` global (enregistré par app.ts) : avant la lecture du corps. */
export function guard(ctx: ServerContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const spec = request.routeOptions.url ? findRoute(request.method, request.routeOptions.url) : undefined;
    request.routeSpec = spec ?? null;
    request.actor = null;
    if (!spec) return; // chemin inconnu : gestionnaire 404 uniforme

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
      reply.header('www-authenticate', 'Bearer');
      await sendError(reply, 401, 'unauthorized', 'identifiant absent, expiré ou révoqué');
      return;
    }
    const actor = resolution.actor;
    request.actor = actor;

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
