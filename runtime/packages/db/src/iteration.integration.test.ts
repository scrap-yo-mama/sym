// SPDX-License-Identifier: AGPL-3.0-only
// Itération par MCP sur base réelle (tâche 3.14, migration 0027, 19 §6) : brouillon isolé de la version en service, base périmée à
// chaque déplacement du pointeur, test, promotion et transition 22 dans la même transaction, retour borné, reprise, RLS.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import {
  discardDraft,
  expireDrafts,
  IterationError,
  planPromotion,
  planRevert,
  promoteDraft,
  readIterationView,
  readPromotionGate,
  recordDraftTest,
  refineDraft,
  revertCurrent,
  type IterationErrorCode,
} from './iteration.js';
import { loadMigrations, migrateDown, migrateUp } from './migrate.js';
import { PgBossJobQueue } from './queue.js';
import { claimRun, createRun, runQueueDefinition } from './runs.js';
import { withActor } from './rls.js';
import { saveRunDataset } from './strategies.js';
import { webhookDeliveryQueueDefinition } from './webhooks.js';
import { persistenceQueueDefinition } from './persistence.js';

const A = randomUUID();
const B = randomUUID();
const PROJECT = '00000000-0000-0000-0000-000000000001';
let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;

const SCHEMA_V1 = { type: 'object', properties: { url: { type: 'string', 'x-key': true }, price: { type: 'number' } }, required: ['url'] };
const SCHEMA_PLUS_SURFACE = { type: 'object', properties: { url: { type: 'string', 'x-key': true }, price: { type: 'number' }, surface: { type: 'number' } }, required: ['url'] };
const SCHEMA_RENAMED = { type: 'object', properties: { url: { type: 'string', 'x-key': true }, prix: { type: 'number' } }, required: ['url'] };

const slug = () => `zz_test_${randomBytes(5).toString('hex')}`;

async function seedApi(opts: { status?: string; owner?: string; visibility?: 'private' | 'instance'; execution?: string } = {}): Promise<{ id: string; slug: string }> {
  const s = slug();
  const id = (
    await pool.query<{ id: string }>(
      "INSERT INTO apis (slug, owner_id, status, output_schema, visibility, views) VALUES ($1, $2, $3, $4::jsonb, $5, '{\"columns\":[\"url\",\"price\"]}'::jsonb) RETURNING id",
      [s, opts.owner ?? A, opts.status ?? 'sain', JSON.stringify(SCHEMA_V1), opts.visibility ?? 'private'],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by, est_cost_usd) VALUES ($1, 1, $2, $3, 'direct', '{\"k\":1}'::jsonb, 'investigation', 0.01)", [id, opts.owner ?? A, opts.execution ?? 'fetch']);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return { id, slug: s };
}

/** Run terminé de la version `version` avec ses items (un dataset), comme le worker les laisse. */
async function seedRun(apiId: string, version: number, items: unknown[], opts: { trigger?: string; llm?: number | null; proxy?: number; rejected?: number; input?: unknown; state?: string; outcome?: string } = {}): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, outcome, strategy_version, input, items, items_rejected, cost_llm_usd, cost_proxy_usd, finished_at, started_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, now(), now()) RETURNING id`,
      [apiId, A, opts.trigger ?? 'rest', opts.state ?? 'succeeded', opts.outcome ?? 'clean', version, JSON.stringify(opts.input ?? { q: 'x' }), items.length, opts.rejected ?? 0, opts.llm === undefined ? 0 : opts.llm, opts.proxy ?? 0],
    )
  ).rows[0]!.id;
  if (items.length > 0) await saveRunDataset(pool, { runId: id, apiId, ownerId: A, projectId: PROJECT, items });
  return id;
}

const ITEMS_CURRENT = [
  { url: 'a', price: 10 },
  { url: 'b', price: 20 },
  { url: 'c', price: 30 },
];
const ITEMS_DRAFT = [
  { url: 'a', price: 10, surface: 40 },
  { url: 'b', price: 20, surface: 55 },
  { url: 'c', price: 31, surface: 70 },
];

const statusOf = async (id: string) => (await pool.query<{ status: string; current_strategy_version: number; output_schema_version: string; draft_strategy_version: number | null }>('SELECT status, current_strategy_version, output_schema_version, draft_strategy_version FROM apis WHERE id = $1', [id])).rows[0]!;
const eventsOf = async (id: string) => (await pool.query<{ from_status: string | null; to_status: string; reason: string | null }>('SELECT from_status, to_status, reason FROM status_events WHERE api_id = $1 ORDER BY id', [id])).rows;
const versionsOf = async (id: string) => (await pool.query<{ version: number; state: string; base_stale: boolean; archive_reason: string | null; was_current: boolean }>('SELECT version, state, base_stale, archive_reason, was_current FROM strategy_versions WHERE api_id = $1 ORDER BY version', [id])).rows;
const refine = (apiId: string, extra: Partial<Parameters<typeof refineDraft>[1]> = {}) => refineDraft(pool, { apiId, ownerId: A, authorId: A, origin: 'mcp', feedback: { text: 'ajoute la surface' }, ...extra });
async function code(p: Promise<unknown>): Promise<IterationErrorCode | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (error) {
    if (error instanceof IterationError) return error.code;
    throw error;
  }
}

/** Brouillon testé et prêt : refine + runs de test enregistrés (la référence sur la version en service, l'essai sur le brouillon). */
async function readyDraft(opts: { status?: string; execution?: string; schema?: unknown; draftLlm?: number; draftItems?: unknown[]; rejected?: number } = {}) {
  const api = await seedApi({ ...(opts.status === undefined ? {} : { status: opts.status }), ...(opts.execution === undefined ? {} : { execution: opts.execution }) });
  const refined = await refine(api.id, { outputSchema: (opts.schema ?? SCHEMA_PLUS_SURFACE) as Record<string, unknown> });
  const reference = await seedRun(api.id, 1, ITEMS_CURRENT, { trigger: 'draft_test' });
  const draftRun = await seedRun(api.id, refined.draft_version, opts.draftItems ?? ITEMS_DRAFT, { trigger: 'draft_test', llm: opts.draftLlm ?? 0, ...(opts.rejected === undefined ? {} : { rejected: opts.rejected }) });
  const test = await recordDraftTest(pool, { apiId: api.id, ownerId: A, draftRunId: draftRun, referenceRunId: reference });
  return { api, refined, test: test!, reference, draftRun };
}

beforeAll(async () => {
  tdb = await createTestDatabase('iteration');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_iter_a@example.test', 'active'), ($2, 'zz_test_iter_b@example.test', 'active')", [A, B]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 3, supervise: false });
  await queue.start();
  for (const d of [runQueueDefinition(), webhookDeliveryQueueDefinition(), persistenceQueueDefinition()]) await queue.createQueue(d);
}, 120_000);

afterAll(async () => {
  await queue?.stop();
  await pool?.end();
  await tdb?.drop();
});

describe('migration 0027 : état des versions, un brouillon par API', () => {
  test('la version courante est `current`, une autre non courante `archived`, le pointeur déplacé met à jour les deux', async () => {
    const api = await seedApi();
    await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 2, $2, 'fetch', 'direct', 'repair')", [api.id, A]);
    expect((await versionsOf(api.id)).map((v) => [v.version, v.state])).toEqual([[1, 'current'], [2, 'archived']]);
    await pool.query('UPDATE apis SET current_strategy_version = 2 WHERE id = $1', [api.id]);
    expect((await versionsOf(api.id)).map((v) => [v.version, v.state, v.was_current])).toEqual([[1, 'archived', true], [2, 'current', true]]);
  });

  test('un seul brouillon par API (index unique partiel) ; un brouillon a sa base et son échéance', async () => {
    const api = await seedApi();
    const draft = (version: number) => pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by, state, base_version, expires_at) VALUES ($1, $2, $3, 'fetch', 'direct', 'refine', 'draft', 1, now() + interval '1 day')", [api.id, version, A]);
    await draft(2);
    await expect(draft(3)).rejects.toThrow(/strategy_versions_one_draft/);
    await expect(pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by, state) VALUES ($1, 9, $2, 'fetch', 'direct', 'refine', 'draft')", [api.id, A])).rejects.toThrow(/draft_shape/);
  });

  test('down puis up : 0027 se défait proprement (brouillons supprimés, runs d’essai rangés sous canary)', async () => {
    const other = await createTestDatabase('iteration_down');
    try {
      await migrateUp({ connectionString: other.url });
      const target = loadMigrations().find((m) => m.name === 'iteration')!.version;
      await migrateDown({ connectionString: other.url, steps: loadMigrations().filter((m) => m.version >= target).length });
      const c = new pg.Client({ connectionString: other.url });
      await c.connect();
      const { rows } = await c.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'strategy_versions' AND column_name = 'state'");
      await c.end();
      expect(rows).toHaveLength(0);
      await migrateUp({ connectionString: other.url });
    } finally {
      await other.drop();
    }
  });
});

describe('assert_draft_isolated_from_current', () => {
  test('refine crée un brouillon à côté : version en service, statut et status_events inchangés ; les runs servent la courante', async () => {
    const api = await seedApi();
    const before = await statusOf(api.id);
    const out = await refine(api.id, { outputSchema: SCHEMA_PLUS_SURFACE as Record<string, unknown> });
    expect(out).toMatchObject({ draft_version: 2, base_version: 1, replaced_version: null, schema_level: 'minor', output_schema_version: '1.1.0-draft.1', feedback_count: 1 });
    expect(await statusOf(api.id)).toMatchObject({ status: before.status, current_strategy_version: 1, output_schema_version: '1.0.0', draft_strategy_version: 2 });
    expect(await eventsOf(api.id)).toEqual([]);
    // Le schéma en service n'a pas bougé : il ne change que par promotion (19 §6).
    expect((await pool.query('SELECT output_schema FROM apis WHERE id = $1', [api.id])).rows[0].output_schema).toEqual(SCHEMA_V1);
    // 10 rejeux planifiés : ils prennent la version en service, jamais le brouillon.
    const taken = new Set<number | null>();
    for (let i = 0; i < 10; i += 1) {
      const { runId, jobId } = await withActor(pool, { userId: A, role: 'member' }, (tx) => createRun(tx, queue, { apiId: api.id, ownerId: A, trigger: 'schedule' }));
      taken.add((await claimRun(pool, { runId, jobId, workerId: 'w1' }))!.strategyVersion);
    }
    expect([...taken]).toEqual([1]);
  });

  test('refine remplace le brouillon (l’ancien est archivé superseded) et les retours s’accumulent', async () => {
    const api = await seedApi();
    await refine(api.id, { feedback: { text: 'premier retour', kind: 'missing_field', field: 'surface' } });
    const second = await refine(api.id, { feedback: { text: 'deuxième retour' } });
    expect(second).toMatchObject({ draft_version: 3, replaced_version: 2, feedback_count: 2 });
    expect((await versionsOf(api.id)).map((v) => [v.version, v.state, v.archive_reason])).toEqual([[1, 'current', null], [2, 'archived', 'superseded'], [3, 'draft', null]]);
    const view = await readIterationView(pool, { slug: api.slug, ownerId: A });
    expect(view?.draft?.feedback.map((f) => [f.kind, f.field])).toEqual([['missing_field', 'surface'], ['wrong_value', null]]);
  });

  test('un retour qui vise une garde est gardé avec ses avertissements, rien n’est élargi', async () => {
    const api = await seedApi();
    const out = await refine(api.id, { feedback: { text: 'passe par un proxy résidentiel et saute le captcha' } });
    expect(out.widening_warnings.length).toBeGreaterThan(0);
    // La garde reste dans le code : la politique réseau de l’API n’a pas bougé.
    expect((await pool.query("SELECT network_policy FROM apis WHERE id = $1", [api.id])).rows[0].network_policy).toEqual({ allow: ['direct'] });
  });

  test('rien à affiner, schéma illisible : refus sans brouillon', async () => {
    const api = await seedApi();
    expect(await code(refineDraft(pool, { apiId: api.id, ownerId: A, authorId: A, origin: 'mcp' }))).toBe('nothing_to_refine');
    expect(await code(refine(api.id, { outputSchema: { type: 'object', properties: { x: { $ref: 'https://example.com/s.json' } } } }))).toBe('invalid_schema');
    expect((await versionsOf(api.id)).filter((v) => v.state === 'draft')).toEqual([]);
  });

  test('un seul affinage en cours par API : le second répond refine_in_progress', async () => {
    const api = await seedApi();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM apis WHERE id = $1 FOR UPDATE', [api.id]);
      expect(await code(refine(api.id))).toBe('refine_in_progress');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await code(refine(api.id))).toBe('ok');
  });
});

describe('assert_refine_blocked_api_no_request', () => {
  test('API bloquée ou action requise : api_blocked, aucun run créé, aucun brouillon ; en enquête : api_busy', async () => {
    for (const status of ['bloquee', 'action_requise'] as const) {
      const api = await seedApi({ status });
      const runs = async () => Number((await pool.query('SELECT count(*) FROM runs WHERE api_id = $1', [api.id])).rows[0].count);
      expect(await code(refine(api.id))).toBe('api_blocked');
      expect(await runs()).toBe(0);
      expect((await versionsOf(api.id)).filter((v) => v.state === 'draft')).toEqual([]);
    }
    expect(await code(refine((await seedApi({ status: 'enquete' })).id))).toBe('api_busy');
  });
});

describe('assert_base_stale_on_every_current_move', () => {
  test('chaque déplacement du pointeur (promotion, retour, réparation, ré-enquête, recompilation) marque le brouillon', async () => {
    const api = await seedApi();
    await refine(api.id);
    expect((await versionsOf(api.id)).find((v) => v.state === 'draft')?.base_stale).toBe(false);
    // Les cinq chemins écrivent `apis.current_strategy_version` : le déclencheur couvre n'importe quel écrivain.
    for (const creator of ['repair', 'investigation', 'recompile', 'revert'] as const) {
      const next = (await pool.query<{ v: number }>('SELECT max(version) + 1 AS v FROM strategy_versions WHERE api_id = $1', [api.id])).rows[0]!.v;
      await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, $2, $3, 'fetch', 'direct', $4)", [api.id, next, A, creator]);
      await pool.query('UPDATE strategy_versions SET base_stale = false WHERE api_id = $1 AND state = \'draft\'', [api.id]);
      await pool.query('UPDATE apis SET current_strategy_version = $2 WHERE id = $1', [api.id, next]);
      expect((await versionsOf(api.id)).find((v) => v.state === 'draft')?.base_stale, creator).toBe(true);
    }
  });

  test('promouvoir un autre brouillon n’est pas possible : un test après le déplacement revalide la base', async () => {
    const { api, refined } = await readyDraft();
    await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 10, $2, 'fetch', 'direct', 'repair')", [api.id, A]);
    await pool.query('UPDATE apis SET current_strategy_version = 10 WHERE id = $1', [api.id]);
    const plan = await planPromotion(pool, { apiId: api.id, ownerId: A });
    expect(plan.ready_error).toBe('base_stale');
    expect(await code(promoteDraft(pool, queue, { apiId: api.id, ownerId: A, diffHash: 'f'.repeat(64) }))).toBe('base_stale');
    // Retester : nouvelle référence sur la version 10 et nouvel essai, la base est revalidée.
    const reference = await seedRun(api.id, 10, ITEMS_CURRENT, { trigger: 'draft_test' });
    const draftRun = await seedRun(api.id, refined.draft_version, ITEMS_DRAFT, { trigger: 'draft_test' });
    const test = await recordDraftTest(pool, { apiId: api.id, ownerId: A, draftRunId: draftRun, referenceRunId: reference });
    expect(test?.base_version).toBe(10);
    expect((await versionsOf(api.id)).find((v) => v.state === 'draft')?.base_stale).toBe(false);
  });
});

describe('test du brouillon (recordDraftTest)', () => {
  test('diff contre la version en service par clé d’identité, empreinte et phrase par gabarit', async () => {
    const { test } = await readyDraft();
    expect(test).toMatchObject({ ok: true, items: 3, items_rejected: 0, llm_free: true, reference: 'run', summary: { code: 'diff_changes' } });
    expect(test.diff).toMatchObject({ identity: 'key', added: 0, removed: 0, changed: 3 });
    expect(test.diff?.fields.map((f) => [f.field, f.changed, f.filled])).toEqual([['price', 1, 0], ['surface', 0, 3]]);
    expect(test.diff_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('un run de test qui n’est pas fini : rien n’est enregistré', async () => {
    const api = await seedApi();
    const refined = await refine(api.id);
    const running = await seedRun(api.id, refined.draft_version, [], { trigger: 'draft_test', state: 'running', outcome: undefined as never });
    expect(await recordDraftTest(pool, { apiId: api.id, ownerId: A, draftRunId: running, referenceRunId: null })).toBeNull();
  });

  test('le bruit (champ qui varie entre deux runs sains de la version en service) est retiré du diff', async () => {
    const api = await seedApi();
    const refined = await refine(api.id);
    const withSeen = (n: number) => ITEMS_CURRENT.map((i) => ({ ...i, seen: `t${n}` }));
    await seedRun(api.id, 1, withSeen(1), { outcome: 'clean' });
    await seedRun(api.id, 1, withSeen(2), { outcome: 'clean' });
    const reference = await seedRun(api.id, 1, withSeen(3), { trigger: 'draft_test' });
    const draftRun = await seedRun(api.id, refined.draft_version, ITEMS_CURRENT.map((i) => ({ ...i, seen: 't4' })), { trigger: 'draft_test' });
    const test = await recordDraftTest(pool, { apiId: api.id, ownerId: A, draftRunId: draftRun, referenceRunId: reference });
    expect(test?.diff?.noise_fields).toEqual(['seen']);
    expect(test?.diff).toMatchObject({ changed: 0, unchanged: 3 });
  });
});

describe('promotion : contrôles du code, pointeur et transition 22 au même COMMIT', () => {
  test('assert_promote_requires_diff_hash : sans l’empreinte du dernier test, 409 diff_hash_mismatch ; avec, la promotion passe', async () => {
    const { api, test } = await readyDraft();
    expect(await code(promoteDraft(pool, queue, { apiId: api.id, ownerId: A, diffHash: 'a'.repeat(64) }))).toBe('diff_hash_mismatch');
    expect((await statusOf(api.id)).current_strategy_version).toBe(1);
    const out = await promoteDraft(pool, queue, { apiId: api.id, ownerId: A, diffHash: test.diff_hash! });
    expect(out).toMatchObject({ current_version: 2, previous_version: 1, transition: null, status: 'sain', output_schema_version: '1.1.0' });
    expect(await statusOf(api.id)).toMatchObject({ current_strategy_version: 2, draft_strategy_version: null, output_schema_version: '1.1.0' });
    expect((await pool.query('SELECT output_schema, output_columns FROM apis WHERE id = $1', [api.id])).rows[0]).toEqual({ output_schema: SCHEMA_PLUS_SURFACE, output_columns: ['url', 'price', 'surface'] });
    // Sur sain, une promotion n'est pas une transition : aucune ligne status_events.
    expect(await eventsOf(api.id)).toEqual([]);
    expect((await versionsOf(api.id)).map((v) => [v.version, v.state])).toEqual([[1, 'archived'], [2, 'current']]);
  });

  test('transition 22 depuis erreur : erreur → warning, raison promoted, journalisée dans la même transaction', async () => {
    const { api, test } = await readyDraft({ status: 'erreur' });
    const out = await promoteDraft(pool, queue, { apiId: api.id, ownerId: A, diffHash: test.diff_hash! });
    expect(out).toMatchObject({ transition: 22, status: 'warning' });
    expect(await eventsOf(api.id)).toEqual([{ from_status: 'erreur', to_status: 'warning', reason: 'promoted' }]);
  });

  test('assert_promote_requires_llm_free_replay : un rejeu qui a appelé un modèle n’est pas promu (E1-E3)', async () => {
    const { api, test } = await readyDraft({ draftLlm: 0.02 });
    expect(test.llm_free).toBe(false);
    expect(await code(promoteDraft(pool, queue, { apiId: api.id, ownerId: A, diffHash: test.diff_hash! }))).toBe('replay_not_llm_free');
  });

  test('moins de 3 échantillons, sortie non conforme, jamais testé : refusé avec le code exact', async () => {
    const few = await readyDraft({ draftItems: ITEMS_DRAFT.slice(0, 2) });
    expect(await code(promoteDraft(pool, queue, { apiId: few.api.id, ownerId: A, diffHash: few.test.diff_hash! }))).toBe('too_few_samples');
    const rejected = await readyDraft({ rejected: 1 });
    expect(await code(promoteDraft(pool, queue, { apiId: rejected.api.id, ownerId: A, diffHash: rejected.test.diff_hash! }))).toBe('not_conform');
    const api = await seedApi();
    await refine(api.id);
    expect(await code(promoteDraft(pool, queue, { apiId: api.id, ownerId: A, diffHash: 'a'.repeat(64) }))).toBe('not_tested');
  });

  test('un rejeu plus cher que la version en service exige l’accord ; avec accept_cost_increase il passe', async () => {
    const api = await seedApi();
    const refined = await refine(api.id, { outputSchema: SCHEMA_PLUS_SURFACE as Record<string, unknown> });
    const reference = await seedRun(api.id, 1, ITEMS_CURRENT, { trigger: 'draft_test', proxy: 0.01 });
    const draftRun = await seedRun(api.id, refined.draft_version, ITEMS_DRAFT, { trigger: 'draft_test', proxy: 0.05 });
    const test = (await recordDraftTest(pool, { apiId: api.id, ownerId: A, draftRunId: draftRun, referenceRunId: reference }))!;
    const plan = await planPromotion(pool, { apiId: api.id, ownerId: A });
    expect(plan.estimate_delta_usd).toBeCloseTo(0.04, 6);
    expect(await code(promoteDraft(pool, queue, { apiId: api.id, ownerId: A, diffHash: test.diff_hash! }))).toBe('cost_increase_requires_accept');
    expect(await code(promoteDraft(pool, queue, { apiId: api.id, ownerId: A, diffHash: test.diff_hash!, acceptCostIncrease: true }))).toBe('ok');
  });

  test('API bloquée, en réparation ou en enquête : jamais promue', async () => {
    const { api, test } = await readyDraft();
    for (const [status, expected] of [['bloquee', 'api_blocked'], ['reparation', 'api_busy'], ['enquete', 'api_busy']] as const) {
      await pool.query('UPDATE apis SET status = $2 WHERE id = $1', [api.id, status]);
      expect(await code(promoteDraft(pool, queue, { apiId: api.id, ownerId: A, diffHash: test.diff_hash! }))).toBe(expected);
    }
    expect((await statusOf(api.id)).current_strategy_version).toBe(1);
  });

  test('le plan de promotion nomme le changement cassant et les usages touchés (colonnes de la vue)', async () => {
    const { api } = await readyDraft({ schema: SCHEMA_RENAMED });
    const plan = await planPromotion(pool, { apiId: api.id, ownerId: A });
    expect(plan).toMatchObject({ level: 'major', schema_version_from: '1.0.0', schema_version_to: '2.0.0' });
    expect(plan.changes.map((c) => [c.kind, c.path])).toEqual([['field_removed', 'price'], ['field_added', 'prix']]);
    expect(plan.impacted).toEqual([{ kind: 'view_column', ref: 'views.columns', field: 'price' }]);
  });
});

describe('retour de version (revert_api)', () => {
  test('retour vers une version qui a été courante : déplacement de pointeur, brouillon gardé et marqué base_stale', async () => {
    const { api, test } = await readyDraft();
    await promoteDraft(pool, queue, { apiId: api.id, ownerId: A, diffHash: test.diff_hash! });
    // Un nouveau brouillon naît de la version 2 ; le retour vers 1 le périme.
    await refine(api.id, { feedback: { text: 'encore' } });
    const plan = await planRevert(pool, { apiId: api.id, ownerId: A });
    expect(plan).toMatchObject({ target_version: 1, crosses_schema_version: true, level: 'major', schema_version_to: '1.0.0' });
    const out = await revertCurrent(pool, queue, { apiId: api.id, ownerId: A });
    expect(out).toMatchObject({ current_version: 1, previous_version: 2, transition: null, output_schema_version: '1.0.0' });
    expect((await pool.query('SELECT output_schema FROM apis WHERE id = $1', [api.id])).rows[0].output_schema).toEqual(SCHEMA_V1);
    expect((await versionsOf(api.id)).find((v) => v.state === 'draft')?.base_stale).toBe(true);
  });

  test('assert_schema_change_only_via_draft (étendu à revert) : un brouillon jeté, remplacé ou une vN+1 non validée ne se rétablit jamais', async () => {
    const api = await seedApi();
    await refine(api.id);
    await refine(api.id); // v2 superseded, v3 draft
    await discardDraft(pool, { apiId: api.id, ownerId: A });
    await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by, archive_reason) VALUES ($1, 9, $2, 'fetch', 'direct', 'repair', 'repair_not_validated')", [api.id, A]);
    for (const version of [2, 3, 9]) expect(await code(revertCurrent(pool, queue, { apiId: api.id, ownerId: A, version })), `v${version}`).toBe('version_not_revertable');
    expect(await code(revertCurrent(pool, queue, { apiId: api.id, ownerId: A, version: 1 }))).toBe('already_current');
    expect(await code(revertCurrent(pool, queue, { apiId: api.id, ownerId: A }))).toBe('no_previous_version');
  });

  test('depuis erreur : transition 22 (reverted)', async () => {
    const api = await seedApi({ status: 'erreur' });
    await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 2, $2, 'fetch', 'direct', 'repair')", [api.id, A]);
    await pool.query('UPDATE apis SET current_strategy_version = 2 WHERE id = $1', [api.id]);
    const out = await revertCurrent(pool, queue, { apiId: api.id, ownerId: A, version: 1 });
    expect(out).toMatchObject({ current_version: 1, transition: 22, status: 'warning' });
    expect(await eventsOf(api.id)).toEqual([{ from_status: 'erreur', to_status: 'warning', reason: 'reverted' }]);
  });
});

describe('jeter, périmer, reprendre', () => {
  test('discard_draft archive le brouillon (discarded) sans toucher à la version en service ; sans brouillon, no_draft', async () => {
    const api = await seedApi();
    expect(await code(discardDraft(pool, { apiId: api.id, ownerId: A }))).toBe('no_draft');
    await refine(api.id);
    expect(await discardDraft(pool, { apiId: api.id, ownerId: A })).toEqual({ archived_version: 2 });
    expect((await versionsOf(api.id)).map((v) => [v.version, v.state, v.archive_reason])).toEqual([[1, 'current', null], [2, 'archived', 'discarded']]);
    expect((await statusOf(api.id)).draft_strategy_version).toBeNull();
  });

  test('un brouillon périmé (DRAFT_TTL_DAYS) est archivé expired par la maintenance et à la lecture', async () => {
    const a = await seedApi();
    const b = await seedApi();
    const past = new Date(Date.now() - 40 * 86_400_000);
    await refine(a.id, { now: past });
    await refine(b.id, { now: past });
    expect(await expireDrafts(pool)).toBeGreaterThanOrEqual(2);
    expect((await versionsOf(a.id)).map((v) => v.archive_reason)).toEqual([null, 'expired']);
    const c = await seedApi();
    await refine(c.id, { now: past });
    const view = await readIterationView(pool, { slug: c.slug, ownerId: A });
    expect(view?.draft).toBeNull();
    expect((await versionsOf(c.id)).map((v) => v.archive_reason)).toEqual([null, 'expired']);
    expect(await code(promoteDraft(pool, queue, { apiId: c.id, ownerId: A, diffHash: 'a'.repeat(64) }))).toBe('no_draft');
  });

  test('assert_resume_in_new_conversation : la vue de reprise donne brouillon, retours, test et prochaine étape ; propriétaire seul', async () => {
    const { api, test } = await readyDraft();
    const view = await readIterationView(pool, { slug: api.slug, ownerId: A });
    expect(view).toMatchObject({ slug: api.slug, status: 'sain', current_version: 1, next_step: 'promote' });
    expect(view?.draft).toMatchObject({ version: 2, base_version: 1, base_stale: false, tested: true, output_schema_version: '1.1.0-draft.1', schema_level: 'minor' });
    expect(view?.draft?.feedback[0]?.text).toBe('ajoute la surface');
    expect(view?.draft?.last_test?.diff_hash).toBe(test.diff_hash);
    expect(view?.versions.map((v) => v.version)).toEqual([2, 1]);
    // Sans brouillon : prochaine étape « refine » ; jamais testé : « test ».
    const fresh = await seedApi();
    expect((await readIterationView(pool, { slug: fresh.slug, ownerId: A }))?.next_step).toBe('refine');
    await refine(fresh.id);
    expect((await readIterationView(pool, { slug: fresh.slug, ownerId: A }))?.next_step).toBe('test');
    const blocked = await seedApi({ status: 'bloquee' });
    expect((await readIterationView(pool, { slug: blocked.slug, ownerId: A }))?.next_step).toBe('blocked');
  });

  test('assert_iteration_block_owner_only : un autre membre ne lit ni la vue, ni le brouillon (API partagée comprise), ni ne l’affine', async () => {
    const shared = await seedApi({ visibility: 'instance' });
    await refine(shared.id, { feedback: { text: 'texte privé du retour' } });
    expect(await readIterationView(pool, { slug: shared.slug, ownerId: B })).toBeNull();
    // RLS : la lecture partagée du catalogue exclut les brouillons ; la version en service reste lisible.
    const seen = await withActor(pool, { userId: B, role: 'member' }, (tx) => tx.query('SELECT version, state FROM strategy_versions WHERE api_id = $1 ORDER BY version', [shared.id]));
    expect(seen.rows).toEqual([{ version: 1, state: 'current' }]);
    expect(await code(refineDraft(pool, { apiId: shared.id, ownerId: B, authorId: B, origin: 'mcp', feedback: { text: 'x' } }))).toBe('not_found');
    expect(await code(promoteDraft(pool, queue, { apiId: shared.id, ownerId: B, diffHash: 'a'.repeat(64) }))).toBe('not_found');
    expect(await code(discardDraft(pool, { apiId: shared.id, ownerId: B }))).toBe('not_found');
  });

  test('porte de promotion : major_in_console par défaut, jamais plus large', async () => {
    expect(await readPromotionGate(pool, A)).toBe('major_in_console');
    await pool.query("UPDATE users SET promotion_gate = 'all_in_console' WHERE id = $1", [B]);
    expect(await readPromotionGate(pool, B)).toBe('all_in_console');
    await expect(pool.query("UPDATE users SET promotion_gate = 'everywhere' WHERE id = $1", [B])).rejects.toThrow();
  });
});
