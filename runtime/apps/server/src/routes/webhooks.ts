// SPDX-License-Identifier: AGPL-3.0-only
// Abonnements webhook de l'utilisateur (tâche 3.1, 05 § 4.2, 08 § 5, Standard Webhooks) : services de 2.5 (garde SSRF
// sur l'URL, secret `whsec_` chiffré et rendu une seule fois, rotation avec grâce, réactivation, test signé). Un
// abonnement couvre toutes les API de son propriétaire (`api_slug: null`) ou une seule (`api_slug`, API visible de l'appelant).
import { WEBHOOK_EVENTS } from '@runtime/core';
import { assertWebhookUrlAllowed, findSsrfBlocked } from '@runtime/core/net';
import {
  createWebhookSubscription,
  enableWebhookSubscription,
  listDeliveries,
  rotateWebhookSecret,
  testWebhookSubscription,
  WebhookConfigError,
  withActor,
} from '@runtime/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.js';
import { readApiBySlug } from '../rest/apis.js';
import { reasonMessage } from '../rest/shared.js';
import { iso, UUID } from './account-helpers.js';
import { audit, notFound, sendError, type Actor } from './guard.js';

const events = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...WEBHOOK_EVENTS] } } as const;

type SubRow = { id: string; url: string; events: string[]; status: 'active' | 'disabled'; tested_at: Date | null; created_at: Date; api_slug: string | null };

const view = (r: SubRow) => ({ id: r.id, url: r.url, events: r.events, api_slug: r.api_slug, status: r.status, tested_at: iso(r.tested_at), created_at: r.created_at.toISOString() });

/** Colonnes servies ; l'API d'un abonnement limité est lue sous RLS (invisible : slug null). */
const COLUMNS = 's.id, s.url, s.events, s.status, s.tested_at, s.created_at, a.slug AS api_slug';
const FROM = 'webhook_subscriptions s LEFT JOIN apis a ON a.id = s.api_id';

export function webhookRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const store = (reply: FastifyReply) => {
    if (ctx.secrets === null) {
      void sendError(reply, 503, 'not_ready', 'instance en cours de démarrage');
      return null;
    }
    return ctx.secrets;
  };
  /** Refus de configuration : URL bloquée par la garde (`ssrf_blocked`, sans détail) ou valeur invalide. */
  const configError = (reply: FastifyReply, error: unknown) => {
    if (findSsrfBlocked(error)) return sendError(reply, 400, 'ssrf_blocked', 'URL refusée : adresse privée ou réservée, ou port non autorisé');
    if (error instanceof WebhookConfigError) return sendError(reply, 400, 'invalid_webhook', error.message);
    // URL illisible (new URL) : la valeur saisie, qui peut porter un jeton, n'est ni renvoyée ni journalisée.
    if (error instanceof TypeError && (error as { code?: unknown }).code === 'ERR_INVALID_URL') return sendError(reply, 400, 'invalid_webhook', 'url : URL http(s) absolue attendue');
    throw error;
  };

  app.get('/api/webhook-subscriptions', async (request) => {
    const actor = request.actor!;
    const rows = await withActor(ctx.pool, actor, async (db) => (await db.query<SubRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE s.owner_id = $1 ORDER BY s.created_at DESC`, [actor.userId])).rows);
    return { subscriptions: rows.map(view) };
  });

  app.post<{ Body: { url: string; events: string[]; api_slug?: string | null } }>(
    '/api/webhook-subscriptions',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['url', 'events'], properties: { url: { type: 'string', minLength: 1, maxLength: 2048 }, events, api_slug: { type: ['string', 'null'], maxLength: 63 } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      const secrets = store(reply);
      if (secrets === null) return reply;
      // Abonnement limité à une API : elle doit être visible de l'appelant (siennes ou `instance`), sinon 400.
      let apiId: string | null = null;
      if (request.body.api_slug) {
        const api = await withActor(ctx.pool, actor, (db) => readApiBySlug(db, request.body.api_slug!));
        if (api === null) return sendError(reply, 400, 'unknown_api', 'api_slug : API inconnue');
        apiId = api.id;
      }
      let created: { id: string; secret: string };
      try {
        created = await withActor(ctx.pool, actor, (db) => createWebhookSubscription(db, secrets, ctx.guard, { ownerId: actor.userId, url: request.body.url, events: request.body.events, apiId }));
      } catch (error) {
        return configError(reply, error);
      }
      await audit(ctx, request, actor, { action: 'webhook.created', targetType: 'webhook_subscription', targetId: created.id, outcome: 'success', meta: { events: request.body.events } });
      const row = await withActor(ctx.pool, actor, async (db) => (await db.query<SubRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE s.id = $1`, [created.id])).rows[0]!);
      // Seule apparition du secret (08 § 5).
      return reply.code(201).send({ ...view(row), secret: created.secret });
    },
  );

  const readOwn = async (actor: Actor, id: string) =>
    UUID.test(id) ? withActor(ctx.pool, actor, async (db) => (await db.query<SubRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE s.id = $1 AND s.owner_id = $2`, [id, actor.userId])).rows[0] ?? null) : null;

  app.get<{ Params: { id: string } }>('/api/webhook-subscriptions/:id', async (request, reply) => {
    const actor = request.actor!;
    const row = await readOwn(actor, request.params.id);
    if (row === null) return notFound(reply);
    const deliveries = await withActor(ctx.pool, actor, (db) => listDeliveries(db, { subscriptionId: row.id, ownerId: actor.userId }));
    return {
      ...view(row),
      deliveries: deliveries.map((d) => ({
        id: `${d.dispatch_id}:${d.attempt}`,
        at: d.created_at.toISOString(),
        event: d.event,
        attempt: d.attempt,
        status_code: d.http_status,
        duration_ms: d.duration_ms,
        excerpt: d.response_excerpt,
      })),
    };
  });

  app.patch<{ Params: { id: string }; Body: { url?: string; events?: string[]; status?: 'active' | 'disabled'; rotate_secret?: boolean } }>(
    '/api/webhook-subscriptions/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { url: { type: 'string', minLength: 1, maxLength: 2048 }, events, status: { type: 'string', enum: ['active', 'disabled'] }, rotate_secret: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const actor = request.actor!;
      const row = await readOwn(actor, request.params.id);
      if (row === null) return notFound(reply);
      const secrets = store(reply);
      if (secrets === null) return reply;
      const body = request.body;
      let secret: string | undefined;
      try {
        const url = body.url === undefined ? undefined : (await assertWebhookUrlAllowed(body.url, ctx.guard)).toString();
        secret = await withActor(ctx.pool, actor, async (db) => {
          if (url !== undefined) await db.query('UPDATE webhook_subscriptions SET url = $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [row.id, actor.userId, url]);
          if (body.events !== undefined) await db.query('UPDATE webhook_subscriptions SET events = $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [row.id, actor.userId, body.events]);
          if (body.status === 'active') await enableWebhookSubscription(db, { subscriptionId: row.id, ownerId: actor.userId });
          if (body.status === 'disabled') {
            await db.query("UPDATE webhook_subscriptions SET status = 'disabled', disabled_at = now(), updated_at = now() WHERE id = $1 AND owner_id = $2", [row.id, actor.userId]);
          }
          // Secret lié à sa destination (comme les secrets des réglages admin, INV8) : une URL changée fait tourner le secret,
          // SANS période de grâce (l'ancien ne signe jamais rien vers la nouvelle URL) ; le nouveau est rendu une fois.
          const moved = url !== undefined && url !== row.url;
          if (moved) return (await rotateWebhookSecret(db, secrets, { subscriptionId: row.id, ownerId: actor.userId, graceHours: 0 })).secret;
          return body.rotate_secret === true ? (await rotateWebhookSecret(db, secrets, { subscriptionId: row.id, ownerId: actor.userId })).secret : undefined;
        });
      } catch (error) {
        return configError(reply, error);
      }
      await audit(ctx, request, actor, { action: 'webhook.updated', targetType: 'webhook_subscription', targetId: row.id, outcome: 'success', meta: { fields: Object.keys(body) } });
      const updated = (await readOwn(actor, row.id))!;
      return { ...view(updated), ...(secret === undefined ? {} : { secret }) };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/webhook-subscriptions/:id', async (request, reply) => {
    const actor = request.actor!;
    const row = await readOwn(actor, request.params.id);
    if (row === null) return notFound(reply);
    await withActor(ctx.pool, actor, async (db) => {
      const secretIds = await db.query<{ secret_id: string | null; previous_secret_id: string | null }>('SELECT secret_id, previous_secret_id FROM webhook_subscriptions WHERE id = $1 AND owner_id = $2', [row.id, actor.userId]);
      await db.query('DELETE FROM webhook_subscriptions WHERE id = $1 AND owner_id = $2', [row.id, actor.userId]);
      // Matériel de clé inutile supprimé avec la cible (aucun secret orphelin).
      const ids = secretIds.rows.flatMap((r) => [r.secret_id, r.previous_secret_id]).filter((v): v is string => v !== null);
      if (ids.length > 0) await db.query('DELETE FROM secrets WHERE id = ANY($1::uuid[]) AND owner_id = $2', [ids, actor.userId]);
    });
    await audit(ctx, request, actor, { action: 'webhook.deleted', targetType: 'webhook_subscription', targetId: row.id, outcome: 'success' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/webhook-subscriptions/:id/test', async (request, reply) => {
    const actor = request.actor!;
    const row = await readOwn(actor, request.params.id);
    if (row === null) return notFound(reply);
    const secrets = store(reply);
    if (secrets === null) return reply;
    const result = await testWebhookSubscription({ pool: ctx.pool, queue: await ctx.jobs(), store: secrets, guard: ctx.guard }, { subscriptionId: row.id, ownerId: actor.userId });
    const ok = result.errorCode === null && result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300;
    await audit(ctx, request, actor, { action: 'webhook.tested', targetType: 'webhook_subscription', targetId: row.id, outcome: ok ? 'success' : 'error' });
    return { ok, tested_at: new Date().toISOString(), error: ok ? null : reasonMessage(result.errorCode ?? 'webhook_failed') };
  });
}
