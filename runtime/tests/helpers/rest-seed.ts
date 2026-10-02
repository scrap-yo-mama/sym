// SPDX-License-Identifier: AGPL-3.0-only
// Données de test de l'API REST (tâche 3.1) écrites en base sous l'identité système : API du catalogue avec une version
// de stratégie, runs (terminés ou actifs), datasets et leurs items, planifications, cibles webhook. Préfixe `zz_test`
// ou `zz-test` partout (artefacts de test reconnaissables).
import { withClient } from './pg.js';

let seq = 0;
const next = () => (seq += 1);

export type SeededApi = { id: string; slug: string };

const ZZ_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: { title: { type: 'string' }, price: { type: 'number' }, note: { type: 'string' } },
} as const;

const ZZ_INPUT_SCHEMA = { type: 'object', additionalProperties: false, properties: { page: { type: 'integer', minimum: 1 } } } as const;

/** API `sain` à stratégie v1 (`fetch` / `direct`), schémas d'entrée et de sortie posés. */
export async function seedApi(
  url: string,
  ownerId: string,
  opts: { status?: string; visibility?: 'private' | 'instance'; requiresSession?: boolean; slug?: string; strategy?: boolean; allowWrite?: boolean } = {},
): Promise<SeededApi> {
  const slug = opts.slug ?? `zz-test-api-${next()}-${Math.random().toString(36).slice(2, 7)}`;
  return withClient(url, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      // output_columns : ordre déclaré des propriétés, relevé avant jsonb comme à la fin d'une enquête (0017_rest_api).
      `INSERT INTO apis (slug, owner_id, visibility, description, status, requires_session, input_schema, output_schema, output_columns, allow_write_actions)
       VALUES ($1, $2, $3, 'zz_test api', $4, $5, $6, $7, $8, $9) RETURNING id`,
      [slug, ownerId, opts.visibility ?? 'private', opts.status ?? 'sain', opts.requiresSession === true, JSON.stringify(ZZ_INPUT_SCHEMA), JSON.stringify(ZZ_OUTPUT_SCHEMA), Object.keys(ZZ_OUTPUT_SCHEMA.properties), opts.allowWrite === true],
    );
    const id = rows[0]!.id;
    if (opts.strategy !== false) {
      await c.query(
        `INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', '{"kind": "declarative", "zz": 1}', 0.0001, 'investigation')`,
        [id, ownerId],
      );
      await c.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
    }
    return { id, slug };
  });
}

export type SeededRun = { runId: string; datasetId: string | null };

/** Run d'un utilisateur sur une API ; `items` : dataset écrit (seq 0..n-1) et run `succeeded`. */
export async function seedRun(
  url: string,
  input: { apiId: string; ownerId: string; state?: string; items?: readonly Record<string, unknown>[]; kind?: 'run' | 'investigation'; failureClass?: string; degraded?: string[]; jobId?: string | null },
): Promise<SeededRun> {
  return withClient(url, async (c) => {
    const api = await c.query<{ owner_id: string }>('SELECT owner_id FROM apis WHERE id = $1', [input.apiId]);
    const state = input.state ?? (input.items ? 'succeeded' : 'queued');
    const terminal = !['queued', 'running', 'waiting_tunnel'].includes(state);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, outcome, failure_class, retryable, degraded_reasons, input, kind, cost_llm_usd, cost_proxy_usd,
                         started_at, finished_at, duration_ms, heartbeat_at, job_id, strategy_version, error_detail)
       VALUES ($1, $2, $3, 'rest', $4, $5, $6, $7, $8, '{"page": 1}', $9, 0.001, 0.0002, now(), CASE WHEN $10 THEN now() END, CASE WHEN $10 THEN 12 END, now(), $11, 1, $12)
       RETURNING id`,
      [
        input.apiId,
        input.ownerId,
        api.rows[0]!.owner_id,
        state,
        state === 'succeeded' ? ((input.degraded?.length ?? 0) > 0 ? 'degraded' : 'clean') : state === 'failed' ? 'failed' : null,
        input.failureClass ?? null,
        state === 'failed' ? false : null,
        input.degraded ?? [],
        input.kind ?? 'run',
        terminal,
        input.jobId === undefined ? null : input.jobId,
        state === 'failed' ? 'zz_test_private_error' : null,
      ],
    );
    const runId = rows[0]!.id;
    await c.query("INSERT INTO run_attempts (run_id, seq, owner_id, execution, network, result_class, est_cost_usd, cost_usd, ms) VALUES ($1, 0, $2, 'fetch', 'direct', $3, 0.0001, 0.0012, 40)", [
      runId,
      input.ownerId,
      state === 'failed' ? (input.failureClass ?? 'network') : 'ok',
    ]);
    await c.query("INSERT INTO run_logs (run_id, seq, owner_id, level, event, data) VALUES ($1, 0, $2, 'info', 'zz_test_started', '{\"n\": 1}'), ($1, 1, $2, 'trace', 'zz_test_detail', NULL)", [runId, input.ownerId]);
    let datasetId: string | null = null;
    if (input.items) {
      await c.query('SELECT ensure_dataset_items_partitions()');
      const ds = await c.query<{ id: string }>('INSERT INTO datasets (api_id, run_id, owner_id, item_count) VALUES ($1, $2, $3, $4) RETURNING id', [input.apiId, runId, input.ownerId, input.items.length]);
      datasetId = ds.rows[0]!.id;
      const json = input.items.map((i) => JSON.stringify(i));
      await c.query(
        `INSERT INTO dataset_items (dataset_id, seq, run_id, owner_id, item, size_bytes)
         SELECT $1, s.ord - 1, $2, $3, s.item::jsonb, length(s.item) FROM unnest($4::text[]) WITH ORDINALITY AS s(item, ord)`,
        [datasetId, runId, input.ownerId, json],
      );
      await c.query('UPDATE runs SET dataset_id = $2, items = $3 WHERE id = $1', [runId, datasetId, input.items.length]);
    }
    return { runId, datasetId };
  });
}

/** Planification d'un utilisateur sur une API. */
export async function seedSchedule(url: string, apiId: string, ownerId: string): Promise<string> {
  return withClient(url, async (c) =>
    (await c.query<{ id: string }>("INSERT INTO schedules (api_id, owner_id, cron, timezone, input, enabled) VALUES ($1, $2, '0 3 * * *', 'UTC', '{}', false) RETURNING id", [apiId, ownerId])).rows[0]!.id,
  );
}

/** Cible webhook d'un utilisateur (sans secret : jamais livrée). */
export async function seedWebhook(url: string, ownerId: string): Promise<string> {
  return withClient(url, async (c) =>
    (await c.query<{ id: string }>("INSERT INTO webhook_subscriptions (owner_id, url, events) VALUES ($1, 'https://zz-test-hook.example/in', '{run.failed}') RETURNING id", [ownerId])).rows[0]!.id,
  );
}
