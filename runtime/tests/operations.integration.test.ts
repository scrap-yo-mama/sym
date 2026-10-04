// SPDX-License-Identifier: AGPL-3.0-only
// Épreuves d'exploitation (4.6, 14 § 6 et § 8) sur de vraies bases PostgreSQL et le vrai `server` :
//   assert_backup_restore_roundtrip : pg_dump puis pg_restore sur un AUTRE cluster, même MASTER_KEY, même catalogue ;
//   assert_upgrade_n_minus_1        : instance N-1 peuplée, `runtime migrate`, `/api/ready` = 200, rien de perdu ;
//   assert_rollback_restores_state  : image N-1 sur schéma N refusée, puis image N-1 + restauration = état d'avant.
// « Image N-1 » = code qui n'attend que la version de schéma N-1 (expectedSchemaVersion surchargé), base N-1 = les
// migrations livrées moins la dernière : tant qu'aucune version n'est publiée, c'est le seul N-1 qui existe.
import { loadKeyring, MasterKey, generateMasterKey } from '@runtime/core';
import type * as dbModule from '@runtime/db';
import { createDb, keyCheck, loadMigrations, migrateUp, secretStore, withActor, currentSchemaVersion } from '@runtime/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test, vi } from 'vitest';
import { run } from '../apps/cli/src/cli.js';
import { prepareServer } from '../apps/server/src/start.js';
import { dumpDatabase, restoreDatabase } from './helpers/docker-pg.js';
import { seedInstance, type SeededInstance } from './helpers/ops-seed.js';
import { columnsSnapshot, createTestDatabase, dataSnapshot, schemaSnapshot, withClient, type TestDatabase } from './helpers/pg.js';

const override = vi.hoisted(() => ({ expected: undefined as number | undefined }));
vi.mock('@runtime/db', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof dbModule;
  return { ...actual, expectedSchemaVersion: (...args: Parameters<typeof actual.expectedSchemaVersion>) => override.expected ?? actual.expectedSchemaVersion(...args) };
});

const PUBLIC_URL = 'https://runtime.example.test';
const migrations = loadMigrations();
const N = migrations.length;
const containerId = inject('pgContainerId');
const log = () => {};

const serverEnv = (url: string, masterKey: string): NodeJS.ProcessEnv => ({ DATABASE_URL: url, MASTER_KEY: masterKey, PUBLIC_URL });

/** Démarre le vrai `server`, lit /api/ready et /api/health, l'arrête. */
async function readyStatus(url: string, masterKey: string, schemaExpectedByCode?: number): Promise<{ ready: number; health: number; body: unknown }> {
  override.expected = schemaExpectedByCode;
  try {
    const started = await prepareServer(serverEnv(url, masterKey));
    try {
      const ready = await started.app.inject({ method: 'GET', url: '/api/ready' });
      const health = await started.app.inject({ method: 'GET', url: '/api/health' });
      return { ready: ready.statusCode, health: health.statusCode, body: ready.json() };
    } finally {
      await started.close();
    }
  } finally {
    override.expected = undefined;
  }
}

async function secretsReadable(url: string, masterKey: string, expected: Map<string, string>): Promise<void> {
  const keyring = { current: MasterKey.parse(masterKey) };
  await withClient(url, async (c) => {
    const store = secretStore(c, keyring, await keyCheck(c, keyring));
    for (const [id, value] of expected) expect((await store.get(id)).reveal()).toBe(value);
  });
}

/** Épinglage d'un dataset après montée : la migration 0009 donne une raison et 90 jours aux épinglages antérieurs. */
async function expectPinnedExemption(url: string, pinned: SeededInstance['pinned']): Promise<void> {
  const row = await withClient(url, async (c) => (await c.query<{ pinned: boolean; pinned_reason: string | null; pinned_until: Date | null }>(
    'SELECT pinned, pinned_reason, pinned_until FROM datasets WHERE id = $1', [pinned.datasetId])).rows[0]);
  expect(row?.pinned).toBe(true);
  expect(row?.pinned_reason).toBe(pinned.backfilledByMigration ? 'épinglé avant 0009' : pinned.reason);
  const days = ((row?.pinned_until?.getTime() ?? 0) - Date.now()) / 86_400_000;
  if (pinned.backfilledByMigration) expect(days).toBeGreaterThan(89.9);
  expect(days).toBeGreaterThan(29.9);
  expect(days).toBeLessThan(90.1);
}

/**
 * Chemins de données VOULUS de la dernière migration, exclus du « 0 perte » et vérifiés à part : 0026_no_run_cap (D-123)
 * passe l'ancien défaut 0,5 de `apis.max_cost_usd` à NULL (aucun plafond par run). Sans effet dès qu'une migration suit.
 */
const LAST_MIGRATION_DATA_PATHS: Record<string, Record<string, readonly string[]>> = { no_run_cap: { apis: ['max_cost_usd'] } };
const lastDataPaths = LAST_MIGRATION_DATA_PATHS[migrations.at(-1)!.name] ?? {};

function withoutDataPaths(columns: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(columns).map(([t, cs]) => [t, cs.filter((c) => !(lastDataPaths[t] ?? []).includes(c))]));
}

/** Chemin de données de 0026 : les API à l'ancien défaut (toutes celles de l'instance N-1 peuplée) n'ont plus de plafond. */
async function expectLastMigrationDataPath(url: string): Promise<void> {
  if (migrations.at(-1)!.name !== 'no_run_cap') return;
  const row = await withClient(url, async (c) => (await c.query<{ total: number; capped: number }>('SELECT count(*)::int AS total, count(max_cost_usd)::int AS capped FROM apis')).rows[0]);
  expect(row?.total).toBeGreaterThan(0);
  expect(row?.capped).toBe(0);
}

const apiState = (url: string) =>
  withClient(url, async (c) =>
    (await c.query('SELECT id, slug, status, status_reason, current_strategy_version, clean_streak FROM apis ORDER BY id')).rows,
  );

describe(`sauvegarde et restauration sur un autre cluster (PostgreSQL ${inject('pgVersion')})`, () => {
  let other: StartedPostgreSqlContainer;
  const key = generateMasterKey();
  let source: TestDatabase;
  let seeded: SeededInstance;
  let dump: Buffer;

  beforeAll(async () => {
    other = await new PostgreSqlContainer(`postgres:${inject('pgVersion')}`).start();
    source = await createTestDatabase('bkp');
    expect((await run(['migrate'], { env: { DATABASE_URL: source.url }, log })).code).toBe(0);
    seeded = await seedInstance(source.url, loadKeyring({ DATABASE_URL: source.url, MASTER_KEY: key }));
    dump = dumpDatabase(containerId, source.name);
  }, 180_000);
  afterAll(async () => {
    await source.drop();
    await other.stop();
  });

  const newDatabaseOnOtherCluster = async (name: string): Promise<string> => {
    const admin = new pg.Client({ connectionString: other.getConnectionUri() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    const url = new URL(other.getConnectionUri());
    url.pathname = `/${name}`;
    return url.toString();
  };

  // Restauration « naïve » (sans `restore-prepare`) : créée au premier besoin, une seule fois, pour que chaque test qui
  // s'en sert soit indépendant de l'ordre et de `-t`.
  let naive: Promise<{ url: string; restored: ReturnType<typeof restoreDatabase> }> | undefined;
  const naiveRestore = () =>
    (naive ??= (async () => {
      const url = await newDatabaseOnOtherCluster('restore_naive');
      return { url, restored: restoreDatabase(other.getId(), 'restore_naive', dump) };
    })());

  test('piège documenté : pg_restore seul sur un cluster neuf perd le rôle `runtime_app` ; doctor le signale (app_role_missing)', async () => {
    const { url, restored } = await naiveRestore();
    expect(restored.status).not.toBe(0);
    expect(restored.stderr).toMatch(/runtime_app/);
    const doctor = JSON.parse((await run(['doctor', '--json'], { env: serverEnv(url, key) })).out) as { exitCode: number; checks: { id: string; code: string; message: string }[] };
    expect(doctor.exitCode).toBe(2);
    const role = doctor.checks.find((c) => c.id === 'app_role');
    expect(role).toMatchObject({ code: 'app_role_missing' });
    expect(role?.message).toMatch(/runtime restore-prepare.*AVANT `pg_restore`/);
    const { pool } = createDb(url, 2);
    try {
      await expect(withActor(pool, { userId: seeded.memberId, role: 'member' }, async () => 1)).rejects.toThrow(/runtime_app/);
    } finally {
      await pool.end();
    }
  });

  test('assert_backup_restore_roundtrip : mêmes données, même schéma, un secret se déchiffre, l\'instance démarre sans autre réglage', async () => {
    // Procédure documentée (docs/exploitation.md) : base vide, `runtime restore-prepare` (recrée le rôle de cluster
    // `runtime_app` qu'un pg_dump n'emporte pas), puis la commande pg_restore du CDC (14 § 8), telle quelle.
    const url = await newDatabaseOnOtherCluster('restore_ok');
    expect(await run(['restore-prepare'], { env: { DATABASE_URL: url }, log })).toMatchObject({ code: 0, out: expect.stringContaining('rôle runtime_app créé') });
    const restored = restoreDatabase(other.getId(), 'restore_ok', dump);
    expect(restored, restored.stderr).toMatchObject({ status: 0 });

    expect(await withClient(url, dataSnapshot)).toEqual(await withClient(source.url, dataSnapshot));
    expect(await withClient(url, schemaSnapshot)).toEqual(await withClient(source.url, schemaSnapshot));
    const counts = await withClient(url, async (c) => ({
      apis: (await c.query('SELECT count(*)::int AS n FROM apis')).rows[0].n,
      runs: (await c.query('SELECT count(*)::int AS n FROM runs')).rows[0].n,
      secrets: (await c.query('SELECT count(*)::int AS n FROM secrets')).rows[0].n,
      items: (await c.query('SELECT count(*)::int AS n FROM dataset_items')).rows[0].n,
    }));
    expect(counts).toEqual({ apis: 5, runs: 10, secrets: 3, items: 5 });

    // Même MASTER_KEY, nouvelle DATABASE_URL : les secrets s'ouvrent et l'instance est prête.
    await secretsReadable(url, key, seeded.secrets);
    const started = await prepareServer(serverEnv(url, key));
    try {
      expect((await started.app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(200);
      // La RLS est intacte : un membre ne voit que ses API (rôle et droits restaurés).
      const { pool } = createDb(url, 2);
      try {
        const visible = await withActor(pool, { userId: seeded.memberId, role: 'member' }, async (c) => (await c.query('SELECT slug FROM apis ORDER BY slug')).rows.map((r) => r.slug));
        expect(visible).toEqual(['zz_test_api_1', 'zz_test_api_3']);
      } finally {
        await pool.end();
      }
    } finally {
      await started.close();
    }
    // Un autre MASTER_KEY ne démarre pas : sans la clé, les secrets sont définitivement illisibles.
    await expect(prepareServer(serverEnv(url, generateMasterKey()))).rejects.toThrow(/MASTER_KEY ne correspond pas à cette base/);
    // doctor sur la base restaurée : aucune erreur.
    const doctor = JSON.parse((await run(['doctor', '--json'], { env: serverEnv(url, key) })).out) as { checks: { id: string; status: string }[] };
    expect(doctor.checks.filter((c) => c.status === 'error')).toEqual([]);
  });

  test('base restaurée sans `restore-prepare`, rôle recréé après coup : doctor signale les droits manquants (app_role_no_grants)', async () => {
    const { url } = await naiveRestore();
    expect((await run(['restore-prepare'], { env: { DATABASE_URL: url }, log })).out).toMatch(/rôle runtime_app (créé|déjà présent)/);
    const doctor = JSON.parse((await run(['doctor', '--json'], { env: serverEnv(url, key) })).out) as { checks: { id: string; code: string; message: string }[] };
    const role = doctor.checks.find((c) => c.id === 'app_role');
    expect(role).toMatchObject({ code: 'app_role_no_grants' });
    expect(role?.message).toMatch(/recommencez la restauration sur une base vide/);
  });
});

describe(`mise à jour N-1 → N et retour arrière (PostgreSQL ${inject('pgVersion')})`, () => {
  const key = generateMasterKey();
  let db: TestDatabase;
  let reference: TestDatabase;
  let seeded: SeededInstance;
  let preMigrationDump: Buffer;
  let before: { data: Record<string, string>; apis: unknown[] };
  // Une migration peut remplir une colonne qu'elle ajoute (0009 : épinglage) : « 0 perte » se juge sur les colonnes de N-1.
  let projection: Record<string, string[]>;
  const dataN1 = (c: pg.Client) => dataSnapshot(c, projection);
  const cleanup: TestDatabase[] = [];

  beforeAll(async () => {
    expect(N).toBeGreaterThanOrEqual(2);
    db = await createTestDatabase('upg');
    reference = await createTestDatabase('upgref');
    await migrateUp({ connectionString: reference.url, migrations: migrations.slice(0, -1) });
    // Instance N-1 : schéma sans la dernière migration, API saines, 10 runs, 3 secrets.
    await migrateUp({ connectionString: db.url, migrations: migrations.slice(0, -1) });
    seeded = await seedInstance(db.url, loadKeyring({ DATABASE_URL: db.url, MASTER_KEY: key }));
    projection = withoutDataPaths(await withClient(reference.url, columnsSnapshot));
    before = { data: await withClient(db.url, dataN1), apis: await apiState(db.url) };
    // Point 2 de la procédure (14 § 6) : sauvegarde juste avant la migration.
    preMigrationDump = dumpDatabase(containerId, db.name);
  }, 180_000);
  afterAll(async () => {
    for (const d of [...cleanup, db, reference]) await d.drop();
  });

  test('l\'instance N-1 tourne sur son schéma', async () => {
    expect(await withClient(db.url, (c) => currentSchemaVersion(c))).toBe(N - 1);
    expect(await readyStatus(db.url, key, N - 1)).toMatchObject({ ready: 200, health: 200 });
  });

  test('assert_upgrade_n_minus_1 : `runtime migrate` puis /api/ready = 200, API saines inchangées, 0 perte, secrets lisibles', async () => {
    // Le code N sur la base N-1 démarre en mode dégradé (14 § 5) : /api/health 200, /api/ready 503 (schéma en retard), aucune
    // route d'API tant que `runtime migrate` n'est pas passé.
    expect(await readyStatus(db.url, key)).toMatchObject({ ready: 503, health: 200, body: { status: 'not_ready', checks: { database: true, schema: false } } });
    expect(await run(['migrate'], { env: { DATABASE_URL: db.url }, log })).toEqual({ code: 0, out: 'migrate : 1 migration(s) appliquée(s)' });
    expect(await withClient(db.url, (c) => currentSchemaVersion(c))).toBe(N);

    expect(await readyStatus(db.url, key)).toMatchObject({ ready: 200, health: 200, body: { status: 'ready', initialized: true } });
    const apis = await apiState(db.url);
    expect(apis).toEqual(before.apis);
    expect((apis as { status: string }[]).filter((a) => a.status === 'sain')).toHaveLength(seeded.apiIds.healthy.length);
    const counts = await withClient(db.url, async (c) => ({
      runs: (await c.query('SELECT count(*)::int AS n FROM runs')).rows[0].n,
      ids: (await c.query('SELECT id FROM runs ORDER BY id')).rows.map((r) => r.id),
    }));
    expect(counts.runs).toBe(10);
    expect(counts.ids).toEqual([...seeded.runIds].sort());
    expect(await withClient(db.url, dataN1)).toEqual(before.data);
    await secretsReadable(db.url, key, seeded.secrets);
    // Chemin de données de la migration (UPDATE ... WHERE pinned) : l'épinglage reçoit sa raison et son échéance.
    await expectPinnedExemption(db.url, seeded.pinned);
    await expectLastMigrationDataPath(db.url);
    const doctor = JSON.parse((await run(['doctor', '--json'], { env: serverEnv(db.url, key) })).out) as { checks: { id: string; status: string; code: string }[] };
    expect(doctor.checks.filter((c) => c.status === 'error')).toEqual([]);
    expect(doctor.checks.find((c) => c.id === 'schema')?.code).toBe('schema_ok');
  });

  test('assert_rollback_restores_state : image N-1 sur schéma N refusée ; image N-1 + restauration = état d\'avant', async () => {
    // 1. L'image précédente seule ne démarre pas : pas de migration descendante en production.
    await expect(readyStatus(db.url, key, N - 1)).rejects.toThrow(/plus ancienne que la base.*restaurez la sauvegarde/);
    const down = await run(['migrate', 'down'], { env: { DATABASE_URL: db.url, NODE_ENV: 'production' }, log });
    expect(down.code).toBe(2);
    expect(down.out).toMatch(/refusé en production.*image précédente \+ restauration/);
    const guarded = JSON.parse((await run(['doctor', '--json'], { env: serverEnv(db.url, key) })).out) as { checks: { id: string; code: string }[] };
    expect(guarded.checks.find((c) => c.id === 'schema')?.code).toBe('schema_ok');

    // 2. Restauration de la sauvegarde du point 2 dans une base neuve, puis image N-1 dessus.
    const restored = await createTestDatabase('upgrb');
    cleanup.push(restored);
    const result = restoreDatabase(containerId, restored.name, preMigrationDump);
    expect(result, result.stderr).toMatchObject({ status: 0 });
    expect(await withClient(restored.url, (c) => currentSchemaVersion(c))).toBe(N - 1);
    expect(await readyStatus(restored.url, key, N - 1)).toMatchObject({ ready: 200, health: 200 });
    expect(await withClient(restored.url, dataN1)).toEqual(before.data);
    expect(await apiState(restored.url)).toEqual(before.apis);
    expect(await withClient(restored.url, schemaSnapshot)).toEqual(await withClient(reference.url, schemaSnapshot));
    await secretsReadable(restored.url, key, seeded.secrets);

    // 3. Correction vers l'avant : la base restaurée remonte en N sans perte.
    expect((await run(['migrate'], { env: { DATABASE_URL: restored.url }, log })).code).toBe(0);
    expect(await readyStatus(restored.url, key)).toMatchObject({ ready: 200 });
    expect(await withClient(restored.url, dataN1)).toEqual(before.data);
    await expectPinnedExemption(restored.url, seeded.pinned);
    await expectLastMigrationDataPath(restored.url);
  });
});
