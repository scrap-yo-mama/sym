// Observabilité sur base réelle (tâche 1.10, INV8, 14 § 3 et § 10) : `run_logs` (masquage avant insertion, niveaux,
// plafonds), `run_artifacts` (niveau 0 = aucune ligne ; sinon chiffrés, masqués, couverts par rekey), sondes et battements.
import { randomBytes } from 'node:crypto';
import { generateMasterKey, MasterKey, secretValues, SecretDecryptError, type Keyring } from '@runtime/core';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { ArtifactUnreadableError, readRunArtifact, writeRunArtifact, type ArtifactSettings } from './artifacts.js';
import { checkReadiness, listWorkers, queueDepth, WORKER_DEAD_AFTER_SECONDS } from './health.js';
import { expectedSchemaVersion, migrateDown, migrateUp } from './migrate.js';
import { beatWorker } from './runs.js';
import { createRunLogger, RUN_LOG_LIMITS } from './run-logs.js';
import { KEY_CHECK_SETTING, keyCheck, rekey } from './secrets.js';

const newKey = () => MasterKey.parse(generateMasterKey());
/** Run échoué, sans session serveur, hors tunnel, sans défi : les drapeaux d'exclusion sont obligatoires. */
const FAILED_RUN = { failed: true, serverSession: false, tunnel: false, challenge: false };
const canary = () => `zz_test_canary_${randomBytes(8).toString('hex')}`;

let tdb: TestDatabase;
let client: pg.Client;
let owner: string;
let runId: string;

beforeEach(async () => {
  tdb = await createTestDatabase('obs');
  await migrateUp({ connectionString: tdb.url });
  client = new pg.Client({ connectionString: tdb.url });
  await client.connect();
  owner = (await client.query<{ id: string }>("INSERT INTO users (email) VALUES ('zz_test_obs@example.test') RETURNING id")).rows[0]!.id;
  const api = await client.query<{ id: string }>("INSERT INTO apis (slug, owner_id) VALUES ('zz_test_api', $1) RETURNING id", [owner]);
  runId = (
    await client.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger) VALUES ($1, $2, $2, 'rest') RETURNING id", [api.rows[0]!.id, owner])
  ).rows[0]!.id;
});
afterEach(async () => {
  await client.end();
  await tdb.drop();
  secretValues.clear();
});
afterAll(() => secretValues.clear());

const logs = async () =>
  (await client.query<{ seq: number; level: string; event: string; data: unknown }>('SELECT seq, level, event, data FROM run_logs WHERE run_id = $1 ORDER BY seq', [runId])).rows;

describe('run_logs', () => {
  test('masqué avant l’insertion : valeurs connues, Secret, URL ; aucune occurrence dans la table', async () => {
    const secret = canary();
    secretValues.add(secret);
    const log = await createRunLogger(client, { runId, ownerId: owner });
    await log.log('info', `appel avec ${secret}`, { header: `Bearer ${secret}`, nested: { proxy: `http://user:${secret}@proxy.example.test:8080` } });
    const rows = await logs();
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0]).toMatchObject({ seq: 1, level: 'info' });
  });

  test('niveau minimal : en dessous, rien n’est écrit ; la numérotation reprend après l’existant', async () => {
    const log = await createRunLogger(client, { runId, ownerId: owner }, { minLevel: 'warn' });
    await log.log('debug', 'ignoré');
    await log.log('info', 'ignoré');
    await log.log('warn', 'gardé');
    await log.log('error', 'gardé aussi');
    expect((await logs()).map((r) => [r.seq, r.event])).toEqual([[1, 'gardé'], [2, 'gardé aussi']]);
    // Reprise après perte d'un worker : nouvelle instance, suite de la séquence.
    const again = await createRunLogger(client, { runId, ownerId: owner });
    await again.log('info', 'reprise');
    expect((await logs()).at(-1)).toMatchObject({ seq: 3, event: 'reprise' });
  });

  test('plafond d’une entrée : `data` trop gros remplacé par un marqueur JSON valide', async () => {
    const log = await createRunLogger(client, { runId, ownerId: owner }, { limits: { maxDataBytes: 200 } });
    await log.log('info', 'gros', { blob: 'x'.repeat(5000) });
    await log.log('info', 'petit', { ok: true });
    const rows = await logs();
    expect(rows[0]?.data).toEqual({ truncated: true, bytes: expect.any(Number) as number });
    expect(rows[1]?.data).toEqual({ ok: true });
  });

  test('plafond d’entrées par run : une seule entrée `logs_truncated`, le reste est écarté et compté, rien ne lève', async () => {
    const log = await createRunLogger(client, { runId, ownerId: owner }, { limits: { maxEntries: 5 } });
    for (let i = 0; i < 12; i++) await log.log('info', `e${i}`);
    const rows = await logs();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.event)).toEqual(['e0', 'e1', 'e2', 'e3', 'logs_truncated']);
    expect(rows.at(-1)?.level).toBe('warn');
    expect(log.dropped).toBe(8);
    expect(RUN_LOG_LIMITS.maxEntries).toBe(2000);
  });

  test('une écriture impossible est comptée, jamais levée (le journal ne fait pas échouer le run)', async () => {
    const errors: unknown[] = [];
    const log = await createRunLogger(client, { runId, ownerId: owner }, { onError: (e) => errors.push(e) });
    await client.query('DROP TABLE run_logs');
    await expect(log.log('info', 'x')).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(log.dropped).toBe(1);
  });
});

describe('run_artifacts', () => {
  const settings = (level: ArtifactSettings['level'], extra: Partial<ArtifactSettings> = {}): ArtifactSettings => ({
    level,
    maxBytes: 5 * 1024 * 1024,
    quotaBytes: 500 * 1024 * 1024,
    ...extra,
  });
  const count = async () => (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM run_artifacts')).rows[0]!.n;

  async function setup(): Promise<{ keyring: Keyring; checked: Awaited<ReturnType<typeof keyCheck>> }> {
    const keyring = { current: newKey() };
    return { keyring, checked: await keyCheck(client, keyring) };
  }
  const har = (secret: string) =>
    JSON.stringify({
      log: {
        entries: [
          {
            request: { url: `https://example.test/?q=1`, headers: [{ name: 'Authorization', value: `Bearer ${secret}` }, { name: 'Cookie', value: `sid=${secret}` }], cookies: [{ name: 'sid', value: secret }] },
            response: { headers: [{ name: 'Set-Cookie', value: `sid=${secret}` }], content: { text: 'page' } },
          },
        ],
      },
    });

  test('niveau 0 (défaut) : aucun artefact, jamais, même sur un run échoué ; aucune requête n’est émise', async () => {
    const { keyring, checked } = await setup();
    let queries = 0;
    const spy = { query: (...a: Parameters<pg.Client['query']>) => (queries++, (client.query as (...x: unknown[]) => unknown)(...a)) } as unknown as pg.Client;
    for (const kind of ['screenshot', 'trace', 'har'] as const) {
      const result = await writeRunArtifact(spy, keyring, checked, settings('none'), { runId, ownerId: owner, kind, content: 'x', run: FAILED_RUN });
      expect(result).toEqual({ stored: false, reason: 'level_none' });
    }
    expect(queries).toBe(0);
    expect(await count()).toBe(0);
  });

  test('niveau supérieur : chiffré au repos (AES-256-GCM), masqué avant chiffrement, relisible avec la clé', async () => {
    const { keyring, checked } = await setup();
    const secret = canary();
    secretValues.add(secret);
    const result = await writeRunArtifact(client, keyring, checked, settings('har_minimal'), { runId, ownerId: owner, kind: 'har', content: har(secret), run: FAILED_RUN });
    if (!result.stored) throw new Error(`refusé : ${result.reason}`);
    const row = (await client.query<{ ciphertext: Buffer; dek_wrapped: Buffer; alg: string; sensitivity: string; key_version: number; bytes: number }>('SELECT * FROM run_artifacts')).rows[0]!;
    expect(row).toMatchObject({ alg: 'aes-256-gcm', sensitivity: 'text_redacted', key_version: checked.version });
    expect(row.dek_wrapped.length).toBeGreaterThan(32);
    expect(row.ciphertext.includes(Buffer.from('page'))).toBe(false); // pas de clair au repos
    const opened = await readRunArtifact(client, keyring, checked, result.id);
    const text = opened!.content.toString();
    expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('page'); // le reste du contenu est conservé
    // Aucune occurrence du canari nulle part dans la base (texte, jsonb, bytea).
    const { rows } = await client.query<{ found: boolean }>(
      "SELECT bool_or(position(convert_to($1, 'UTF8') IN ciphertext) > 0) AS found FROM run_artifacts",
      [secret],
    );
    expect(rows[0]?.found).toBe(false);
  });

  test('capture d’écran : octets chiffrés tels quels, marqués image non masquée', async () => {
    const { keyring, checked } = await setup();
    const png = randomBytes(300);
    const r = await writeRunArtifact(client, keyring, checked, settings('screenshot_on_failure'), { runId, ownerId: owner, kind: 'screenshot', content: png, run: FAILED_RUN });
    if (!r.stored) throw new Error(r.reason);
    expect((await readRunArtifact(client, keyring, checked, r.id))!.content.equals(png)).toBe(true);
    expect((await client.query<{ sensitivity: string }>('SELECT sensitivity FROM run_artifacts')).rows[0]?.sensitivity).toBe('image_unredacted');
  });

  test('jamais sur un run à session serveur, en tunnel ou avec défi, ni hors échec, ni d’un type exclu par le niveau', async () => {
    const { keyring, checked } = await setup();
    const w = (run: object, kind: 'har' | 'trace' = 'har', level: ArtifactSettings['level'] = 'har_minimal') =>
      writeRunArtifact(client, keyring, checked, settings(level), { runId, ownerId: owner, kind, content: '{}', run: { ...FAILED_RUN, ...run } });
    expect(await w({ serverSession: true })).toEqual({ stored: false, reason: 'server_session' });
    expect(await w({ tunnel: true })).toEqual({ stored: false, reason: 'tunnel' });
    expect(await w({ challenge: true })).toEqual({ stored: false, reason: 'challenge' });
    expect(await w({ failed: false })).toEqual({ stored: false, reason: 'run_not_failed' });
    expect(await w({}, 'har', 'trace_on_failure')).toEqual({ stored: false, reason: 'level_excludes_kind' });
    expect(await count()).toBe(0);
  });

  test('plafond par artefact et quota d’instance', async () => {
    const { keyring, checked } = await setup();
    const w = (content: string, s: Partial<ArtifactSettings>) =>
      writeRunArtifact(client, keyring, checked, settings('har_minimal', s), { runId, ownerId: owner, kind: 'trace', content, run: FAILED_RUN });
    expect(await w('x'.repeat(100), { maxBytes: 50 })).toEqual({ stored: false, reason: 'too_large' });
    expect((await w('x'.repeat(60), { quotaBytes: 100 })).stored).toBe(true);
    expect(await w('x'.repeat(60), { quotaBytes: 100 })).toEqual({ stored: false, reason: 'quota' });
  });

  test('liés à leur run et à leur propriétaire (AAD) : une ligne déplacée ne s’ouvre plus', async () => {
    const { keyring, checked } = await setup();
    const r = await writeRunArtifact(client, keyring, checked, settings('har_minimal'), { runId, ownerId: owner, kind: 'trace', content: 'contenu', run: FAILED_RUN });
    if (!r.stored) throw new Error(r.reason);
    await client.query("UPDATE run_artifacts SET kind = 'har' WHERE id = $1", [r.id]);
    await expect(readRunArtifact(client, keyring, checked, r.id)).rejects.toBeInstanceOf(SecretDecryptError);
  });

  test('rekey couvre les artefacts : relus avec la nouvelle clé, plus rien sous l’ancienne version', async () => {
    const oldKey = newKey();
    const first = { current: oldKey };
    const checked1 = await keyCheck(client, first);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await writeRunArtifact(client, first, checked1, settings('har_minimal'), { runId, ownerId: owner, kind: 'trace', content: `trace-${i}`, run: FAILED_RUN });
      if (!r.stored) throw new Error(r.reason);
      ids.push(r.id);
    }
    const before = (await client.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM run_artifacts ORDER BY id')).rows;
    const newK = newKey();
    await rekey(client, { current: newK, previous: oldKey }, { batchSize: 3 });
    const after = (await client.query<{ ciphertext: Buffer; key_version: number }>('SELECT ciphertext, key_version FROM run_artifacts ORDER BY id')).rows;
    expect(after.every((r) => r.key_version === 2)).toBe(true);
    expect(after.map((r) => r.ciphertext.toString('hex'))).not.toEqual(before.map((r) => r.ciphertext.toString('hex')));
    const keyring2 = { current: newK };
    const checked2 = await keyCheck(client, keyring2);
    const texts: string[] = [];
    for (const id of ids) texts.push((await readRunArtifact(client, keyring2, checked2, id))!.content.toString());
    expect(texts.sort()).toEqual(Array.from({ length: 7 }, (_, i) => `trace-${i}`).sort());
  });

  test('rekey : un artefact que l’ancienne clé n’ouvre pas est MARQUÉ illisible (conservé, compté, audité), la rotation aboutit', async () => {
    const oldKey = newKey();
    const first = { current: oldKey };
    const checked1 = await keyCheck(client, first);
    const w = (content: string) => writeRunArtifact(client, first, checked1, settings('har_minimal'), { runId, ownerId: owner, kind: 'trace', content, run: FAILED_RUN });
    const bad = await w('a');
    const good = await w('b');
    if (!bad.stored || !good.stored) throw new Error('refusé');
    await client.query("UPDATE run_artifacts SET dek_wrapped = '\\x' WHERE id = $1", [bad.id]); // ligne altérée, non ouvrable
    const newK = newKey();
    const result = await rekey(client, { current: newK, previous: oldKey });
    // Aucune perte sans trace : la ligne reste, marquée, et le résultat la compte.
    expect(result).toMatchObject({ status: 'done', unreadableArtifacts: 1, rotatedArtifacts: 1 });
    expect(await count()).toBe(2);
    const rows = (await client.query<{ id: string; state: string; unreadable_since: Date | null; key_version: number }>('SELECT id, state, unreadable_since, key_version FROM run_artifacts')).rows;
    expect(rows.find((r) => r.id === bad.id)).toMatchObject({ state: 'unreadable', key_version: 1 });
    expect(rows.find((r) => r.id === bad.id)!.unreadable_since).toBeInstanceOf(Date);
    expect(rows.find((r) => r.id === good.id)).toMatchObject({ state: 'ok', key_version: 2, unreadable_since: null });
    // Trace dans l'audit (système, sans contenu) : l'identifiant de l'artefact et la raison.
    const audit = (await client.query<{ action: string; actor_via: string; target_type: string; target_id: string; outcome: string }>(
      "SELECT action, actor_via, target_type, target_id, outcome FROM audit_events WHERE action = 'artifact.unreadable'",
    )).rows;
    expect(audit).toEqual([{ action: 'artifact.unreadable', actor_via: 'system', target_type: 'run_artifact', target_id: bad.id, outcome: 'error' }]);
    // Lecture : l'artefact marqué est signalé comme illisible, jamais présenté comme vide ; l'autre s'ouvre.
    const keyring2 = { current: newK };
    const checked2 = await keyCheck(client, keyring2);
    await expect(readRunArtifact(client, keyring2, checked2, bad.id)).rejects.toBeInstanceOf(ArtifactUnreadableError);
    expect((await readRunArtifact(client, keyring2, checked2, good.id))!.content.toString()).toBe('b');
    // Une seconde rotation n'y retouche pas (et ne bloque pas sur lui).
    expect(await rekey(client, { current: newKey(), previous: newK })).toMatchObject({ status: 'done', unreadableArtifacts: 0, rotatedArtifacts: 1 });
  });

  test('pas d’écriture pendant une rotation de clé', async () => {
    const { keyring, checked } = await setup();
    await client.query("UPDATE settings SET value = jsonb_set(value, '{version}', '99') WHERE key = $1", [KEY_CHECK_SETTING]);
    await expect(
      writeRunArtifact(client, keyring, checked, settings('har_minimal'), { runId, ownerId: owner, kind: 'trace', content: 'a', run: FAILED_RUN }),
    ).rejects.toThrow(/rotation de clé/);
  });
});

describe('sondes et battements', () => {
  test('checkReadiness : prêt ; migration retirée → schema false ; key_check d’une autre clé → false ; base coupée → tout false', async () => {
    const keyring = { current: newKey() };
    await keyCheck(client, keyring);
    const expected = expectedSchemaVersion();
    expect(await checkReadiness(client, keyring, expected)).toEqual({ ready: true, checks: { database: true, schema: true, key_check: true } });

    expect(await checkReadiness(client, { current: newKey() }, expected)).toEqual({ ready: false, checks: { database: true, schema: true, key_check: false } });

    await migrateDown({ connectionString: tdb.url, steps: 1 });
    expect(await checkReadiness(client, keyring, expected)).toEqual({ ready: false, checks: { database: true, schema: false, key_check: false } });
    await migrateUp({ connectionString: tdb.url });
    expect((await checkReadiness(client, keyring, expected)).ready).toBe(true);

    await client.end();
    expect(await checkReadiness(client, keyring, expected)).toEqual({ ready: false, checks: { database: false, schema: false, key_check: false } });
    client = new pg.Client({ connectionString: tdb.url });
    await client.connect();
  });

  test('checkReadiness : rotation de clé en cours → key_check false ; lecture seule (n’initialise rien)', async () => {
    const keyring = { current: newKey() };
    const expected = expectedSchemaVersion();
    // Base neuve jamais démarrée : pas de key_check, et la sonde n'en crée pas.
    expect((await checkReadiness(client, keyring, expected)).checks.key_check).toBe(false);
    expect((await client.query('SELECT 1 FROM settings WHERE key = $1', [KEY_CHECK_SETTING])).rowCount).toBe(0);
    await keyCheck(client, keyring);
    await client.query("INSERT INTO settings (key, value) VALUES ('rekey_state', '{}'::jsonb)");
    expect((await checkReadiness(client, keyring, expected)).checks.key_check).toBe(false);
  });

  test('worker_heartbeats exposés : vivant sous 45 s, mort au-delà ; profondeur de file', async () => {
    await beatWorker(client, { workerId: 'w-live', version: '1.2.3', browserContexts: 2, rssMb: 300 });
    await beatWorker(client, { workerId: 'w-dead', version: '1.2.3', draining: true });
    await client.query(`UPDATE worker_heartbeats SET last_seen_at = now() - interval '${WORKER_DEAD_AFTER_SECONDS + 5} seconds' WHERE worker_id = 'w-dead'`);
    const workers = await listWorkers(client);
    expect(workers.map((w) => [w.workerId, w.alive, w.draining, w.browserContexts])).toEqual([
      ['w-dead', false, true, 0],
      ['w-live', true, false, 2],
    ]);
    expect(workers.find((w) => w.workerId === 'w-dead')!.ageSeconds).toBeGreaterThan(WORKER_DEAD_AFTER_SECONDS);
    expect(await queueDepth(client)).toEqual({ queued: 1, running: 0, oldestQueuedAgeSeconds: expect.any(Number) as number });
  });
});
