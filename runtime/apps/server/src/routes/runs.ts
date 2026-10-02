// SPDX-License-Identifier: AGPL-3.0-only
// Runs (tâche 3.1, 05 § 4.2) : liste (« Tous les runs », métadonnées), détail (= get_run), annulation (= cancel_run),
// pause et reprise (actions de l'utilisateur, 06 § 2), journal du run (vue Technique).
//
// Droits : runs de l'acteur seulement (RLS, 404 uniforme) ; l'admin et l'owner lisent les MÉTADONNÉES du run d'autrui
// (05 § 4.4, `assert_no_impersonation`), jamais son entrée, ses essais, ses items ni son journal.
import { RUN_STATES, RUN_TRIGGERS } from '@runtime/core';
import { applyStatusAndNotify, cancelRun, pauseRun, resumeRun, withActor } from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { readApiBySlug } from '../rest/apis.js';
import { listRunRows, readRunRow, runDetail, runMetadataForAdmin, runSummary } from '../rest/runs.js';
import { rejectIfKeyRateLimited, reserveRunSlot, RunSlotError, sendRunSlotError, usd, usdOrNull } from '../rest/shared.js';
import { decodeCursor, encodeCursor, UUID } from './account-helpers.js';
import { audit, notFound, sendError } from './guard.js';

const listQuery = {
  type: 'object',
  properties: {
    api: { type: 'string', maxLength: 63 },
    state: { type: 'string', enum: [...RUN_STATES] },
    trigger: { type: 'string', enum: [...RUN_TRIGGERS] },
    since: { type: 'string', format: 'date-time' },
    until: { type: 'string', format: 'date-time' },
    cursor: { type: 'string', maxLength: 512 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
} as const;

type LogRow = { seq: number; ts: Date; level: string; event: string; data: unknown };

/** Niveaux du journal ramenés à ceux de la console (`trace` → `debug`, `fatal` → `error`). */
const LEVEL: Record<string, 'debug' | 'info' | 'warn' | 'error'> = { trace: 'debug', debug: 'debug', info: 'info', warn: 'warn', error: 'error', fatal: 'error' };

export function runRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { api?: string; state?: string; trigger?: string; since?: string; until?: string; cursor?: string; limit?: number } }>(
    '/api/runs',
    { schema: { querystring: listQuery } },
    async (request, reply) => {
      const actor = request.actor!;
      const q = request.query;
      const limit = q.limit ?? 50;
      const cursor = decodeCursor(q.cursor, 2);
      if (cursor === null || (cursor && !UUID.test(cursor[1]!))) return sendError(reply, 400, 'invalid_cursor', 'curseur illisible');
      const out = await withActor(ctx.pool, actor, async (db) => {
        // « Tous les runs » de l'acteur (même ceux d'une API `instance` d'autrui) ; filtre `api` par slug visible.
        const where = ['r.owner_id = $1'];
        const params: unknown[] = [actor.userId];
        const add = (sql: string, value: unknown) => {
          params.push(value);
          where.push(sql.replace('$?', `$${params.length}`));
        };
        if (q.api !== undefined) {
          const api = await readApiBySlug(db, q.api);
          if (api === null) return [];
          add('r.api_id = $?', api.id);
        }
        if (q.state) add('r.state = $?', q.state);
        if (q.trigger) add('r.trigger = $?', q.trigger);
        if (q.since) add('r.created_at >= $?::timestamptz', q.since);
        if (q.until) add('r.created_at < $?::timestamptz', q.until);
        if (cursor) {
          params.push(cursor[0], cursor[1]);
          where.push(`(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
        }
        return listRunRows(db, where.join(' AND '), params, limit + 1);
      });
      const page = out.slice(0, limit);
      const last = page.at(-1);
      return { runs: page.map(runSummary), next_cursor: out.length > limit && last ? encodeCursor(last.created_text, last.id) : null };
    },
  );

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const actor = request.actor!;
    if (!UUID.test(request.params.id)) return notFound(reply);
    const detail = await withActor(ctx.pool, actor, async (db) => {
      const row = await readRunRow(db, request.params.id);
      return row === null ? null : runDetail(db, row);
    });
    if (detail !== null) return detail;
    const metadata = await runMetadataForAdmin(ctx, actor, request.params.id);
    if (metadata === null) return notFound(reply);
    await audit(ctx, request, actor, { action: 'run.metadata_read', targetType: 'run', targetId: metadata.id, outcome: 'success' });
    return metadata;
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request, reply) => {
    const actor = request.actor!;
    if (!UUID.test(request.params.id)) return notFound(reply);
    const queue = await ctx.jobs();
    // Annulation (05 § 4.4) : état `cancelled` tout de suite, coûts engagés imputés (INV4) ; le worker s'arrête à son
    // battement suivant (jeton de clôture).
    const out = await withActor(ctx.pool, actor, async (tx) => {
      const before = await readRunRow(tx, request.params.id);
      if (before === null) return null;
      const cancelled = await cancelRun(tx, queue, request.params.id);
      const after = await readRunRow(tx, request.params.id);
      return { cancelled, run: after ?? before };
    });
    if (out === null) return notFound(reply);
    if (!out.cancelled) return sendError(reply, 409, 'run_not_active', 'ce run est déjà terminé');
    if (out.run.kind === 'investigation') {
      // Enquête annulée (en file, en pause ou tenue par un worker, qui perd alors son bail sans rien écrire) : l'API ne
      // reste pas en `enquete` sans enquête. Fin sans stratégie conforme, par la machine (INV3) : transition 21 (statut
      // d'avant une ré-enquête, ancienne version gardée) ou 2 (`erreur`, d'où « Ré-enquêter » repart, 16) ; phase close
      // au même COMMIT. Le catalogue fermé des raisons (04 § 6, 06) n'a pas de raison « annulée » : celle de la fin de
      // budget est gardée (l'utilisateur a arrêté la dépense).
      await applyStatusAndNotify(ctx.pool, queue, {
        apiId: out.run.api_id,
        runId: out.run.id,
        event: { type: 'investigation_failed', cause: 'budget_exhausted' },
        clock: { now: () => new Date() },
        beforeWrite: async (db) => {
          await db.query("UPDATE apis SET investigation_phase = 'done', updated_at = now() WHERE id = $1 AND investigation_phase IS DISTINCT FROM 'done'", [out.run.api_id]);
        },
      });
    }
    await audit(ctx, request, actor, { action: 'run.cancelled', targetType: 'run', targetId: request.params.id, outcome: 'success' });
    const llm = usdOrNull(out.run.cost_llm_usd);
    const proxy = usd(out.run.cost_proxy_usd);
    return { run_id: out.run.id, state: 'cancelled' as const, cost: { llm_usd: llm, proxy_usd: proxy, total_usd: llm === null ? null : Math.round((llm + proxy) * 1e6) / 1e6, estimated: out.run.usage_estimated } };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/pause', async (request, reply) => {
    const actor = request.actor!;
    if (!UUID.test(request.params.id)) return notFound(reply);
    const queue = await ctx.jobs();
    const out = await withActor(ctx.pool, actor, async (tx) => ((await readRunRow(tx, request.params.id)) === null ? null : pauseRun(tx, queue, request.params.id)));
    if (out === null) return notFound(reply);
    if (out === 'not_active') return sendError(reply, 409, 'run_not_active', 'ce run est déjà terminé');
    if (out === 'already_paused') return sendError(reply, 409, 'run_paused', 'ce run est déjà en pause');
    // Une API qui écrit n'est jamais rejouée (même règle que la reprise après la perte d'un worker) : pas de pause.
    if (out === 'write_actions') return sendError(reply, 409, 'pause_not_allowed', 'une API qui écrit ne se met pas en pause : arrêtez le run');
    await audit(ctx, request, actor, { action: 'run.paused', targetType: 'run', targetId: request.params.id, outcome: 'success' });
    return reply.code(202).send({ run_id: request.params.id, state: 'queued', poll_after_seconds: null });
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/resume', async (request, reply) => {
    const actor = request.actor!;
    if (!UUID.test(request.params.id)) return notFound(reply);
    const exists = await withActor(ctx.pool, actor, (db) => readRunRow(db, request.params.id));
    if (exists === null) return notFound(reply);
    if (exists.paused_at === null) return sendError(reply, 409, 'run_not_paused', 'ce run n’est pas en pause');
    if (await rejectIfKeyRateLimited(ctx, reply, actor)) return reply;
    const queue = await ctx.jobs();
    // Le run repris redevient actif : plafonds utilisateur et instance vérifiés dans la même transaction (atomique).
    let resumed: boolean;
    try {
      resumed = await withActor(ctx.pool, actor, async (tx) => {
        await reserveRunSlot(tx, ctx);
        return resumeRun(tx, queue, request.params.id);
      });
    } catch (error) {
      if (error instanceof RunSlotError) return sendRunSlotError(reply, error);
      throw error;
    }
    if (!resumed) return sendError(reply, 409, 'run_not_paused', 'ce run n’est pas en pause');
    await audit(ctx, request, actor, { action: 'run.resumed', targetType: 'run', targetId: request.params.id, outcome: 'success' });
    return reply.code(202).send({ run_id: request.params.id, state: 'queued', poll_after_seconds: 5 });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: number; limit?: number } }>(
    '/api/runs/:id/logs',
    { schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      if (!UUID.test(request.params.id)) return notFound(reply);
      const limit = request.query.limit ?? 200;
      const rows = await withActor(ctx.pool, actor, async (db) => {
        if ((await readRunRow(db, request.params.id)) === null) return null;
        return (
          await db.query<LogRow>('SELECT seq, ts, level, event, data FROM run_logs WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3', [
            request.params.id,
            request.query.after ?? -1,
            limit + 1,
          ])
        ).rows;
      });
      if (rows === null) return notFound(reply);
      const page = rows.slice(0, limit);
      return {
        lines: page.map((l) => ({
          seq: l.seq,
          at: l.ts.toISOString(),
          level: LEVEL[l.level] ?? 'info',
          code: l.event,
          ...(l.data !== null && typeof l.data === 'object' && !Array.isArray(l.data) ? { data: l.data as Record<string, unknown> } : {}),
        })),
        next_after: rows.length > limit && page.length > 0 ? page.at(-1)!.seq : null,
      };
    },
  );

}
