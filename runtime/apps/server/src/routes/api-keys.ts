// SPDX-License-Identifier: AGPL-3.0-only
// Clés d'API de l'appelant (13 § 8, 13.1) : liste, création (ré-authentification, secret renvoyé une seule fois),
// révocation. Session d'interface seulement. Lecture et écriture sous `runtime_app` (RLS sur user_id) ET filtre
// explicite sur l'appelant ; l'objet d'autrui répond 404 comme un objet inexistant.
import {
  API_KEY_DEFAULT_LIFETIME_DAYS,
  API_KEY_MAX_LIFETIME_DAYS,
  generateApiKey,
  GRANTABLE_SCOPES,
  type ApiKeyScope,
} from '@runtime/core';
import { withActor } from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import { readSecuritySettings } from '../auth/security-settings.js';
import type { ServerContext } from '../context.js';
import { reauthenticate } from './account-helpers.js';
import { audit, notFound, sendError } from './guard.js';

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
    // Opération sensible (13 § 5, ASVS 7.5.1) : mot de passe actuel, ou connexion de moins de 10 min pour un compte
    // OIDC sans mot de passe local ; 5 échecs → 429 et session fermée.
    if (!(await reauthenticate(ctx, request, reply, actor, request.body.currentPassword, 'apikey.create'))) return reply;
    // Plafond réglé par l'owner (13 § 8, `api_key_max_lifetime_days`) : jamais au-delà, la durée par défaut s'y plie.
    const cap = (await readSecuritySettings(ctx.pool)).api_key_max_lifetime_days;
    if (request.body.expiresInDays !== undefined && request.body.expiresInDays > cap) {
      return sendError(reply, 400, 'lifetime_too_long', `durée maximale : ${cap} jours`);
    }
    const days = Math.min(request.body.expiresInDays ?? API_KEY_DEFAULT_LIFETIME_DAYS, cap);
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
