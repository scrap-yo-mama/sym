// SPDX-License-Identifier: AGPL-3.0-only
// Planifications d'une API (tâche 3.1, 05 § 4.2, 08 § 5) : `schedules` est la source de vérité, le miroir pg-boss est
// aligné après chaque écriture (mirrorSchedule). Validation par le service de 2.5 (cron à 5 champs, fréquence minimale
// 1 minute, fuseau IANA, règles fermées, `bloquee` jamais retirée de `skip_if_status_in`) ; prochaines exécutions
// calculées côté serveur. Une planification appartient à son créateur (RLS) ; l'API doit lui être visible.
import { API_STATUSES } from '@runtime/core';
import { mirrorSchedule, removeScheduleMirror, validateSchedule, withActor, type ScheduleRow } from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { readApiBySlug } from '../rest/apis.js';
import { UUID } from './account-helpers.js';
import { audit, notFound, sendError, type Actor } from './guard.js';

const rulesSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    only_if_tunnel_online: { type: 'boolean' },
    window: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['start', 'end'],
      properties: { start: { type: 'string', pattern: '^\\d{2}:\\d{2}$' }, end: { type: 'string', pattern: '^\\d{2}:\\d{2}$' }, days: { type: 'array', maxItems: 7, items: { type: 'integer', minimum: 0, maximum: 6 } } },
    },
    max_runs_per_day: { type: ['integer', 'null'], minimum: 1 },
    skip_if_status_in: { type: 'array', items: { type: 'string', enum: [...API_STATUSES] } },
    dedup_key: { type: ['string', 'null'], maxLength: 200 },
    diff: { type: ['string', 'null'], enum: ['new', 'changed', 'removed', 'all', null] },
    alert_on: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['new_items', 'status_change', 'error'] } },
  },
} as const;

const fields = {
  cron: { type: 'string', minLength: 1, maxLength: 100 },
  timezone: { type: 'string', minLength: 1, maxLength: 64 },
  input: { type: 'object' },
  overlap: { type: 'string', enum: ['skip', 'queue', 'allow'] },
  missed: { type: 'string', enum: ['once', 'skip'] },
  rules: rulesSchema,
  enabled: { type: 'boolean' },
} as const;

type ScheduleBody = { cron?: string; timezone?: string; input?: Record<string, unknown>; overlap?: 'skip' | 'queue' | 'allow'; missed?: 'once' | 'skip'; rules?: Record<string, unknown>; enabled?: boolean };

type Row = ScheduleRow & { created_at: Date };

const SELECT = `SELECT s.id, s.api_id, s.owner_id, s.cron, s.timezone, s.input, s.rules, s.overlap, s.on_missed, s.enabled, s.created_at FROM schedules s`;

export function scheduleRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /** Vue `Schedule` : prochaines exécutions calculées ici (06 § 1 : aucun composant cron dans la console). */
  const view = async (row: Row, slug: string) => {
    const queue = await ctx.jobs();
    let next: string[];
    try {
      next = row.enabled ? queue.previewSchedule(row.cron, { timezone: row.timezone, count: 5 }).map((d) => d.toISOString()) : [];
    } catch {
      next = [];
    }
    const rules = (row.rules ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      api_slug: slug,
      cron: row.cron,
      timezone: row.timezone,
      input: (row.input ?? {}) as Record<string, unknown>,
      overlap: row.overlap,
      missed: row.on_missed,
      // `alert_on` absent (null) : la règle par défaut s'applique ; il n'est pas servi.
      rules: Object.fromEntries(Object.entries(rules).filter(([k, v]) => !(k === 'alert_on' && v === null))),
      enabled: row.enabled,
      paused_reason: null,
      next_runs: next,
      created_at: row.created_at.toISOString(),
    };
  };

  app.get<{ Params: { slug: string } }>('/api/apis/:slug/schedules', async (request, reply) => {
    const actor = request.actor!;
    const out = await withActor(ctx.pool, actor, async (db) => {
      const api = await readApiBySlug(db, request.params.slug);
      if (api === null) return null;
      return { slug: api.slug, rows: (await db.query<Row>(`${SELECT} WHERE s.api_id = $1 AND s.owner_id = $2 ORDER BY s.created_at`, [api.id, actor.userId])).rows };
    });
    if (out === null) return notFound(reply);
    return { schedules: await Promise.all(out.rows.map((r) => view(r, out.slug))) };
  });

  app.post<{ Params: { slug: string }; Body: ScheduleBody & { cron: string; timezone: string; input: Record<string, unknown> } }>(
    '/api/apis/:slug/schedules',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['cron', 'timezone', 'input'], properties: fields } } },
    async (request, reply) => {
      const actor = request.actor!;
      const api = await withActor(ctx.pool, actor, (db) => readApiBySlug(db, request.params.slug));
      if (api === null) return notFound(reply);
      const queue = await ctx.jobs();
      const body = request.body;
      const checked = validateSchedule(queue, { cron: body.cron, timezone: body.timezone, input: body.input, ...(body.rules ? { rules: body.rules } : {}), ...(body.overlap ? { overlap: body.overlap } : {}), ...(body.missed ? { onMissed: body.missed } : {}), ...(body.enabled === undefined ? {} : { enabled: body.enabled }) });
      if (!checked.ok) return sendError(reply, 400, 'invalid_schedule', checked.errors.join(' ; '));
      const s = checked.schedule;
      const row = await withActor(ctx.pool, actor, async (db) =>
        (
          await db.query<Row>(
            `INSERT INTO schedules (api_id, owner_id, cron, timezone, input, rules, overlap, on_missed, enabled)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
             RETURNING id, api_id, owner_id, cron, timezone, input, rules, overlap, on_missed, enabled, created_at`,
            [api.id, actor.userId, s.cron, s.timezone, JSON.stringify(s.input), JSON.stringify(s.rules), s.overlap, s.onMissed, s.enabled],
          )
        ).rows[0]!,
      );
      await mirrorSchedule(queue, row);
      await audit(ctx, request, actor, { action: 'schedule.created', targetType: 'schedule', targetId: row.id, outcome: 'success', meta: { api_id: api.id, cron: row.cron } });
      return reply.code(201).send(await view(row, api.slug));
    },
  );

  /** Planification de l'acteur sur une API visible ; null sinon (404 uniforme). */
  const own = async (actor: Actor, slug: string, id: string) =>
    withActor(ctx.pool, actor, async (db) => {
      const api = await readApiBySlug(db, slug);
      if (api === null || !UUID.test(id)) return null;
      const row = (await db.query<Row>(`${SELECT} WHERE s.id = $1 AND s.api_id = $2`, [id, api.id])).rows[0];
      return row ? { api, row } : null;
    });

  app.get<{ Params: { slug: string; id: string } }>('/api/apis/:slug/schedules/:id', async (request, reply) => {
    const found = await own(request.actor!, request.params.slug, request.params.id);
    if (found === null) return notFound(reply);
    return view(found.row, found.api.slug);
  });

  app.patch<{ Params: { slug: string; id: string }; Body: ScheduleBody }>(
    '/api/apis/:slug/schedules/:id',
    { schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: fields } } },
    async (request, reply) => {
      const actor = request.actor!;
      const found = await own(actor, request.params.slug, request.params.id);
      if (found === null) return notFound(reply);
      const queue = await ctx.jobs();
      const cur = found.row;
      const b = request.body;
      const checked = validateSchedule(queue, {
        cron: b.cron ?? cur.cron,
        timezone: b.timezone ?? cur.timezone,
        input: b.input ?? cur.input,
        rules: b.rules ?? cur.rules,
        overlap: b.overlap ?? cur.overlap,
        onMissed: b.missed ?? cur.on_missed,
        enabled: b.enabled ?? cur.enabled,
      });
      if (!checked.ok) return sendError(reply, 400, 'invalid_schedule', checked.errors.join(' ; '));
      const s = checked.schedule;
      const row = await withActor(ctx.pool, actor, async (db) =>
        (
          await db.query<Row>(
            `UPDATE schedules SET cron = $3, timezone = $4, input = $5::jsonb, rules = $6::jsonb, overlap = $7, on_missed = $8, enabled = $9, updated_at = now()
             WHERE id = $1 AND owner_id = $2
             RETURNING id, api_id, owner_id, cron, timezone, input, rules, overlap, on_missed, enabled, created_at`,
            [cur.id, actor.userId, s.cron, s.timezone, JSON.stringify(s.input), JSON.stringify(s.rules), s.overlap, s.onMissed, s.enabled],
          )
        ).rows[0],
      );
      if (!row) return notFound(reply);
      await mirrorSchedule(queue, row);
      await audit(ctx, request, actor, { action: 'schedule.updated', targetType: 'schedule', targetId: row.id, outcome: 'success', meta: { fields: Object.keys(b) } });
      return view(row, found.api.slug);
    },
  );

  app.delete<{ Params: { slug: string; id: string } }>('/api/apis/:slug/schedules/:id', async (request, reply) => {
    const actor = request.actor!;
    const found = await own(actor, request.params.slug, request.params.id);
    if (found === null) return notFound(reply);
    await withActor(ctx.pool, actor, (db) => db.query('DELETE FROM schedules WHERE id = $1 AND owner_id = $2', [found.row.id, actor.userId]));
    await removeScheduleMirror(await ctx.jobs(), found.row.id);
    await audit(ctx, request, actor, { action: 'schedule.deleted', targetType: 'schedule', targetId: found.row.id, outcome: 'success' });
    return reply.code(204).send();
  });
}
