// SPDX-License-Identifier: AGPL-3.0-only
// Clés d'API de l'appelant (13 § 8, 13.1) : liste, création (ré-authentification, secret renvoyé une seule fois),
// révocation. Session d'interface seulement. Lecture et écriture sous `runtime_app` (RLS sur user_id) ET filtre
// explicite sur l'appelant ; l'objet d'autrui répond 404 comme un objet inexistant.
import {
  API_KEY_DEFAULT_LIFETIME_DAYS,
  API_KEY_MAX_LIFETIME_DAYS,
  generateApiKey,
  GRANTABLE_SCOPES,
  verifyPassword,
  type ApiKeyScope,
} from '@runtime/core';
import { withActor } from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { AttemptLimiter } from '../rate-limit.js';
import { audit, notFound, sendError } from './guard.js';

/** Ré-authentification : 5 échecs par utilisateur sur 15 min → 429 et fermeture de la session utilisée. */
const REAUTH_MAX_FAILURES = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = {
  type: 'object',
  required: ['label', 'scopes', 'currentPassword'],
  additionalProperties: false,
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 100 },
    scopes: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...GRANTABLE_SCOPES] } },
    expiresInDays: { type: 'integer', minimum: 1, maximum: API_KEY_MAX_LIFETIME_DAYS },
    currentPassword: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;

type CreateBody = { label: string; scopes: ApiKeyScope[]; expiresInDays?: number; currentPassword: string };

type KeyRow = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  expires_at: Date;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
};

const view = (r: KeyRow) => ({
  id: r.id,
  label: r.label,
  prefix: r.prefix,
  scopes: r.scopes,
  expiresAt: r.expires_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

export function apiKeyRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const reauth = new AttemptLimiter({ max: REAUTH_MAX_FAILURES, windowMs: 15 * 60 * 1000 });

  app.get('/api/api-keys', async (request) => {
    const actor = request.actor!;
    const rows = await withActor(ctx.pool, actor, async (db) =>
      (await db.query<KeyRow>(
        `SELECT id, label, prefix, scopes, expires_at, last_used_at, created_at, revoked_at
         FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
        [actor.userId],
      )).rows,
    );
    return { items: rows.map(view) };
  });

  app.post<{ Body: CreateBody }>('/api/api-keys', { schema: { body: createSchema } }, async (request, reply) => {
    const actor = request.actor!;
    if (reauth.blocked(actor.userId)) return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
    // Opération sensible : ré-authentification par le mot de passe (13 § 5, ASVS 7.5.1).
    const { rows } = await ctx.pool.query<{ password_hash: string | null }>(
      "SELECT password_hash FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'",
      [actor.userId],
    );
    const stored = rows[0]?.password_hash;
    if (!stored || !(await verifyPassword(stored, request.body.currentPassword))) {
      const failures = reauth.fail(actor.userId);
      await audit(ctx, request, actor, { action: 'apikey.create', outcome: 'denied', meta: { reason: 'reauth_failed', failures } });
      if (failures >= REAUTH_MAX_FAILURES) {
        // Session peut-être volée : elle est fermée (l’utilisateur légitime se reconnecte).
        if (actor.sessionId) await ctx.pool.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [actor.sessionId, actor.userId]);
        await audit(ctx, request, actor, { action: 'auth.session_revoked', outcome: 'success', meta: { reason: 'reauth_failures' } });
        return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives : session fermée');
      }
      return sendError(reply, 403, 'reauth_failed', 'mot de passe actuel incorrect');
    }
    reauth.reset(actor.userId);
    const days = request.body.expiresInDays ?? API_KEY_DEFAULT_LIFETIME_DAYS;
    const { key, prefix, hash } = generateApiKey();
    const row = await withActor(ctx.pool, actor, async (db) =>
      (await db.query<KeyRow>(
        `INSERT INTO api_keys (user_id, label, prefix, key_hash, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
         RETURNING id, label, prefix, scopes, expires_at, last_used_at, created_at, revoked_at`,
        [actor.userId, request.body.label, prefix, hash, request.body.scopes, days],
      )).rows[0]!,
    );
    await audit(ctx, request, actor, {
      action: 'apikey.created',
      targetType: 'api_key',
      targetId: row.id,
      outcome: 'success',
      meta: { prefix, scopes: request.body.scopes, expiresAt: row.expires_at.toISOString() },
    });
    // Seule apparition du secret : jamais relu ensuite (13 § 8).
    return reply.code(201).send({ ...view(row), key });
  });

  app.delete<{ Params: { id: string } }>('/api/api-keys/:id', async (request, reply) => {
    const actor = request.actor!;
    const id = request.params.id;
    if (!UUID.test(id)) return notFound(reply);
    const outcome = await withActor(ctx.pool, actor, async (db) => {
      const updated = await db.query(
        `UPDATE api_keys SET revoked_at = now(), revoked_by = $2
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
        [id, actor.userId],
      );
      if (updated.rowCount === 1) return 'revoked';
      const own = await db.query('SELECT 1 FROM api_keys WHERE id = $1 AND user_id = $2', [id, actor.userId]);
      return own.rowCount === 1 ? 'already_revoked' : 'not_found';
    });
    if (outcome === 'not_found') {
      // Même réponse qu'un objet inexistant ; l'accès à l'objet d'autrui est audité (13 § 9, `denied`).
      const { rowCount } = await ctx.pool.query('SELECT 1 FROM api_keys WHERE id = $1', [id]);
      if (rowCount === 1) await audit(ctx, request, actor, { action: 'access.denied', targetType: 'api_key', targetId: id, outcome: 'denied' });
      return notFound(reply);
    }
    if (outcome === 'revoked') {
      await audit(ctx, request, actor, { action: 'apikey.revoked', targetType: 'api_key', targetId: id, outcome: 'success' });
    }
    return reply.code(204).send();
  });
}
