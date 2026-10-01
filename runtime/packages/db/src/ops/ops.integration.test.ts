// SPDX-License-Identifier: AGPL-3.0-only
// Exploitation sur base réelle (4.6, 14 § 7-8) : `doctor` (lecture seule, locale), `diagnostics` masqué
// (assert_diagnostics_redacted, INV9), export du catalogue sans secret (INV8).
import { generateMasterKey, loadKeyring, secretValues } from '@runtime/core';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { canary, seedInstance, type SeededInstance } from '../../../../tests/helpers/ops-seed.js';
import { createTestDatabase, withClient, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { dbTarget, spyOnSockets } from '../../../../tests/helpers/socket-spy.js';
import { loadMigrations, MIGRATIONS_DIR, migrateUp } from '../migrate.js';
import { declareBackup } from './backup.js';
import { exportCatalog } from './catalog.js';
import { buildDiagnostics, buildOfflineDiagnostics } from './diagnostics.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import { ensureAppRole } from './roles.js';

const HTTPS = 'https://runtime.example.test';
let tdb: TestDatabase;
let masterKey: string;
let seeded: SeededInstance;
let client: pg.Client;
const migrations = loadMigrations();

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: tdb.url, MASTER_KEY: masterKey, PUBLIC_URL: HTTPS, ...extra });
const byId = (report: DoctorReport, id: string) => report.checks.find((c) => c.id === id);

beforeAll(async () => {
  masterKey = generateMasterKey();
  tdb = await createTestDatabase('ops');
  await migrateUp({ connectionString: tdb.url });
  client = new pg.Client({ connectionString: tdb.url });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await tdb.drop();
});

describe(`runtime doctor (PostgreSQL ${inject('pgVersion')})`, () => {
  test('base neuve : lecture seule, aucun appel hors de la base, avertissements attendus et aucune erreur', async () => {
    const spy = spyOnSockets();
    let report: DoctorReport;
    try {
      report = await runDoctor({ env: env() });
    } finally {
      spy.stop();
    }
    expect(new Set(spy.targets().map((t) => t.replace('localhost', '127.0.0.1')))).toEqual(new Set([dbTarget(tdb.url).replace('localhost', '127.0.0.1')]));
    expect(spy.fetchCalls()).toBe(0);
    expect(report.checks.filter((c) => c.status === 'error')).toEqual([]);
    expect(report.checks.filter((c) => c.status === 'warn').map((c) => c.code).sort()).toEqual(['backup_never', 'no_worker']);
    expect(report.exitCode).toBe(1);
    expect(byId(report, 'key_check')?.code).toBe('key_check_pending');
    // Lecture seule : doctor n'a pas créé le témoin de clé.
    expect((await client.query('SELECT count(*)::int AS n FROM settings')).rows[0].n).toBe(0);
  });

  test('instance saine : tout est ok, code 0, rapport complet dans l\'ordre du catalogue', async () => {
    seeded = await seedInstance(tdb.url, loadKeyring(env()));
    await client.query("INSERT INTO worker_heartbeats (worker_id, version) VALUES ('zz_test_worker_1', '0.0.0')");
    await declareBackup(client, new Date(), new Date());
    const report = await runDoctor({ env: env() });
    expect(report.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      'database:ok', 'pooler:ok', 'postgres_version:ok', 'schema:ok', 'app_role:ok', 'key_check:ok', 'secrets:ok',
      'connections:ok', 'workers:ok', 'storage:ok', 'backup:ok', 'public_url:ok', 'bootstrap_token:ok',
    ]);
    expect(report.exitCode).toBe(0);
    expect(byId(report, 'key_check')?.message).toMatch(/clé vérifiée \(empreinte [0-9a-f-]+, version 1\)/);
    expect(JSON.stringify(report)).not.toContain(masterKey);
  });

  test('mauvaise MASTER_KEY : erreur key_mismatch avec les deux empreintes et la sortie de secours, jamais la clé', async () => {
    const other = generateMasterKey();
    const report = await runDoctor({ env: env({ MASTER_KEY: other }) });
    expect(byId(report, 'key_check')).toMatchObject({ status: 'error', code: 'key_mismatch' });
    expect(byId(report, 'key_check')?.message).toContain('runtime secrets accept-key-loss --confirm');
    expect(report.exitCode).toBe(2);
    expect(JSON.stringify(report)).not.toContain(other);
    expect(JSON.stringify(report)).not.toContain(masterKey);
  });

  test('MASTER_KEY invalide : le message nomme `runtime keygen`', async () => {
    const report = await runDoctor({ env: env({ MASTER_KEY: 'trop-court' }) });
    expect(byId(report, 'key_check')).toMatchObject({ status: 'error', code: 'master_key_invalid' });
    expect(byId(report, 'key_check')?.message).toMatch(/keygen/);
  });

  test('schéma en retard ou en avance sur le code : erreur nommant la sortie (migrer, ou restaurer)', async () => {
    const behind = await runDoctor({ env: env(), expectedSchema: migrations.length + 1 });
    expect(byId(behind, 'schema')).toMatchObject({ status: 'error', code: 'schema_behind' });
    expect(byId(behind, 'schema')?.message).toMatch(/runtime migrate/);
    expect(behind.checks.map((c) => c.id)).toEqual(['database', 'pooler', 'postgres_version', 'schema', 'public_url']);
    const ahead = await runDoctor({ env: env(), expectedSchema: migrations.length - 1 });
    expect(byId(ahead, 'schema')).toMatchObject({ status: 'error', code: 'schema_ahead' });
    expect(byId(ahead, 'schema')?.message).toMatch(/restaurez la sauvegarde/);
  });

  test('budget de connexions : DB_POOL_MAX démesuré refusé ; WORKER_CONCURRENCY au-dessus du pool refusé', async () => {
    expect(byId(await runDoctor({ env: env({ DB_POOL_MAX: '500' }) }), 'connections')).toMatchObject({ status: 'error', code: 'budget_exceeded' });
    expect(byId(await runDoctor({ env: env({ DB_POOL_MAX: '3', WORKER_CONCURRENCY: '4' }) }), 'connections')).toMatchObject({
      status: 'error',
      code: 'concurrency_above_pool',
    });
    expect(byId(await runDoctor({ env: env({ DB_POOL_MAX: 'x' }) }), 'connections')).toMatchObject({ code: 'db_pool_max_invalid' });
  });

  test('taille du plan : 80 % avertit, 95 % refuse, sans plan pas de garde', async () => {
    const { rows } = await client.query<{ b: string }>('SELECT pg_database_size(current_database())::text AS b');
    const gib = Number(rows[0]!.b) / 1024 ** 3;
    expect(byId(await runDoctor({ env: env() }), 'storage')?.code).toBe('storage_unguarded');
    expect(byId(await runDoctor({ env: env({ STORAGE_PLAN_GB: String(gib / 0.85) }) }), 'storage')).toMatchObject({ status: 'warn', code: 'storage_80' });
    expect(byId(await runDoctor({ env: env({ STORAGE_PLAN_GB: String(gib / 0.97) }) }), 'storage')).toMatchObject({ status: 'error', code: 'storage_full' });
    expect(byId(await runDoctor({ env: env({ STORAGE_PLAN_GB: String(gib / 0.5) }) }), 'storage')).toMatchObject({ status: 'ok', code: 'storage_ok' });
    expect(byId(await runDoctor({ env: env({ STORAGE_PLAN_GB: '-3' }) }), 'storage')?.code).toBe('storage_plan_invalid');
  });

  test('sauvegarde déclarée trop ancienne, workers morts, jeton d\'amorçage resté, URL publique en HTTP : avertissements', async () => {
    await declareBackup(client, new Date(Date.now() - 10 * 86_400_000), new Date());
    await client.query("UPDATE worker_heartbeats SET last_seen_at = now() - interval '2 minutes'");
    const report = await runDoctor({ env: env({ ADMIN_BOOTSTRAP_TOKEN: 'x'.repeat(40), PUBLIC_URL: 'http://runtime.example.test' }) });
    expect(byId(report, 'backup')).toMatchObject({ status: 'warn', code: 'backup_old' });
    expect(byId(report, 'workers')).toMatchObject({ status: 'warn', code: 'no_worker' });
    expect(byId(report, 'bootstrap_token')).toMatchObject({ status: 'warn', code: 'bootstrap_token_set' });
    expect(byId(report, 'public_url')).toMatchObject({ status: 'warn', code: 'public_url_http' });
    expect(JSON.stringify(report)).not.toContain('xxxxxxxxxx');
    expect(byId(await runDoctor({ env: env({ PUBLIC_URL: 'http://localhost:3000' }) }), 'public_url')?.status).toBe('ok');
    await client.query('UPDATE worker_heartbeats SET last_seen_at = now()');
    await declareBackup(client, new Date(), new Date());
  });

  test('secrets illisibles : avertissement « À ressaisir »', async () => {
    await client.query("UPDATE secrets SET state = 'unreadable' WHERE id = (SELECT id FROM secrets ORDER BY id LIMIT 1)");
    expect(byId(await runDoctor({ env: env() }), 'secrets')).toMatchObject({ status: 'warn', code: 'secrets_unreadable' });
    await client.query("UPDATE secrets SET state = 'ok'");
  });

  test('pooler en mode transaction sans URL directe : erreur, sans connexion ; base injoignable : erreur claire', async () => {
    const spy = spyOnSockets();
    try {
      const pooled = await runDoctor({ env: { DATABASE_URL: 'postgres://u:motdepasse-secret@aws-0.pooler.supabase.com:6543/postgres', MASTER_KEY: masterKey } });
      expect(byId(pooled, 'pooler')).toMatchObject({ status: 'error', code: 'pooler_transaction' });
      expect(JSON.stringify(pooled)).not.toContain('motdepasse-secret');
      expect(spy.targets()).toEqual([]);
    } finally {
      spy.stop();
    }
    const down = await runDoctor({ env: { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', MASTER_KEY: masterKey } });
    expect(byId(down, 'database')).toMatchObject({ status: 'error', code: 'database_unreachable' });
    expect(down.exitCode).toBe(2);
  });
});

describe('runtime diagnostics', () => {
  test('assert_diagnostics_redacted : ni secret, ni clé, ni courriel, ni texte libre, ni hôte, et 0 connexion sortante', async () => {
    const secretValuesSeeded = [...seeded.secrets.values()];
    const apiKey = canary('metrics_token');
    const emailCanary = 'zz_test_owner@example.test';
    // Canaris d'ENVIRONNEMENT : ils ne doivent apparaître qu'en nom de variable, jamais en valeur.
    const diagEnv = env({ METRICS_TOKEN: apiKey, ADMIN_BOOTSTRAP_TOKEN: canary('bootstrap'), OTEL_EXPORTER_OTLP_HEADERS: canary('otlp') });
    // Preuve que la STRUCTURE exclut les secrets, sans compter sur le balayage : le registre du processus est vidé.
    secretValues.clear();
    const spy = spyOnSockets();
    let file: string;
    try {
      const doctor = await runDoctor({ env: diagEnv });
      const diagnostics = await withClient(tdb.url, (c) => buildDiagnostics(c, { env: diagEnv, runtimeVersion: '0.0.0', doctor }));
      file = JSON.stringify(diagnostics);
      expect(diagnostics.counters).toMatchObject({ users: 2, secrets: { ok: 3, unreadable: 0 }, schedules_enabled: 1 });
      expect(diagnostics.counters?.apis_by_status).toEqual({ enquete: 1, erreur: 1, sain: 2, warning: 1 });
      expect(diagnostics.counters?.runs_by_state).toEqual({ failed: 2, succeeded: 8 });
      expect(diagnostics.last_failure_classes.map((f) => f.failure_class).sort()).toEqual(['extraction', 'network']);
      expect(diagnostics.settings_names).toEqual(expect.arrayContaining(['key_check', 'last_backup_at']));
      expect(diagnostics.env_names_set).toEqual(expect.arrayContaining(['METRICS_TOKEN', 'ADMIN_BOOTSTRAP_TOKEN', 'MASTER_KEY', 'DATABASE_URL']));
      expect(diagnostics.env_names_set).not.toContain('OTEL_EXPORTER_OTLP_HEADERS');
      expect(diagnostics.doctor.checks.every((c) => Object.keys(c).sort().join() === 'code,id,status')).toBe(true);
    } finally {
      spy.stop();
    }
    const forbidden = [
      masterKey, ...secretValuesSeeded, diagEnv['METRICS_TOKEN']!, diagEnv['ADMIN_BOOTSTRAP_TOKEN']!,
      diagEnv['OTEL_EXPORTER_OTLP_HEADERS']!, emailCanary, 'zz_test_detail_libre', 'zz_test API n°', 'zz_test finalité', 'postgres://', dbTarget(tdb.url), new URL(tdb.url).host,
    ];
    for (const needle of forbidden) expect(file, needle).not.toContain(needle);
    const targets = new Set(spy.targets().map((t) => t.replace('localhost', '127.0.0.1')));
    expect(targets).toEqual(new Set([dbTarget(tdb.url).replace('localhost', '127.0.0.1')]));
    expect(spy.fetchCalls()).toBe(0);
  });

  test('dernière couche : une valeur de secret connue du processus est masquée même dans un nom de réglage', async () => {
    const leaked = canary('couche3');
    await client.query("INSERT INTO settings (key, value) VALUES ($1, '1'::jsonb)", [`zz_test_${leaked}`]);
    secretValues.add(leaked);
    try {
      const doctor = await runDoctor({ env: env() });
      const file = JSON.stringify(await buildDiagnostics(client, { env: env(), runtimeVersion: '0.0.0', doctor }));
      expect(file).not.toContain(leaked);
      expect(file).toContain('[REDACTED]');
    } finally {
      secretValues.delete(leaked);
      await client.query('DELETE FROM settings WHERE key = $1', [`zz_test_${leaked}`]);
    }
  });

  test('base injoignable : fichier réduit aux contrôles locaux, compteurs absents (jamais zéro trompeur)', async () => {
    const doctor = await runDoctor({ env: { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', MASTER_KEY: masterKey } });
    const d = buildOfflineDiagnostics({ env: { MASTER_KEY: masterKey }, runtimeVersion: '0.0.0', doctor });
    expect(d).toMatchObject({ database_reachable: false, counters: null, settings_names: [], last_failure_classes: [] });
    expect(JSON.stringify(d)).not.toContain(masterKey);
  });
});

describe('runtime export-catalog', () => {
  test('API, stratégies et planifications ; aucun secret, cookie, courriel ni donnée de run (INV8)', async () => {
    // Appâts : session de site chiffrée, artefact chiffré, secret, secret_id d'un webhook : rien de cela ne sort.
    const cookieCanary = canary('cookie');
    await client.query(
      `INSERT INTO site_sessions (owner_id, domain, server_use_allowed, ciphertext, nonce, key_version) VALUES ($1, 'example.test', true, $2, $3, 1)`,
      [seeded.ownerId, Buffer.from(cookieCanary), Buffer.from('nonce-nonce')],
    );
    secretValues.clear();
    const catalog = await exportCatalog(client, new Date('2026-10-01T08:00:00Z'));
    const text = JSON.stringify(catalog);
    expect(catalog).toMatchObject({ format: 'runtime-catalog', format_version: 1, exported_at: '2026-10-01T08:00:00.000Z', schema_version: migrations.length });
    expect(catalog.apis).toHaveLength(5);
    const first = catalog.apis.find((a) => a['slug'] === 'zz_test_api_0') as Record<string, unknown> & { strategy_versions: unknown[]; schedules: unknown[] };
    expect(first.strategy_versions).toHaveLength(1);
    expect(first.schedules).toHaveLength(1);
    expect(first['status_at_export']).toBe('sain');
    expect(first['input_schema']).toBeDefined();
    expect(first['output_schema']).toBeDefined();
    for (const value of [...seeded.secrets.values(), cookieCanary, 'zz_test_owner@example.test', 'zz_test_detail_libre', masterKey]) {
      expect(text, value).not.toContain(value);
    }
    for (const word of ['ciphertext', 'dek_wrapped', 'nonce', 'secret_id', 'password', 'error_detail', 'token']) expect(text, word).not.toContain(word);
  });
});

describe('runtime restore-prepare (ensureAppRole)', () => {
  test('idempotent ; reprend les instructions de la migration 0003 (rôle sans SUPERUSER ni BYPASSRLS, accordé à l\'utilisateur)', async () => {
    expect(await ensureAppRole(client)).toEqual({ created: false, member: true });
    expect(await ensureAppRole(client)).toEqual({ created: false, member: true });
    const { rows } = await client.query("SELECT rolsuper, rolbypassrls, rolcanlogin, rolinherit FROM pg_roles WHERE rolname = 'runtime_app'");
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false, rolinherit: false });
    const flat = (sql: string) => sql.replace(/\s+/g, ' ');
    const migration = flat(readFileSync(`${MIGRATIONS_DIR}0003_rls_app_role/up.sql`, 'utf8'));
    expect(migration).toContain('CREATE ROLE runtime_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT');
    expect(migration).toContain("EXECUTE format('GRANT runtime_app TO %I', current_user)");
    expect(flat(readFileSync(new URL('./roles.ts', import.meta.url), 'utf8'))).toContain('CREATE ROLE runtime_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT');
  });
});
