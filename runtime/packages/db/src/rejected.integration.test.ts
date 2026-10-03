// SPDX-License-Identifier: AGPL-3.0-only
// Quarantaine des items non conformes (tâche 2.3, D-49, migration 0018) sur base réelle : l'échantillon appartient à
// l'APPELANT du run (RLS), le propriétaire d'une API partagée ne lit que les agrégats (404 sur l'échantillon), l'admin les
// métadonnées ; purge avec `RETENTION_SAMPLES_DAYS` ; comprise dans l'effacement d'une personne ; vN+1 de réparation.
import { randomBytes, randomUUID } from 'node:crypto';
import { partitionItems, quarantineSummary } from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateDown, migrateUp } from './migrate.js';
import { readHealthyItems, readRejectedAggregates, readRejectedItems, readRejectedSample, readVolumeHistory, saveRejectedItems, saveRepairedStrategy } from './rejected.js';
import { cleanupExpiredRunData, countSubjectOccurrences, DEFAULT_RETENTION_POLICY, eraseSubject } from './retention/index.js';
import { withActor } from './rls.js';
import { readRun } from './runs.js';

const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const ADMIN = randomUUID();
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['titre', 'prix'],
  properties: { titre: { type: 'string' }, prix: { type: 'number' }, vendeur: { type: 'string', 'x-personal': 'identifier' } },
  additionalProperties: false,
};

let tdb: TestDatabase;
let pool: pg.Pool;
let apiId: string;

async function newRun(owner: string, opts: { created?: Date; state?: string; items?: number; itemsRejected?: number; input?: unknown } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, created_at, finished_at, items, items_rejected, input)
     VALUES ($1, $2, $3, 'rest', $4, $5, $5, $6, $7, $8::jsonb) RETURNING id`,
    [apiId, owner, A, opts.state ?? 'succeeded', opts.created ?? new Date(), opts.items ?? 0, opts.itemsRejected ?? 0, opts.input === undefined ? null : JSON.stringify(opts.input)],
  );
  return rows[0]!.id;
}

const summaryOf = (items: unknown[]) => quarantineSummary(SCHEMA, partitionItems(SCHEMA, items).rejected);

beforeAll(async () => {
  tdb = await createTestDatabase('rejected');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  await pool.query(
    `INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_a@example.test', 'active'), ($2, 'zz_test_b@example.test', 'active'),
       ($3, 'zz_test_c@example.test', 'active'), ($4, 'zz_test_admin@example.test', 'active')`,
    [A, B, C, ADMIN],
  );
  // API de A partagée avec l'instance (13 § 3) : B peut la lancer ; ses runs lui appartiennent.
  apiId = (
    await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, visibility, output_schema) VALUES ('zz_test_shared', $1, 'instance', $2::jsonb) RETURNING id", [A, JSON.stringify(SCHEMA)])
  ).rows[0]!.id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await tdb?.drop();
});

describe('quarantine run_rejected_items (0018)', () => {
  test('assert_cross_user_denied — B sur l’API instance de A : B lit l’échantillon, A n’a que les agrégats (404 sur l’échantillon), C rien', async () => {
    const runB = await newRun(B, { items: 47, itemsRejected: 1 });
    const summary = summaryOf([{ titre: 'Vélo', vendeur: 'zz_test_vendeur@example.invalid' }]);
    await saveRejectedItems(pool, { runId: runB, apiId, ownerId: B, projectId: '00000000-0000-0000-0000-000000000001', summary });

    const asB = await readRejectedItems(pool, { userId: B, role: 'member' }, runB);
    expect(asB).toMatchObject({ access: 'caller', count: 1, by_reason: [{ keyword: 'required', path: '/prix', count: 1 }] });
    expect(asB?.access === 'caller' ? asB.sample : null).toEqual([{ titre: 'Vélo', vendeur: '[PERSONAL]' }]);

    const asA = await readRejectedItems(pool, { userId: A, role: 'member' }, runB);
    expect(asA).toEqual({ access: 'api_owner', count: 1, by_reason: [{ keyword: 'required', path: '/prix', count: 1 }] });
    expect(await readRejectedSample(pool, { userId: A, role: 'member' }, runB)).toBeNull();
    expect(await readRejectedSample(pool, { userId: B, role: 'member' }, runB)).toHaveLength(1);
    // RLS : A ne lit aucune ligne de la table ; C ne voit ni la table ni les agrégats.
    expect((await withActor(pool, { userId: A, role: 'member' }, (tx) => tx.query('SELECT * FROM run_rejected_items WHERE run_id = $1', [runB]))).rowCount).toBe(0);
    expect(await readRejectedItems(pool, { userId: C, role: 'member' }, runB)).toBeNull();
    expect(await withActor(pool, { userId: C, role: 'member' }, (tx) => readRejectedAggregates(tx, runB))).toBeNull();
    // Admin de l'instance : métadonnées seulement (ni raisons ni échantillon).
    const meta = await withActor(pool, { userId: ADMIN, role: 'admin' }, (tx) => tx.query('SELECT * FROM admin_rejected_metadata WHERE run_id = $1', [runB]));
    expect(Object.keys(meta.rows[0]!).sort()).toEqual(['api_id', 'created_at', 'owner_id', 'run_id', 'total_rejected']);
    expect((await withActor(pool, { userId: ADMIN, role: 'admin' }, (tx) => tx.query('SELECT * FROM run_rejected_items WHERE run_id = $1', [runB]))).rowCount).toBe(0);
    // Enveloppe du run (05 §4.1 `RunResult.rejected`) : agrégats sans valeur, pour l'appelant.
    const run = await withActor(pool, { userId: B, role: 'member' }, (tx) => readRun(tx, runB));
    expect(run).toMatchObject({ items: 47, items_rejected: 1, rejected: { count: 1, by_reason: [{ keyword: 'required', path: '/prix', count: 1 }] } });
    // Aucune valeur personnelle écrite nulle part.
    expect((await pool.query("SELECT 1 FROM run_rejected_items WHERE to_jsonb(run_rejected_items)::text LIKE '%example.invalid%'")).rowCount).toBe(0);
  });

  test('raisons sans valeur : une clé inconnue du run de B (identifiant servant de clé) n’atteint jamais A par run_rejected_aggregates', async () => {
    const runB = await newRun(B, { items: 1, itemsRejected: 1 });
    const summary = summaryOf([{ titre: 'Vélo', prix: 3, zz_test_secret_id_123: { commande: 'zz_test_secret_order_9' } }]);
    await saveRejectedItems(pool, { runId: runB, apiId, ownerId: B, projectId: '00000000-0000-0000-0000-000000000001', summary });
    const asA = await withActor(pool, { userId: A, role: 'member' }, (tx) => tx.query('SELECT to_jsonb(v)::text AS row FROM run_rejected_aggregates v WHERE run_id = $1', [runB]));
    expect(asA.rowCount).toBe(1);
    expect(asA.rows[0]!.row).not.toMatch(/zz_test_secret/);
    expect(await readRejectedItems(pool, { userId: A, role: 'member' }, runB)).toEqual({ access: 'api_owner', count: 1, by_reason: [{ keyword: 'additionalProperties', path: '/*', count: 1 }] });
    // Nulle part en base (échantillon de B compris).
    expect((await pool.query("SELECT 1 FROM run_rejected_items WHERE to_jsonb(run_rejected_items)::text LIKE '%zz_test_secret%'")).rowCount).toBe(0);
  });

  test('owner_id = runs.owner_id imposé en base : C ne peut pas écrire la quarantaine du run de B (ni sous son nom ni sous celui de B)', async () => {
    const runB = await newRun(B);
    const summary = summaryOf([{ titre: 'x' }]);
    await expect(saveRejectedItems(pool, { runId: runB, apiId, ownerId: C, projectId: '00000000-0000-0000-0000-000000000001', summary })).rejects.toThrow();
    await expect(
      withActor(pool, { userId: C, role: 'member' }, (tx) =>
        tx.query("INSERT INTO run_rejected_items (run_id, api_id, owner_id, total_rejected) VALUES ($1, $2, $3, 1)", [runB, apiId, B]),
      ),
    ).rejects.toThrow();
    expect((await pool.query('SELECT 1 FROM run_rejected_items WHERE run_id = $1', [runB])).rowCount).toBe(0);
  });

  test('assert_retention_purge — échantillon vidé après RETENTION_SAMPLES_DAYS, agrégats gardés jusqu’à la purge du run', async () => {
    const now = new Date('2027-01-31T12:00:00Z');
    const old = await newRun(B, { created: new Date('2027-01-01T00:00:00Z') });
    await saveRejectedItems(pool, { runId: old, apiId, ownerId: B, projectId: '00000000-0000-0000-0000-000000000001', summary: summaryOf([{ titre: 'ancien' }]) });
    await pool.query("UPDATE run_rejected_items SET created_at = '2027-01-01T00:00:00Z' WHERE run_id = $1", [old]);
    const fresh = await newRun(B, { created: new Date('2027-01-30T00:00:00Z') });
    await saveRejectedItems(pool, { runId: fresh, apiId, ownerId: B, projectId: '00000000-0000-0000-0000-000000000001', summary: summaryOf([{ titre: 'récent' }]) });
    await pool.query("UPDATE run_rejected_items SET created_at = '2027-01-30T00:00:00Z' WHERE run_id = $1", [fresh]);
    const out = await cleanupExpiredRunData(pool, now, { ...DEFAULT_RETENTION_POLICY, samplesDays: 14 });
    expect(out.rejected_samples).toBeGreaterThanOrEqual(1);
    const rows = (await pool.query<{ run_id: string; sample: unknown[]; total_rejected: number }>('SELECT run_id, sample, total_rejected FROM run_rejected_items WHERE run_id = ANY($1::uuid[])', [[old, fresh]])).rows;
    expect(rows.find((r) => r.run_id === old)).toMatchObject({ sample: [], total_rejected: 1 });
    expect(rows.find((r) => r.run_id === fresh)!.sample).toHaveLength(1);
  });

  test('assert_erasure_complete — une valeur du sujet restée dans l’échantillon ou une raison est effacée, aucun résidu', async () => {
    const runB = await newRun(B);
    // Valeur hors champ `x-personal` (titre libre), donc présente dans l'échantillon nettoyé.
    const summary = summaryOf([{ titre: 'Annonce de Zztest Effacable Personne', prix: 'N/A' }]);
    await saveRejectedItems(pool, { runId: runB, apiId, ownerId: B, projectId: '00000000-0000-0000-0000-000000000001', summary });
    const values = ['Zztest Effacable Personne'];
    const req = { values, key: randomBytes(32), actor: { userId: B, via: 'ui' as const }, scope: { ownerId: B } };
    expect((await countSubjectOccurrences(pool, values, { ownerId: B }))['run_rejected_items']).toBe(1);
    const dry = await eraseSubject(pool, req, { dryRun: true });
    expect(dry.plan.rows['run_rejected_items']).toBe(1);
    const report = await eraseSubject(pool, req, { confirm: dry.plan.confirmation });
    expect(report.scrubbed['run_rejected_items']).toBe(1);
    expect(report.residual).toEqual({});
    expect(JSON.stringify((await pool.query('SELECT sample FROM run_rejected_items WHERE run_id = $1', [runB])).rows[0])).not.toContain('Effacable');
  });

  test('vN+1 de réparation : created_by repair, patch et parent, courante seulement si la version réparée l’était encore ; output_schema intact', async () => {
    const api = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, output_schema, current_strategy_version) VALUES ('zz_test_repair', $1, $2::jsonb, 1) RETURNING id", [A, JSON.stringify(SCHEMA)])).rows[0]!.id;
    await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', '{}', 'investigation')", [api, A]);
    const patch = [{ op: 'replace', path: '/fields/titre/path', value: '$.name' }];
    const saved = await saveRepairedStrategy(pool, { apiId: api, ownerId: A, parentVersion: 1, execution: 'fetch', network: 'direct', spec: { patched: true }, patch, estCostUsd: 0 });
    expect(saved).toEqual({ version: 2, promoted: true });
    const row = (await pool.query('SELECT created_by, parent_version, patch FROM strategy_versions WHERE api_id = $1 AND version = 2', [api])).rows[0];
    expect(row).toEqual({ created_by: 'repair', parent_version: 1, patch });
    // Une réparation partie de la v1 alors que la v2 est courante : enregistrée, jamais courante.
    expect(await saveRepairedStrategy(pool, { apiId: api, ownerId: A, parentVersion: 1, execution: 'fetch', network: 'direct', spec: {}, patch: null, estCostUsd: null })).toEqual({ version: 3, promoted: false });
    const apiRow = (await pool.query<{ current_strategy_version: number; output_schema: unknown }>('SELECT current_strategy_version, output_schema FROM apis WHERE id = $1', [api])).rows[0]!;
    expect(apiRow.current_strategy_version).toBe(2);
    expect(apiRow.output_schema).toEqual(SCHEMA);
  });

  test('sorties saines et volumes extraits (livrés + écartés) des runs réussis, lus comme le propriétaire', async () => {
    const api = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id) VALUES ('zz_test_healthy', $1) RETURNING id", [A])).rows[0]!.id;
    const run = (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, items, items_rejected, finished_at) VALUES ($1, $2, $2, 'rest', 'succeeded', 2, 1, now()) RETURNING id", [api, A])).rows[0]!.id;
    const ds = (await pool.query<{ id: string }>('INSERT INTO datasets (api_id, run_id, owner_id) VALUES ($1, $2, $3) RETURNING id', [api, run, A])).rows[0]!.id;
    await pool.query('UPDATE runs SET dataset_id = $2 WHERE id = $1', [run, ds]);
    await pool.query("INSERT INTO dataset_items (dataset_id, seq, run_id, owner_id, item, size_bytes) VALUES ($1, 0, $2, $3, '{\"titre\":\"a\"}', 12), ($1, 1, $2, $3, '{\"titre\":\"b\"}', 12)", [ds, run, A]);
    expect((await readHealthyItems(pool, { apiId: api, ownerId: A })).length).toBe(2);
    expect(await readHealthyItems(pool, { apiId: api, ownerId: C })).toEqual([]);
    expect(await readVolumeHistory(pool, { apiId: api, ownerId: A, input: null, excludeRunId: randomUUID() })).toEqual([3]);
  });

  test('migration 0018 : aller-retour down/up', async () => {
    // 0020 (2.12) puis 0019 (règles, 2.10) la suivent : trois pas en arrière pour retirer 0018.
    await migrateDown({ connectionString: tdb.url, steps: 3 });
    expect((await pool.query("SELECT to_regclass('public.run_rejected_items') AS t")).rows[0].t).toBeNull();
    expect((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'items_rejected'")).rowCount).toBe(0);
    await migrateUp({ connectionString: tdb.url });
    expect((await pool.query("SELECT to_regclass('public.run_rejected_items') AS t")).rows[0].t).toBe('run_rejected_items');
  });
});
