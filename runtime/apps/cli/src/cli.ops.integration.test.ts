// SPDX-License-Identifier: AGPL-3.0-only
// Commandes d'exploitation de bout en bout (4.6) : doctor, diagnostics, export-catalog, backup declare,
// secrets accept-key-loss (D-12). Base réelle ; la CLI est appelée comme le fait `runtime`.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey, loadKeyring, MasterKey, secretValues } from '@runtime/core';
import { ENCRYPTED_COLUMNS, holdSecretsLock, keyCheck, KEY_LOSS_TREATMENT, secretStore, SecretUnreadableError } from '@runtime/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { canary, seedInstance, type SeededInstance } from '../../../tests/helpers/ops-seed.js';
import { createTestDatabase, withClient, type TestDatabase } from '../../../tests/helpers/pg.js';
import { dbTarget, spyOnSockets } from '../../../tests/helpers/socket-spy.js';
import { run } from './cli.js';

let tdb: TestDatabase;
let dir: string;
const log = () => {};
const norm = (t: string) => t.replace('localhost', '127.0.0.1');

beforeAll(async () => {
  tdb = await createTestDatabase('cliops');
  dir = mkdtempSync(join(tmpdir(), 'zz_test_cliops_'));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await tdb.drop();
});

describe(`doctor, diagnostics, export-catalog, backup (PostgreSQL ${inject('pgVersion')})`, () => {
  const key = generateMasterKey();
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: tdb.url, MASTER_KEY: key, PUBLIC_URL: 'https://runtime.example.test', ...extra });
  let seeded: SeededInstance;

  beforeAll(async () => {
    expect((await run(['migrate'], { env: env(), log })).code).toBe(0);
    seeded = await seedInstance(tdb.url, loadKeyring(env()));
    secretValues.clear();
  });

  test('doctor : code de sortie 1 (avertissements) sur stdout, --json lisible, code 2 sur erreur', async () => {
    const text = await run(['doctor'], { env: env() });
    expect(text.code).toBe(1);
    expect(text.stream).toBe('stdout');
    expect(text.out).toMatch(/\[avertissement\] workers : aucun worker vivant/);
    expect(text.out).toMatch(/\[avertissement\] backup : aucune sauvegarde déclarée/);
    const json = await run(['doctor', '--json'], { env: env() });
    const report = JSON.parse(json.out) as { exitCode: number; checks: { id: string; status: string }[] };
    expect(report.exitCode).toBe(1);
    expect(report.checks.find((c) => c.id === 'schema')?.status).toBe('ok');
    const bad = await run(['doctor'], { env: env({ MASTER_KEY: generateMasterKey() }) });
    expect(bad.code).toBe(2);
    expect(bad.out).toMatch(/\[erreur +\] key_check : MASTER_KEY \(empreinte/);
  });

  test('backup declare puis doctor : la sauvegarde est reconnue ; date future ou illisible refusée', async () => {
    const now = () => new Date('2026-10-01T08:00:00Z');
    expect((await run(['backup', 'declare', '--at', '2026-10-02T08:00:00Z'], { env: env(), now })).out).toMatch(/Refus : date de sauvegarde dans le futur/);
    expect((await run(['backup', 'declare', '--at', 'hier'], { env: env(), now })).code).toBe(2);
    const done = await run(['backup', 'declare', '--at', '2026-09-30T08:00:00Z'], { env: env(), now });
    expect(done).toMatchObject({ code: 0, out: expect.stringContaining('2026-09-30T08:00:00.000Z') });
    expect(done.out).toMatch(/Gardez MASTER_KEY à part/);
    const report = JSON.parse((await run(['doctor', '--json'], { env: env(), now })).out) as { checks: { id: string; code: string }[] };
    expect(report.checks.find((c) => c.id === 'backup')?.code).toBe('backup_recent');
    expect((await run(['backup'], { env: env() })).code).toBe(1);
  });

  test('diagnostics : fichier 0600 masqué, jamais écrasé, 0 connexion sortante hors base', async () => {
    const out = join(dir, 'diag.json');
    const leak = canary('diag_env');
    const spy = spyOnSockets();
    let res;
    try {
      res = await run(['diagnostics', '--out', out], { env: env({ METRICS_TOKEN: leak }) });
    } finally {
      spy.stop();
    }
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/Rien n’est envoyé/);
    expect(new Set(spy.targets().map(norm))).toEqual(new Set([norm(dbTarget(tdb.url))]));
    expect(spy.fetchCalls()).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const text = readFileSync(out, 'utf8');
    const file = JSON.parse(text) as { format: string; database_reachable: boolean; counters: { users: number } };
    expect(file).toMatchObject({ format: 'runtime-diagnostics', database_reachable: true, counters: { users: 2 } });
    for (const needle of [key, leak, ...seeded.secrets.values(), 'zz_test_owner@example.test', new URL(tdb.url).host]) expect(text, needle).not.toContain(needle);
    const again = await run(['diagnostics', '--out', out], { env: env() });
    expect(again.code).toBe(2);
    expect(again.out).toMatch(/jamais écrasé/);
  });

  test('diagnostics base injoignable : fichier réduit aux contrôles locaux, code 0', async () => {
    const out = join(dir, 'diag-offline.json');
    const res = await run(['diagnostics', '--out', out], { env: { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', MASTER_KEY: key } });
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/base injoignable/);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ database_reachable: false, database_read_error: null, counters: null });
  });

  test('diagnostics base joignable mais illisible (schéma absent ou en retard) : jamais « injoignable », un code stable dit pourquoi', async () => {
    const empty = await createTestDatabase('cliops_empty');
    try {
      const out = join(dir, 'diag-unreadable.json');
      const res = await run(['diagnostics', '--out', out], { env: { DATABASE_URL: empty.url, MASTER_KEY: key } });
      expect(res.code).toBe(0);
      expect(res.out).toMatch(/base joignable, lecture impossible \(schema_mismatch\)/);
      expect(res.out).not.toMatch(/injoignable/);
      expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ database_reachable: true, database_read_error: 'schema_mismatch', counters: null, settings_names: [] });
    } finally {
      await empty.drop();
    }
  });

  test('export-catalog : JSON sur stdout ou fichier, sans secret ; --with-secrets refusé en V1', async () => {
    const res = await run(['export-catalog'], { env: env() });
    expect(res).toMatchObject({ code: 0, stream: 'stdout' });
    const catalog = JSON.parse(res.out) as { apis: unknown[]; format: string };
    expect(catalog).toMatchObject({ format: 'runtime-catalog' });
    expect(catalog.apis).toHaveLength(5);
    for (const value of [...seeded.secrets.values(), key]) expect(res.out).not.toContain(value);
    const out = join(dir, 'catalog.json');
    expect((await run(['export-catalog', '--out', out], { env: env() })).out).toMatch(/5 API, 1 projet\(s\) écrits dans .*catalog\.json \(sans secret ni cookie\)/);
    expect(existsSync(out)).toBe(true);
    const refused = await run(['export-catalog', '--with-secrets'], { env: env() });
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/--with-secrets n’existe pas en V1/);
  });
});

describe('runtime secrets accept-key-loss --confirm (D-12)', () => {
  const original = generateMasterKey();
  const lost = generateMasterKey();
  let db: TestDatabase;
  let secretId: string;
  const base = () => ({ DATABASE_URL: db.url });

  beforeAll(async () => {
    db = await createTestDatabase('keyloss');
    expect((await run(['migrate'], { env: base(), log })).code).toBe(0);
    const seeded = await seedInstance(db.url, loadKeyring({ ...base(), MASTER_KEY: original }));
    secretId = [...seeded.secrets.keys()][0]!;
    await withClient(db.url, async (c) => {
      await c.query("INSERT INTO site_sessions (owner_id, domain, server_use_allowed, ciphertext, nonce, dek_wrapped, alg, key_version, captured_at) VALUES ($1, 'example.test', true, $2, $3, $4, 'aes-256-gcm', 1, now())", [
        seeded.ownerId, Buffer.from('cookie-chiffré'), Buffer.from('nonce-nonce'), Buffer.from('dek-enveloppée'),
      ]);
      await c.query("INSERT INTO run_artifacts (run_id, owner_id, kind, bytes, sensitivity, ciphertext, nonce, key_version) VALUES ($1, $2, 'screenshot', 4, 'low', $3, $4, 1)", [
        seeded.runIds[0], seeded.ownerId, Buffer.from('abcd'), Buffer.from('nonce-nonce'),
      ]);
      // Colonne chiffrée différée à 3.7 : jamais effacée par la commande, seulement signalée.
      await c.query("INSERT INTO two_factor (user_id, secret_ciphertext) VALUES ($1, 'zz_test_scelle')", [seeded.ownerId]);
    });
  });
  afterAll(async () => {
    await db.drop();
  });

  const counts = () =>
    withClient(db.url, async (c) => ({
      unreadable: (await c.query("SELECT count(*)::int AS n FROM secrets WHERE state = 'unreadable'")).rows[0].n as number,
      sessions: (await c.query('SELECT count(*)::int AS n FROM site_sessions WHERE ciphertext IS NOT NULL')).rows[0].n as number,
      artifacts: (await c.query('SELECT count(*)::int AS n FROM run_artifacts')).rows[0].n as number,
    }));

  /** Le registre ENCRYPTED_COLUMNS fait foi : chaque colonne est dans l'état que promet son traitement (aucune ne reste scellée sous la clé perdue sans être déclarée). */
  const expectEveryEncryptedColumnTreated = () =>
    withClient(db.url, async (c) => {
      const n = async (sql: string) => (await c.query<{ n: number }>(sql)).rows[0]!.n;
      for (const col of ENCRYPTED_COLUMNS) {
        const name = `${col.table}.${col.column}`;
        const treatment = KEY_LOSS_TREATMENT[name as keyof typeof KEY_LOSS_TREATMENT];
        switch (treatment.action) {
          case 'unreadable':
            expect(await n(`SELECT count(*)::int AS n FROM ${col.table} WHERE state <> 'unreadable'`), name).toBe(0);
            break;
          case 'cleared':
            expect(await n(`SELECT count(*)::int AS n FROM ${col.table} WHERE ${col.column} IS NOT NULL`), name).toBe(0);
            break;
          case 'deleted':
            expect(await n(`SELECT count(*)::int AS n FROM ${col.table}`), name).toBe(0);
            break;
          case 'rewritten':
            expect(await n("SELECT (value->>'version')::int AS n FROM settings WHERE key = 'key_check'"), name).toBe(2);
            break;
          case 'deferred':
            expect(await n(`SELECT count(*)::int AS n FROM ${col.table} WHERE ${col.column} IS NOT NULL`), name).toBeGreaterThan(0);
            break;
        }
      }
    });

  test('la bonne clé : « aucune perte à accepter », même avec --confirm', async () => {
    const res = await run(['secrets', 'accept-key-loss', '--confirm'], { env: { ...base(), MASTER_KEY: original } });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/aucune perte à accepter/);
    expect((await counts()).unreadable).toBe(0);
  });

  test('sans --confirm : rien n\'est modifié, le plan est affiché avec les deux empreintes', async () => {
    const res = await run(['secrets', 'accept-key-loss'], { env: { ...base(), MASTER_KEY: lost } });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/ne correspond pas à la base/);
    expect(res.out).toMatch(/3 secret\(s\) passent en « À ressaisir »/);
    expect(res.out).toMatch(/1 session\(s\) de site sont vidées \(cookies à recapturer\), 1 artefact\(s\) de run supprimés/);
    expect(res.out).not.toContain(lost);
    expect(await counts()).toEqual({ unreadable: 0, sessions: 1, artifacts: 1 });
  });

  test('une instance qui tourne tient le verrou partagé : refus (elle a encore la clé)', async () => {
    const holder = new pg.Client({ connectionString: db.url });
    await holder.connect();
    const release = await holdSecretsLock(holder);
    try {
      const res = await run(['secrets', 'accept-key-loss', '--confirm'], { env: { ...base(), MASTER_KEY: lost } });
      expect(res.code).toBe(2);
      expect(res.out).toMatch(/verrou des secrets indisponible/);
      expect((await counts()).unreadable).toBe(0);
    } finally {
      await release();
      await holder.end();
    }
  });

  test('--confirm : secrets conservés « À ressaisir », sessions et artefacts vidés, témoin réécrit, ancienne clé refusée', async () => {
    const res = await run(['secrets', 'accept-key-loss', '--confirm'], { env: { ...base(), MASTER_KEY: lost } });
    expect(res.code, res.out).toBe(0);
    expect(res.out).toMatch(/3 secret\(s\) passés en « À ressaisir », 1 session\(s\) de site vidées, 1 artefact\(s\) supprimés ; témoin de clé réécrit \(empreinte [0-9a-f-]+, version 2\)/);
    expect(res.out).not.toContain(lost);
    expect(await counts()).toEqual({ unreadable: 3, sessions: 0, artifacts: 0 });
    expect(res.out).toMatch(/1 secret\(s\) 2FA restent illisibles : à réinitialiser/);
    await expectEveryEncryptedColumnTreated();
    // La nouvelle clé démarre ; les secrets sont listés « À ressaisir » et refusent de s'ouvrir.
    const keyring = { current: MasterKey.parse(lost) };
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const store = secretStore(client, keyring, await keyCheck(client, keyring));
      expect((await store.list()).every((s) => s.state === 'unreadable')).toBe(true);
      await expect(store.get(secretId)).rejects.toThrow(SecretUnreadableError);
      // Ressaisie : un nouveau secret s'écrit et se relit sous la nouvelle clé.
      const fresh = canary('ressaisi');
      const id = await store.put({ ownerId: null, kind: 'llm_api_key', label: 'zz_test_ressaisi', value: fresh });
      expect((await store.get(id)).reveal()).toBe(fresh);
    } finally {
      await client.end();
    }
    const old = await run(['key-check'], { env: { ...base(), MASTER_KEY: original } });
    expect(old.code).toBe(2);
    expect(old.out).toMatch(/MASTER_KEY ne correspond pas/);
    // doctor : la nouvelle clé est valide, les secrets restent signalés à ressaisir (avertissement, pas erreur).
    const report = JSON.parse((await run(['doctor', '--json'], { env: { ...base(), MASTER_KEY: lost } })).out) as { checks: { id: string; code: string }[] };
    expect(report.checks.find((c) => c.id === 'key_check')?.code).toBe('key_ok');
    expect(report.checks.find((c) => c.id === 'secrets')?.code).toBe('secrets_unreadable');
  });
});

