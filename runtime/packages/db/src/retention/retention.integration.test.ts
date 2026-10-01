// SPDX-License-Identifier: AGPL-3.0-only
// Rétention, garde disque, effacement et journaux sans donnée personnelle (tâche 1.8) sur base réelle.
// Horloge injectée : `NOW` est simulé, aucun sleep. Noms de test : table 15 § 12.
import { randomBytes, randomUUID } from 'node:crypto';
import { dedupKeyHash, filterExcludedItems, PersonalValueRegistry, secretValues, subjectHash, type JobQueue } from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { migrateUp } from '../migrate.js';
import { ensureDatasetItemsPartitions, listDatasetItemsPartitions } from '../partitions.js';
import { withActor } from '../rls.js';
import { appendRunLog } from '../run-logs.js';
import { createRun, finishRun, runQueueDefinition } from '../runs.js';
import {
  assertStorageAvailable,
  cleanupExpiredRunData,
  countSubjectOccurrences,
  eraseSubject,
  exportSubject,
  getStorageStatus,
  isSubjectExcluded,
  loadSubjectExclusions,
  markExpiredDatasets,
  purgeMarkedDatasets,
  resolveSubjectValues,
  RETENTION_LOCK_KEY,
  retentionPolicyFromEnv,
  runRetention,
  runRetentionTick,
  StorageFullError,
  SubjectErasureNotConfirmedError,
  SUBJECT_CONTENT_TABLES,
} from './index.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    email: { type: 'string', 'x-personal': 'identifier' },
    name: { type: 'string', 'x-personal': true },
    phone: { type: 'string', 'x-personal': true },
  },
};

let tdb: TestDatabase;
let pool: pg.Pool;
const OWNER = randomUUID();
const OTHER = randomUUID();
let apiId: string;
let otherApiId: string;

async function newDataset(opts: { created: Date; pinned?: boolean; pinnedUntil?: Date; retentionDays?: number; owner?: string; api?: string }): Promise<string> {
  const pinned = opts.pinned ?? false;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO datasets (api_id, owner_id, created_at, pinned, pinned_reason, pinned_until, retention_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [opts.api ?? apiId, opts.owner ?? OWNER, opts.created, pinned, pinned ? 'zz_test litige en cours' : null, pinned ? (opts.pinnedUntil ?? new Date('2027-12-31T00:00:00Z')) : null, opts.retentionDays ?? null],
  );
  return rows[0]!.id;
}
async function addItems(datasetId: string, at: Date, items: unknown[], runId: string | null = null, owner = OWNER, dedup?: (item: unknown) => string | null): Promise<void> {
  let seq = (await pool.query<{ n: number }>('SELECT coalesce(max(seq), 0)::int AS n FROM dataset_items WHERE dataset_id = $1', [datasetId])).rows[0]!.n;
  for (const item of items) {
    const json = JSON.stringify(item);
    await pool.query(
      'INSERT INTO dataset_items (created_at, dataset_id, seq, run_id, owner_id, item, size_bytes, dedup_key) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)',
      [at, datasetId, ++seq, runId, owner, json, json.length, dedup ? dedup(item) : null],
    );
  }
  await pool.query(
    'UPDATE datasets SET item_count = (SELECT count(*) FROM dataset_items WHERE dataset_id = $1), bytes = (SELECT coalesce(sum(size_bytes), 0) FROM dataset_items WHERE dataset_id = $1) WHERE id = $1',
    [datasetId],
  );
}
async function newRun(opts: { created: Date; state?: string; input?: unknown; errorDetail?: string | null; jobId?: string; owner?: string; api?: string }): Promise<string> {
  const owner = opts.owner ?? OWNER;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, input, error_detail, created_at, finished_at, job_id)
     VALUES ($1, $2, $2, 'rest', $3, $4::jsonb, $5, $6, $6, $7) RETURNING id`,
    [opts.api ?? apiId, owner, opts.state ?? 'failed', opts.input === undefined ? null : JSON.stringify(opts.input), opts.errorDetail ?? null, opts.created, opts.jobId ?? null],
  );
  return rows[0]!.id;
}
const count = async (sql: string, params: unknown[] = []) => Number((await pool.query<{ n: string }>(sql, params)).rows[0]!.n);
const partitionNames = async () => (await listDatasetItemsPartitions(pool)).map((p) => p.name);

/** Balayage SQL brut indépendant du code testé : lignes de toutes les tables du schéma public contenant un motif. */
async function rawOccurrences(needles: string[]): Promise<Record<string, number>> {
  const { rows: tables } = await pool.query<{ name: string }>(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname <> 'schema_migrations'`);
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    const n = await count(`SELECT count(*)::text AS n FROM "${name}" t WHERE to_jsonb(t)::text ILIKE ANY($1::text[])`, [needles.map((x) => `%${x}%`)]);
    if (n > 0) out[name] = n;
  }
  return out;
}

/** Effacement en deux temps imposé : `dry_run` (plan, confirmation), puis exécution confirmée. */
async function eraseConfirmed(req: Parameters<typeof eraseSubject>[1]) {
  const dry = await eraseSubject(pool, req, { dryRun: true });
  return { dry, report: await eraseSubject(pool, req, { confirm: dry.plan.confirmation }) };
}

beforeAll(async () => {
  tdb = await createTestDatabase('retention');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_owner@example.test', 'active'), ($2, 'zz_test_other@example.test', 'active')", [OWNER, OTHER]);
  apiId = (
    await pool.query<{ id: string }>(
      "INSERT INTO apis (slug, owner_id, output_schema, contains_personal_data) VALUES ('zz_test_api', $1, $2::jsonb, true) RETURNING id",
      [OWNER, JSON.stringify(OUTPUT_SCHEMA)],
    )
  ).rows[0]!.id;
  otherApiId = (
    await pool.query<{ id: string }>(
      "INSERT INTO apis (slug, owner_id, output_schema, contains_personal_data) VALUES ('zz_test_api_b', $1, $2::jsonb, true) RETURNING id",
      [OTHER, JSON.stringify(OUTPUT_SCHEMA)],
    )
  ).rows[0]!.id;
  // Partitions d'avril à octobre 2026 (mois courant simulé : octobre) ; novembre vient de ensure_partitions (tâche planifiée).
  await ensureDatasetItemsPartitions(pool, new Date('2026-04-01T00:00:00Z'), 7);
});

afterAll(async () => {
  await pool?.end();
  await tdb?.drop();
});

describe('assert_retention_purge', () => {
  let dsOld: string;
  let dsPinned: string;
  let dsExpiredMixed: string;
  let dsKeep: string;
  let runOld: string;

  beforeAll(async () => {
    // 2 datasets de plus de 90 jours : un épinglé (mai), un non (juin). Partition d'avril vide et révolue.
    dsPinned = await newDataset({ created: ago(158), pinned: true });
    await addItems(dsPinned, new Date('2026-05-10T10:00:00Z'), [{ title: 'pin-1' }, { title: 'pin-2' }]);
    dsOld = await newDataset({ created: ago(136) });
    await addItems(dsOld, new Date('2026-06-01T10:00:00Z'), [{ title: 'old-1' }, { title: 'old-2' }, { title: 'old-3' }]);
    // Partition de septembre mixte : un dataset expiré (retention_days = 10) et un dataset à conserver.
    dsExpiredMixed = await newDataset({ created: new Date('2026-09-01T00:00:00Z'), retentionDays: 10 });
    await addItems(dsExpiredMixed, new Date('2026-09-01T10:00:00Z'), [{ title: 'exp-1' }, { title: 'exp-2' }, { title: 'exp-3' }]);
    dsKeep = await newDataset({ created: new Date('2026-09-20T00:00:00Z') });
    await addItems(dsKeep, new Date('2026-09-20T10:00:00Z'), [{ title: 'keep-1' }, { title: 'keep-2' }]);
    // Un item « retrouvé inchangé » : la déduplication est rafraîchie, l'échéance du dataset ne bouge pas.
    await pool.query('INSERT INTO dedup_keys (api_id, key_hash, owner_id, last_seen) VALUES ($1, $2, $3, $4)', [apiId, 'h-old', OWNER, NOW]);

    // Données de runs à nettoyer (phase 3).
    runOld = await newRun({ created: ago(100), input: { q: 'zz_test' }, errorDetail: 'boom' });
    await pool.query("INSERT INTO run_logs (run_id, seq, owner_id, level, event, ts) VALUES ($1, 1, $2, 'info', 'e', $3)", [runOld, OWNER, ago(40)]);
    await pool.query("INSERT INTO run_artifacts (run_id, owner_id, kind, bytes, sensitivity, ciphertext, nonce, key_version, created_at) VALUES ($1, $2, 'trace', 1, '0', '\\x00', '\\x00', 1, $3)", [runOld, OWNER, ago(8)]);
    await pool.query("INSERT INTO investigation_events (run_id, seq, owner_id, kind, payload, at) VALUES ($1, 1, $2, 'sample', '{\"s\":1}', $3), ($1, 2, $2, 'step', '{\"html\":\"<p>x</p>\"}', $3)", [runOld, OWNER, ago(20)]);
    await pool.query('INSERT INTO dedup_keys (api_id, key_hash, owner_id, last_seen) VALUES ($1, $2, $3, $4)', [apiId, 'h-stale', OWNER, ago(120)]);
    await pool.query("INSERT INTO audit_events (at, actor_via, action, outcome) VALUES ($1, 'system', 'zz_test.old', 'success'), ($2, 'system', 'zz_test.recent', 'success')", [ago(400), ago(300)]);
  });

  test('phase 1 marque sans rien supprimer ; épinglé, récent et déjà marqué épargnés', async () => {
    const policy = retentionPolicyFromEnv({});
    const first = await markExpiredDatasets(pool, NOW, policy);
    expect(first.marked).toBe(2); // dsOld + dsExpiredMixed (retention_days = 10)
    const marked = (await pool.query<{ id: string }>('SELECT id FROM datasets WHERE deleted_at IS NOT NULL')).rows.map((r) => r.id).sort();
    expect(marked).toEqual([dsOld, dsExpiredMixed].sort());
    expect(await count('SELECT count(*)::text AS n FROM dataset_items')).toBe(10); // aucune suppression en phase 1
    expect((await markExpiredDatasets(pool, NOW, policy)).marked).toBe(0); // idempotente
    expect((await pool.query('SELECT 1 FROM datasets WHERE id = $1 AND deleted_at IS NULL', [dsPinned])).rowCount).toBe(1);
  });

  test('phase 2 reprenable : lots bornés, puis passe complète ; partitions révolues détachées puis supprimées', async () => {
    const partial = await purgeMarkedDatasets(pool, NOW, { batchSize: 2, maxBatches: 1 });
    expect(partial.complete).toBe(false); // arrêt simulé au milieu
    expect(await count('SELECT count(*)::text AS n FROM dataset_items')).toBeGreaterThan(4); // il en reste à purger
    const resumed = await purgeMarkedDatasets(pool, NOW, { batchSize: 2 });
    expect(resumed.complete).toBe(true);

    const parts = await partitionNames();
    expect(parts).not.toContain('dataset_items_p202606'); // dsOld : partition entière supprimée
    expect(parts).not.toContain('dataset_items_p202604'); // vide et révolue
    expect(parts).toContain('dataset_items_p202605'); // dsPinned y vit
    expect(parts).toContain('dataset_items_p202609'); // mixte : DELETE par lots, partition conservée
    expect(parts).toContain('dataset_items_p202610'); // mois courant
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = ANY($1::uuid[])', [[dsOld, dsExpiredMixed]])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = $1', [dsPinned])).toBe(2);
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = $1', [dsKeep])).toBe(2);
    // Tombstones (410) : lignes conservées, compteurs à zéro.
    const tomb = await pool.query<{ item_count: number; bytes: string; deleted_at: Date }>('SELECT item_count, bytes, deleted_at FROM datasets WHERE id = $1', [dsOld]);
    expect(tomb.rows[0]).toMatchObject({ item_count: 0, bytes: '0' });
    expect((await pool.query('SELECT item_count FROM datasets WHERE id = $1', [dsPinned])).rows[0]).toMatchObject({ item_count: 2 });
    // Idempotente.
    expect(await purgeMarkedDatasets(pool, NOW)).toMatchObject({ partitionsDropped: [], itemsDeleted: 0, datasetsPurged: 0 });
  });

  test('un item retrouvé inchangé ne repousse pas l’échéance du dataset', async () => {
    const { rows } = await pool.query<{ created_at: Date; deleted_at: Date | null; expires_at: Date | null }>('SELECT created_at, deleted_at, expires_at FROM datasets WHERE id = $1', [dsOld]);
    expect(rows[0]!.expires_at).toBeNull(); // aucune prolongation posée
    expect(rows[0]!.deleted_at).toEqual(NOW);
    // dedup_keys 'h-old' a été revu à NOW : cela n'a rien changé au sort du dataset.
    expect(await count("SELECT count(*)::text AS n FROM dedup_keys WHERE key_hash = 'h-old'")).toBe(1);
  });

  test('phase 3 : charges d’enquête (tout kind), error_detail, entrées, journaux, artefacts, runs, dedup_keys, audit > 12 mois', async () => {
    const recent = await newRun({ created: ago(2), input: { q: 'recent' }, errorDetail: 'recent boom' });
    await pool.query("INSERT INTO run_logs (run_id, seq, owner_id, level, event, ts) VALUES ($1, 1, $2, 'info', 'e', $3)", [recent, OWNER, ago(1)]);
    await pool.query("INSERT INTO investigation_events (run_id, seq, owner_id, kind, payload, at) VALUES ($1, 1, $2, 'probe', '{\"body\":\"récent\"}', $3)", [recent, OWNER, ago(1)]);
    const active = await newRun({ created: ago(200), state: 'running', input: { q: 'active' } });
    const policy = retentionPolicyFromEnv({});
    // Revue 1.8 point 10 : toute charge d'investigation_events de plus de 14 jours est vidée, quel que soit le kind ;
    // le squelette technique (run, seq, kind, at) reste jusqu'à la purge du run.
    const payloadsBefore = await count("SELECT count(*)::text AS n FROM investigation_events WHERE run_id = $1 AND payload <> '{}'::jsonb", [runOld]);
    expect(payloadsBefore).toBe(2);
    const r = await cleanupExpiredRunData(pool, NOW, policy);
    expect(r).toMatchObject({ investigation_payloads: 2, run_logs: 1, run_artifacts: 1, dedup_keys: 1, audit_events: 1 });
    expect(r.runs).toBe(1); // runOld (100 jours) ; le run actif n'est jamais purgé
    expect(await count('SELECT count(*)::text AS n FROM runs WHERE id = $1', [runOld])).toBe(0);
    expect(await count("SELECT count(*)::text AS n FROM investigation_events WHERE kind = 'step'")).toBe(0); // cascade avec le run
    expect((await pool.query('SELECT payload FROM investigation_events WHERE run_id = $1', [recent])).rows[0]).toEqual({ payload: { body: 'récent' } });
    expect((await pool.query('SELECT input, error_detail FROM runs WHERE id = $1', [recent])).rows[0]).toEqual({ input: { q: 'recent' }, error_detail: 'recent boom' });
    expect((await pool.query('SELECT input FROM runs WHERE id = $1', [active])).rows[0]).toEqual({ input: { q: 'active' } });
    expect(await count("SELECT count(*)::text AS n FROM audit_events WHERE action LIKE 'zz_test.%'")).toBe(1); // 300 jours : gardé
    // error_detail (14 j) et entrée de run : un run de 30 jours perd les deux mais reste (runs : 90 jours).
    const mid = await newRun({ created: ago(30), input: { q: 'mid' }, errorDetail: 'mid boom' });
    await cleanupExpiredRunData(pool, NOW, policy);
    expect((await pool.query('SELECT input, error_detail, state FROM runs WHERE id = $1', [mid])).rows[0]).toEqual({ input: null, error_detail: null, state: 'failed' });
  });

  test('jobs pg-boss terminés : rétention native de la file (deleteAfterSeconds) explicite', () => {
    const def = runQueueDefinition();
    expect(def.deleteAfterSeconds).toBeGreaterThan(0);
    expect(def.deleteAfterSeconds).toBeLessThanOrEqual(retentionPolicyFromEnv({}).logsDays * 86_400);
  });

  test('passe complète journalisée par table ; RETENTION_* de l’environnement ; plafond d’instance', async () => {
    expect(retentionPolicyFromEnv({ RETENTION_DATASETS_DAYS: '30', RETENTION_SAMPLES_DAYS: '7' })).toMatchObject({ datasetsDays: 30, samplesDays: 7 });
    expect(() => retentionPolicyFromEnv({ RETENTION_DATASETS_DAYS: '0' })).toThrow(/RETENTION_DATASETS_DAYS/);
    // Revue 1.8 point 11 : plafond d'instance réglable par l'environnement, jamais sous la durée par défaut.
    expect(retentionPolicyFromEnv({ RETENTION_DATASETS_MAX_DAYS: '365' })).toMatchObject({ datasetsMaxDays: 365 });
    expect(() => retentionPolicyFromEnv({ RETENTION_DATASETS_MAX_DAYS: '30' })).toThrow(/RETENTION_DATASETS_MAX_DAYS/);
    // dsKeep (25 jours) : expiré avec un plafond d'instance à 20 jours ; l'épinglé (jusqu'en 2027) reste.
    const capped = { ...retentionPolicyFromEnv({}), datasetsMaxDays: 20 };
    const report = await runRetention(pool, NOW, capped);
    expect(report.phase1.marked).toBe(1);
    expect(report.phase2.datasetsPurged).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = $1', [dsKeep])).toBe(0);
    const audit = await pool.query<{ meta: Record<string, unknown>; actor_via: string }>("SELECT meta, actor_via FROM audit_events WHERE action = 'retention.purge'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor_via).toBe('system');
    expect(audit.rows[0]!.meta).toMatchObject({ datasets_marked: 1, items_deleted: 2, rows_runs: 0 });
    // Le dataset épinglé a traversé toutes les passes.
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = $1', [dsPinned])).toBe(2);
    expect((await pool.query('SELECT deleted_at FROM datasets WHERE id = $1', [dsPinned])).rows[0]!.deleted_at).toBeNull();
  });

  test('épinglage = exemption datée et motivée (revue 1.8 point 11) : sans raison ni échéance refusé ; échéance passée, purgé', async () => {
    await expect(
      pool.query('INSERT INTO datasets (api_id, owner_id, pinned) VALUES ($1, $2, true)', [apiId, OWNER]),
    ).rejects.toThrow(/datasets_pinned_exemption_check/);
    const lapsed = await newDataset({ created: ago(200), pinned: true, pinnedUntil: ago(1) });
    expect((await markExpiredDatasets(pool, NOW, retentionPolicyFromEnv({}))).marked).toBe(1);
    expect((await pool.query('SELECT deleted_at FROM datasets WHERE id = $1', [lapsed])).rows[0]!.deleted_at).toEqual(NOW);
  });
});

describe('phase 2 : borne de durée et course avec l’épinglage (revue 1.8, points 5 et 20)', () => {
  test('échéance de 15 min par défaut, horloge injectée : arrêt entre deux lots, complete=false, reprise ensuite', async () => {
    const ds = await newDataset({ created: ago(300) });
    await addItems(ds, new Date('2026-10-02T10:00:00Z'), Array.from({ length: 20 }, (_, i) => ({ title: `slow-${i}` })));
    await pool.query('UPDATE datasets SET deleted_at = $1 WHERE id = $2', [NOW, ds]);
    let t = 0;
    const clock = () => (t += 60_000); // chaque lecture de l'horloge avance d'une minute (échéance : 15 min)
    const partial = await purgeMarkedDatasets(pool, NOW, { batchSize: 1, clock });
    expect(partial.complete).toBe(false);
    expect(partial.itemsDeleted).toBeGreaterThan(0);
    expect(partial.itemsDeleted).toBeLessThan(20);
    const short = await purgeMarkedDatasets(pool, NOW, { batchSize: 1, maxDurationMs: 0 });
    expect(short).toMatchObject({ complete: false, itemsDeleted: 0 });
    expect((await purgeMarkedDatasets(pool, NOW, { batchSize: 1 })).complete).toBe(true);
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = $1', [ds])).toBe(0);
  });

  test('un dataset épinglé entre la vérification et le DETACH : partition rattachée, rien n’est détruit', async () => {
    await ensureDatasetItemsPartitions(pool, new Date('2026-07-01T00:00:00Z'), 1);
    const ds = await newDataset({ created: new Date('2026-07-01T00:00:00Z') });
    await addItems(ds, new Date('2026-07-05T10:00:00Z'), [{ title: 'race-1' }, { title: 'race-2' }]);
    await pool.query('UPDATE datasets SET deleted_at = $1 WHERE id = $2', [NOW, ds]);
    const result = await purgeMarkedDatasets(pool, NOW, {
      afterDetach: async () => {
        await pool.query("UPDATE datasets SET deleted_at = NULL, pinned = true, pinned_reason = 'zz_test', pinned_until = '2027-01-01' WHERE id = $1", [ds]);
      },
    });
    expect(result.partitionsDropped).not.toContain('dataset_items_p202607');
    expect(await partitionNames()).toContain('dataset_items_p202607');
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = $1', [ds])).toBe(2);
  });
});

describe('planification de la purge (revue 1.8, point 7)', () => {
  test('marquage toutes les heures, suppression + nettoyage + ensure_partitions chaque jour, jamais deux passes à la fois', async () => {
    const policy = retentionPolicyFromEnv({});
    const t0 = new Date('2026-10-20T03:00:00Z');
    const first = await runRetentionTick(pool, t0, policy);
    expect(first).toMatchObject({ hourly: true, daily: true });
    expect(await partitionNames()).toContain('dataset_items_p202611'); // ensure_partitions : mois suivant créé
    expect(await runRetentionTick(pool, new Date(t0.getTime() + 30 * 60_000), policy)).toMatchObject({ hourly: false, daily: false });
    expect(await runRetentionTick(pool, new Date(t0.getTime() + 61 * 60_000), policy)).toMatchObject({ hourly: true, daily: false });
    // Une autre instance tient le verrou : la passe est sautée (pas de DETACH CONCURRENTLY concurrent).
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [RETENTION_LOCK_KEY]);
      expect(await runRetentionTick(pool, new Date(t0.getTime() + 25 * 3600_000), policy)).toMatchObject({ skipped: true });
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [RETENTION_LOCK_KEY]);
      holder.release();
    }
    expect(await runRetentionTick(pool, new Date(t0.getTime() + 25 * 3600_000), policy)).toMatchObject({ hourly: true, daily: true });
  });
});

describe('storage_full', () => {
  const GB = 1024 ** 3;
  const at = (pct: number) => ({ planGb: 10, measure: async () => (10 * GB * pct) / 100 });
  const stubQueue = (): { queue: JobQueue; sent: number } => {
    const state = { sent: 0 };
    const queue = { enqueue: async () => (state.sent += 1, 'job') } as unknown as JobQueue;
    return { queue, get sent() { return state.sent; } };
  };

  test('alerte à 80 %, refus à 95 % avec storage_full, seuils réglables, sans forfait pas de garde', async () => {
    expect((await getStorageStatus(pool, at(79.9))).state).toBe('ok');
    expect((await getStorageStatus(pool, at(80))).state).toBe('warning');
    expect((await assertStorageAvailable(pool, at(94.9))).state).toBe('warning');
    await expect(assertStorageAvailable(pool, at(95))).rejects.toMatchObject({ code: 'storage_full' });
    await expect(assertStorageAvailable(pool, at(95))).rejects.toBeInstanceOf(StorageFullError);
    expect((await assertStorageAvailable(pool, { ...at(96), fullPercent: 99 })).state).toBe('warning');
    await expect(getStorageStatus(pool, { ...at(10), warnPercent: 90, fullPercent: 80 })).rejects.toThrow(/seuils/);
    expect((await getStorageStatus(pool, { measure: async () => 10 ** 15 })).state).toBe('ok');
    expect((await getStorageStatus(pool)).usedBytes).toBeGreaterThan(0); // mesure réelle : pg_database_size
  });

  test('à 95 %, createRun lui-même refuse le run (revue 1.8 point 4) : ni run, ni job', async () => {
    const q = stubQueue();
    const runsBefore = await count('SELECT count(*)::text AS n FROM runs');
    await expect(
      withActor(pool, { userId: OWNER, role: 'member' }, (tx) => createRun(tx, q.queue, { apiId, ownerId: OWNER, trigger: 'rest' }, { storage: at(95) })),
    ).rejects.toMatchObject({ code: 'storage_full' });
    expect(await count('SELECT count(*)::text AS n FROM runs')).toBe(runsBefore);
    expect(q.sent).toBe(0);
    const ok = await withActor(pool, { userId: OWNER, role: 'member' }, (tx) => createRun(tx, q.queue, { apiId, ownerId: OWNER, trigger: 'rest' }, { storage: at(50) }));
    expect(ok.runId).toBeTruthy();
    expect(q.sent).toBe(1);
  });
});

describe('assert_erasure_complete', () => {
  const key = randomBytes(32);
  const actor = { userId: OWNER, via: 'ui' as const };
  const scope = { ownerId: OWNER };
  const ALICE = { title: 'Alice profile', email: 'alice.martin@example.test', name: 'Alice Martin', phone: '+33 6 12 34 56 78' };
  const ALICE_NATIONAL = { ...ALICE, title: 'Alice (forme nationale)', phone: '06 12 34 56 78' };
  const BOB = { title: 'Bob profile', email: 'bob.durand@example.test', name: 'Bob Durand', phone: '+33 7 98 76 54 32' };
  const values = [ALICE.email, ALICE.name, ALICE.phone];
  const needles = ['alice.martin@example.test', 'Alice Martin', '33612345678', '+33 6 12 34 56 78', '06 12 34 56 78', '0612345678', 'alice.martin'];
  const dedup = (item: unknown) => (item as { email?: string }).email ?? null;
  let datasets: string[];
  let erasedRun: string;
  let otherOwnerDs: string;

  beforeAll(async () => {
    // Une personne sur deux mois (septembre et octobre : deux partitions), dans 3 datasets, avec une autre personne ;
    // 1 échantillon, 1 erreur, 1 journal, 1 artefact, 1 clé de déduplication dérivée de son e-mail.
    const sept = new Date('2026-09-28T10:00:00Z');
    await ensureDatasetItemsPartitions(pool, sept, 2); // septembre a pu être purgé (vide) par les passes précédentes
    const oct = new Date('2026-10-10T10:00:00Z');
    datasets = [];
    erasedRun = await newRun({ created: oct, input: { query: 'Alice Martin' }, errorDetail: 'timeout pour alice.martin@example.test' });
    for (let i = 0; i < 3; i++) {
      const ds = await newDataset({ created: i === 0 ? sept : oct });
      await addItems(ds, i === 0 ? sept : oct, [i === 1 ? ALICE_NATIONAL : ALICE, BOB, { title: `autre ${i}`, email: `zz${i}@example.test`, name: 'Carole Petit', phone: '0102030405' }], i === 2 ? erasedRun : null, OWNER, dedup);
      datasets.push(ds);
    }
    await pool.query('INSERT INTO dedup_keys (api_id, key_hash, owner_id, last_seen) VALUES ($1, $2, $3, $4), ($1, $5, $3, $4)', [
      apiId,
      dedupKeyHash(key, ALICE.email),
      OWNER,
      oct,
      dedupKeyHash(key, BOB.email),
    ]);
    await pool.query("INSERT INTO investigation_events (run_id, seq, owner_id, kind, payload) VALUES ($1, 1, $2, 'sample', $3::jsonb)", [erasedRun, OWNER, JSON.stringify({ sample: { email: ALICE.email, note: 'vu chez "Alice Martin"' } })]);
    await pool.query("INSERT INTO run_logs (run_id, seq, owner_id, level, event, data) VALUES ($1, 1, $2, 'warn', 'fetch alice.martin@example.test', $3::jsonb)", [erasedRun, OWNER, JSON.stringify({ phone: ALICE_NATIONAL.phone, keep: 'rien' })]);
    await pool.query("INSERT INTO run_artifacts (run_id, owner_id, kind, bytes, sensitivity, ciphertext, nonce, key_version) VALUES ($1, $2, 'trace', 1, '0', '\\x00', '\\x00', 1)", [erasedRun, OWNER]);
    // Un autre run, sans lien avec la personne.
    const other = await newRun({ created: oct, input: { query: 'Carole' }, errorDetail: 'autre échec' });
    await pool.query("INSERT INTO run_artifacts (run_id, owner_id, kind, bytes, sensitivity, ciphertext, nonce, key_version) VALUES ($1, $2, 'trace', 1, '0', '\\x00', '\\x00', 1)", [other, OWNER]);
    // Un autre utilisateur détient aussi Alice : hors de la portée d'une demande limitée à OWNER.
    otherOwnerDs = await newDataset({ created: oct, owner: OTHER, api: otherApiId });
    await addItems(otherOwnerDs, oct, [ALICE], null, OTHER);
    // Un jeton d'authentification qui contient la chaîne : jamais compté par le balayage de l'outil.
    await pool.query("INSERT INTO verifications (identifier, value, expires_at) VALUES ('alice.martin@example.test', 'tok', now() + interval '1 day')");
  });

  test('resolveSubjectValues lit les valeurs identifiantes x-personal du schéma de sortie', async () => {
    expect((await resolveSubjectValues(pool, { datasetId: datasets[0]!, seq: 1 })).sort()).toEqual([...values].sort());
    expect(await resolveSubjectValues(pool, { datasetId: datasets[0]!, seq: 999 })).toEqual([]);
  });

  test('export_subject : contenu pour le propriétaire seulement ; un admin n’obtient que des métadonnées (revue 1.8 points 13 et 16)', async () => {
    const out = await exportSubject(pool, { values, key, actor, scope }, NOW);
    expect(out.dataset_items).toHaveLength(3);
    expect(out.dataset_items.every((i) => (i.item as { email: string }).email === ALICE.email)).toBe(true);
    expect(out.runs.map((r) => r.id)).toEqual([erasedRun]);
    expect(out.run_logs).toHaveLength(1);
    expect(out.investigation_events).toHaveLength(1);
    expect(out.run_artifacts).toHaveLength(1);
    expect(out.excluded).toBe(false);
    expect(out.subject_hashes).toContain(subjectHash(key, ALICE.email));

    const admin = { userId: randomUUID(), via: 'ui' as const, instanceAdmin: true };
    const meta = await exportSubject(pool, { values, key, actor: admin, scope: { instance: true } }, NOW);
    expect(meta.dataset_items).toHaveLength(4); // les deux propriétaires
    const text = JSON.stringify(meta);
    for (const forbidden of ['Bob', 'Carole', 'timeout', 'fetch ', 'vu chez']) expect(text).not.toContain(forbidden);
    expect(meta.dataset_items.every((i) => i.item === undefined && i.owner_id !== undefined)).toBe(true);
    // Non-admin : portée instance refusée.
    await expect(exportSubject(pool, { values, key, actor, scope: { instance: true } }, NOW)).rejects.toThrow(/portée/);
    const audit = await pool.query<{ actor_user_id: string; meta: Record<string, unknown> }>("SELECT actor_user_id, meta FROM audit_events WHERE action = 'subject.export' ORDER BY id");
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]!.actor_user_id).toBe(OWNER);
    expect(audit.rows[0]!.meta).toMatchObject({ values: 3, dataset_items: 3, content: true });
    expect(audit.rows[1]!.meta).toMatchObject({ content: false });
  });

  test('balayage de vérification : tables de contenu seulement, jamais auth_*, verifications ni audit (revue 1.8 point 16)', async () => {
    const counts = await countSubjectOccurrences(pool, values, { instance: true });
    expect(Object.keys(counts).every((t) => (SUBJECT_CONTENT_TABLES as readonly string[]).includes(t))).toBe(true);
    expect(counts['verifications']).toBeUndefined();
    expect(counts['dataset_items']).toBe(4);
    expect((await countSubjectOccurrences(pool, values, scope))['dataset_items']).toBe(3);
  });

  test('refuse un sujet vide, trop court, une date ou un booléen', async () => {
    for (const bad of [[], ['al'], ['Anne'], ['true'], ['2026-09-15'], [ALICE.email, 'true']]) {
      await expect(eraseSubject(pool, { values: bad, key, actor, scope }, { dryRun: true })).rejects.toThrow(/sujet refusé/);
    }
  });

  test('dry_run imposé : plan (datasets, propriétaires), rien n’est modifié ; sans confirmation valide, refus', async () => {
    const dry = await eraseSubject(pool, { values, key, actor, scope }, { dryRun: true });
    expect(dry).toMatchObject({ dry_run: true, dataset_items: 3, exclusions_added: 0 });
    expect(dry.plan.datasets.map((d) => d.dataset_id).sort()).toEqual([...datasets].sort());
    expect(dry.plan.owners).toEqual([OWNER]);
    expect(dry.plan.confirmation).toMatch(/^[0-9a-f]{16}$/);
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE item::text ILIKE $1', ['%alice.martin%'])).toBe(4);
    expect(await count('SELECT count(*)::text AS n FROM subject_exclusions')).toBe(0);
    await expect(eraseSubject(pool, { values, key, actor, scope })).rejects.toBeInstanceOf(SubjectErasureNotConfirmedError);
    await expect(eraseSubject(pool, { values, key, actor, scope }, { confirm: '0000000000000000' })).rejects.toBeInstanceOf(SubjectErasureNotConfirmedError);
    await expect(eraseSubject(pool, { values, key, actor, scope: { instance: true } }, { dryRun: true })).rejects.toThrow(/portée/);
  });

  test('erase_subject (+33) : deux mois, forme 06, dedup_keys : 0 occurrence en SQL brut ; autres personnes et autre propriétaire intacts', async () => {
    expect(Object.keys(await rawOccurrences(needles)).length).toBeGreaterThanOrEqual(4); // la fixture est bien partout
    const req = { values: [ALICE.email.toUpperCase(), ALICE.name, '+33.6.12.34.56.78'], key, actor, scope };
    const { report } = await eraseConfirmed(req);
    expect(report).toMatchObject({ dry_run: false, dataset_items: 3, dedup_keys: 1, run_artifacts: 1, exclusions_added: 3, residual: {} });

    // SQL brut sur tout le périmètre du propriétaire : items (deux partitions), dedup_keys, journaux, erreurs, échantillons.
    const left = await rawOccurrences(needles);
    expect(left).toEqual({ dataset_items: 1, verifications: 1 }); // l'item de l'autre propriétaire, le jeton d'auth
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = $1', [otherOwnerDs])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE owner_id = $1 AND item::text ~* $2', [OWNER, '06 12 34 56 78|\\+33 6 12'])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM dedup_keys WHERE key_hash = $1', [dedupKeyHash(key, ALICE.email)])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM dedup_keys WHERE key_hash = $1', [dedupKeyHash(key, BOB.email)])).toBe(1);

    const bobs = await count('SELECT count(*)::text AS n FROM dataset_items WHERE item::text ILIKE $1', ['%bob.durand%']);
    expect(bobs).toBe(3);
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = ANY($1::uuid[])', [datasets])).toBe(6);
    expect((await pool.query('SELECT item_count FROM datasets WHERE id = $1', [datasets[0]])).rows[0]).toMatchObject({ item_count: 2 });
    expect(await count('SELECT count(*)::text AS n FROM run_artifacts WHERE run_id = $1', [erasedRun])).toBe(0);
    expect(await count('SELECT count(*)::text AS n FROM run_artifacts')).toBeGreaterThanOrEqual(1); // l'artefact de l'autre run reste
    // Le journal et l'erreur existent toujours, privés de la personne (téléphone en forme nationale compris).
    const log = (await pool.query<{ event: string; data: { phone: string; keep: string } }>('SELECT event, data FROM run_logs WHERE run_id = $1', [erasedRun])).rows[0]!;
    expect(log.event).toBe('fetch [erased]');
    expect(log.data).toEqual({ phone: '[erased]', keep: 'rien' });
    expect((await pool.query('SELECT error_detail, input FROM runs WHERE id = $1', [erasedRun])).rows[0]).toEqual({ error_detail: 'timeout pour [erased]', input: { query: '[erased]' } });

    // Liste d'exclusion : HMAC, insensible à la casse et au format (06 ≡ +33) ; aucune valeur en clair.
    const excluded = await loadSubjectExclusions(pool);
    expect(excluded.size).toBe(3);
    expect(excluded.has(subjectHash(key, ALICE.email))).toBe(true);
    expect(await isSubjectExcluded(pool, key, '06 12 34 56 78')).toBe(true);
    expect(subjectHash(key, ALICE.email)).not.toBe(subjectHash(randomBytes(32), ALICE.email));

    // Tracé sans donnée personnelle.
    const audit = await pool.query<{ target_id: string }>("SELECT target_id FROM audit_events WHERE action = 'subject.erase'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.target_id).toHaveLength(16);
    const after = await exportSubject(pool, { values, key, actor, scope }, NOW);
    expect(after.excluded).toBe(true);
    expect(after.dataset_items).toEqual([]);
  });

  test('un run suivant ne réécrit pas la personne (filtre avant écriture) ; erase_subject est idempotent', async () => {
    const excluded = await loadSubjectExclusions(pool);
    const { kept, dropped } = filterExcludedItems(key, excluded, OUTPUT_SCHEMA, [ALICE, BOB, { ...ALICE_NATIONAL, email: 'autre@example.test' }]);
    expect(kept).toEqual([BOB]); // la troisième ligne garde le même nom et le même téléphone (forme 06) : exclue aussi
    expect(dropped).toBe(2);
    const { report } = await eraseConfirmed({ values, key, actor, scope });
    expect(report).toMatchObject({ dataset_items: 0, exclusions_added: 0 });
  });
});

describe('effacement : jamais au-delà du sujet (revue 1.8, points 1 et 15)', () => {
  const key = randomBytes(32);
  const SCHEMA = {
    type: 'object',
    properties: {
      author: { type: 'object', 'x-personal': true, properties: { name: { type: 'string' }, verified: { type: 'boolean' } } },
      published: { type: 'string', 'x-personal': true },
      in_stock: { type: 'boolean' },
      label: { type: 'string' },
    },
  };
  let apiA: string;
  let apiB: string;
  let dsA: string;
  let dsB: string;

  beforeAll(async () => {
    apiA = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, output_schema) VALUES ('zz_test_auth_a', $1, $2::jsonb) RETURNING id", [OWNER, JSON.stringify(SCHEMA)])).rows[0]!.id;
    apiB = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, output_schema) VALUES ('zz_test_auth_b', $1, $2::jsonb) RETURNING id", [OTHER, JSON.stringify(SCHEMA)])).rows[0]!.id;
    const at = new Date('2026-10-11T10:00:00Z');
    dsA = await newDataset({ created: at, api: apiA });
    await addItems(dsA, at, [
      { author: { name: 'Jean-Pierre Dupont', verified: true }, published: '2026-09-15' },
      { author: { name: 'Jeanne Martinez', verified: true }, published: '2026-09-15', label: 'annexe' },
      { author: { name: 'Anne Martin', verified: false }, label: 'x' },
    ]);
    dsB = await newDataset({ created: at, api: apiB, owner: OTHER });
    await addItems(dsB, at, [{ in_stock: true, label: 'p1' }, { in_stock: true, label: 'p2' }, { published: '2026-09-15', label: 'p3' }, { author: { name: 'Bob Marley-Durand', verified: true } }], null, OTHER);
  });

  test('objet x-personal avec booléen : seule la chaîne identifiante est retenue ; aucun item d’un autre utilisateur touché', async () => {
    const subject = await resolveSubjectValues(pool, { datasetId: dsA, seq: 1 });
    expect(subject).toEqual(['Jean-Pierre Dupont']);
    const before = await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = $1', [dsB]);
    const admin = { userId: null, via: 'system' as const };
    const dry = await eraseSubject(pool, { values: subject, key, actor: admin, scope: { instance: true } }, { dryRun: true });
    expect(dry.plan.owners).toEqual([OWNER]);
    const report = await eraseSubject(pool, { values: subject, key, actor: admin, scope: { instance: true } }, { confirm: dry.plan.confirmation });
    expect(report.dataset_items).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = $1', [dsB])).toBe(before);
    expect(await count('SELECT count(*)::text AS n FROM dataset_items WHERE dataset_id = $1', [dsA])).toBe(2);
    const excluded = await loadSubjectExclusions(pool);
    expect(excluded.has(subjectHash(key, 'true'))).toBe(false);
    expect(excluded.has(subjectHash(key, '2026-09-15'))).toBe(false);
    // Un item futur qui partage « true » et la date n'est pas filtré.
    expect(filterExcludedItems(key, excluded, SCHEMA, [{ author: { name: 'Zoé Lambert-Roux', verified: true }, published: '2026-09-15' }]).dropped).toBe(0);
  });

  test('prénom court refusé ; « Anne Martin » n’efface ni « Jeanne Martinez » ni « annexe »', async () => {
    await expect(eraseSubject(pool, { values: ['Anne'], key, actor: { userId: OWNER, via: 'ui' }, scope: { ownerId: OWNER } }, { dryRun: true })).rejects.toThrow(/sujet refusé/);
    const req = { values: ['Anne Martin'], key, actor: { userId: OWNER, via: 'ui' as const }, scope: { ownerId: OWNER } };
    const dry = await eraseSubject(pool, req, { dryRun: true });
    const report = await eraseSubject(pool, req, { confirm: dry.plan.confirmation });
    expect(report.dataset_items).toBe(1);
    const left = (await pool.query<{ item: { author?: { name: string }; label?: string } }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [dsA])).rows.map((r) => r.item);
    expect(left).toEqual([{ author: { name: 'Jeanne Martinez', verified: true }, published: '2026-09-15', label: 'annexe' }]);
  });
});

describe('assert_no_personal_data_in_logs', () => {
  const PERSON = { title: 'Fiche', email: 'claire.fontaine@example.test', name: 'Claire Fontaine', phone: '+33 6 55 44 33 22' };
  const patterns = ['claire.fontaine', 'Claire Fontaine', '6 55 44 33 22', '655443322'];

  test('journal et error_detail d’un run, registre du run : ni run_logs ni error_detail ne contiennent la personne', async () => {
    // Bout en bout avec un vrai worker : apps/worker/src/worker.integration.test.ts (registre par run, RunContext.personal).
    secretValues.add('sk-live-zz-test-0123456789');
    const personal = new PersonalValueRegistry();
    personal.addFromItem(OUTPUT_SCHEMA, PERSON); // l'exécuteur inscrit les valeurs x-personal des items extraits
    try {
      const jobId = randomUUID();
      const runId = await newRun({ created: NOW, state: 'running', jobId });
      const at = (seq: number, level: 'info' | 'warn' | 'error', event: string, data?: unknown) =>
        appendRunLog(pool, { runId, seq, ownerId: OWNER, level, event, data }, personal);
      await at(1, 'info', 'extract.item', { item: PERSON, index: 0 });
      await at(2, 'info', `extract ok pour ${PERSON.name}`, { contact: PERSON.email, 'Claire Fontaine': 1 });
      await at(3, 'warn', 'retry', { url: 'https://example.test/p?email=claire.fontaine%40example.test', phone: PERSON.phone });
      await at(4, 'error', 'validate.failed', { detail: `champ ${PERSON.phone} invalide pour ${PERSON.email} (Bearer sk-live-zz-test-0123456789)` });
      const closed = await finishRun(
        pool,
        runId,
        jobId,
        {
          state: 'failed',
          failure_class: 'extraction',
          retryable: false,
          error_detail: `extraction échouée : ${PERSON.name} <${PERSON.email}> ${PERSON.phone} ${'!'.repeat(3000)}`,
        } as Parameters<typeof finishRun>[3],
        { personal },
      );
      expect(closed).toBe(true);

      const logs = (await pool.query<{ t: string }>('SELECT to_jsonb(l)::text AS t FROM run_logs l WHERE run_id = $1', [runId])).rows.map((r) => r.t).join('\n');
      const detail = (await pool.query<{ error_detail: string }>('SELECT error_detail FROM runs WHERE id = $1', [runId])).rows[0]!.error_detail;
      for (const p of patterns) {
        expect(logs.toLowerCase()).not.toContain(p.toLowerCase());
        expect(detail.toLowerCase()).not.toContain(p.toLowerCase());
      }
      expect(logs).not.toContain('sk-live-zz-test-0123456789');
      expect(detail.length).toBeLessThanOrEqual(1001); // tronqué
      expect(logs).toContain('extract ok pour [PERSONAL]'); // les identifiants techniques, eux, restent
      expect(logs).toContain('retry');
      // Balayage SQL brut des deux puits, toutes lignes du run.
      const raw = await rawOccurrences(patterns);
      expect(Object.keys(raw).filter((t) => t === 'run_logs' || t === 'runs')).toEqual([]);
    } finally {
      personal.clear();
      secretValues.delete('sk-live-zz-test-0123456789');
    }
  });
});
