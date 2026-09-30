// SPDX-License-Identifier: AGPL-3.0-only
// INV8 sur base réelle (matrice PG 16/17/18) : chiffrement au repos, AAD liée à la ligne, key_check et clé perdue,
// rekey complet et reprenable, masquage des journaux (pino) et de run_logs. Clés et canaris générés à l'exécution.
import { randomBytes } from 'node:crypto';
import {
  createKeyCheck,
  generateMasterKey,
  loggerRedaction,
  MasterKey,
  secretValues,
  type Keyring,
} from '@runtime/core';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { appendRunLog } from './run-logs.js';
import {
  acceptKeyLoss,
  ENCRYPTED_COLUMNS,
  holdSecretsLock,
  KEY_CHECK_SETTING,
  keyCheck,
  KeyCheckError,
  rekey,
  REKEY_STATE_SETTING,
  RekeyInProgressError,
  secretStore,
  SecretUnreadableError,
  SecretVersionMismatchError,
} from './secrets.js';

const newKey = () => MasterKey.parse(generateMasterKey());
const canary = () => `zz_test_canary_${randomBytes(8).toString('hex')}`;

let tdb: TestDatabase;
let client: pg.Client;
const opened: pg.Client[] = [];

beforeEach(async () => {
  tdb = await createTestDatabase('secrets');
  await migrateUp({ connectionString: tdb.url });
  client = new pg.Client({ connectionString: tdb.url });
  await client.connect();
  opened.push(client);
});
afterEach(async () => {
  for (const c of opened.splice(0)) await c.end();
  await tdb.drop();
  secretValues.clear();
});
afterAll(() => secretValues.clear());

async function newUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [
    `u-${randomBytes(4).toString('hex')}@example.test`,
  ]);
  return rows[0]!.id;
}

async function newRun(ownerId: string): Promise<string> {
  const api = await client.query<{ id: string }>('INSERT INTO apis (slug, owner_id) VALUES ($1, $2) RETURNING id', ['api', ownerId]);
  const run = await client.query<{ id: string }>(
    "INSERT INTO runs (api_id, owner_id, api_owner_id, trigger) VALUES ($1, $2, $2, 'rest') RETURNING id",
    [api.rows[0]!.id, ownerId],
  );
  return run.rows[0]!.id;
}

async function openStore(keyring: Keyring) {
  return secretStore(client, keyring, await keyCheck(client, keyring));
}

/** Occurrences d'une chaîne dans toutes les colonnes texte, jsonb et bytea du schéma public. */
async function occurrencesInDatabase(needle: string): Promise<string[]> {
  const { rows: cols } = await client.query<{ t: string; c: string; bytea: boolean }>(`
    SELECT c.relname AS t, a.attname AS c, format_type(a.atttypid, NULL) = 'bytea' AS bytea
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped
      AND format_type(a.atttypid, NULL) IN ('text', 'character varying', 'citext', 'jsonb', 'json', 'bytea', 'text[]')`);
  expect(cols.length).toBeGreaterThan(50);
  const hits: string[] = [];
  for (const { t, c, bytea } of cols) {
    const cond = bytea ? `position(convert_to($1, 'UTF8') in "${c}") > 0` : `strpos("${c}"::text, $1) > 0`;
    const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}" WHERE ${cond}`, [needle]);
    if ((rows[0]?.n ?? 0) > 0) hits.push(`${t}.${c}`);
  }
  return hits;
}

describe(`secrets sur PostgreSQL ${inject('pgVersion')}`, () => {
  test('assert_encrypted_at_rest : aucune valeur en clair dans aucune colonne de la base', async () => {
    const keyring = { current: newKey() };
    const store = await openStore(keyring);
    const owner = await newUser();
    const values = [canary(), canary(), canary()];
    const ids = [
      await store.put({ ownerId: null, kind: 'llm_api_key', label: 'LLM', value: values[0]! }),
      await store.put({ ownerId: null, kind: 'proxy_url', label: 'proxy', value: `http://u:${values[1]}@proxy.example:8080` }),
      await store.put({ ownerId: owner, kind: 'webhook_secret', label: 'webhook', value: values[2]! }),
    ];
    // Un usage réel du secret, journalisé dans run_logs, ne doit pas non plus le poser en base.
    const runId = await newRun(owner);
    const used = await store.get(ids[0]!);
    await appendRunLog(client, { runId, seq: 1, ownerId: owner, level: 'info', event: 'llm_call', data: { key: used.reveal() } });

    for (const v of values) {
      expect(await occurrencesInDatabase(v)).toEqual([]);
      expect(await occurrencesInDatabase(Buffer.from(v).toString('base64'))).toEqual([]);
    }
    // La clé maîtresse non plus, sous aucune forme.
    expect(await occurrencesInDatabase(keyring.current.exportBase64())).toEqual([]);
    const { rows } = await client.query<{ alg: string; kek_version: number; state: string; aad: Buffer }>(
      'SELECT alg, kek_version, state, aad FROM secrets ORDER BY created_at',
    );
    expect(rows.map((r) => [r.alg, r.kek_version, r.state])).toEqual(Array(3).fill(['aes-256-gcm', 1, 'ok']));
    expect(rows[2]!.aad.toString()).toBe(`secret|${ids[2]}|webhook_secret|${owner}`);
    expect((await store.get(ids[2]!)).reveal()).toBe(values[2]);
    // Lecture en métadonnées seulement.
    expect(JSON.stringify(await store.list())).not.toContain(values[2]!);
  });

  test('assert_aad_binding (I1) : chiffré copié vers une autre ligne ou un autre propriétaire → illisible', async () => {
    const store = await openStore({ current: newKey() });
    const [alice, bob] = [await newUser(), await newUser()];
    const a = await store.put({ ownerId: alice, kind: 'llm_api_key', label: 'a', value: canary() });
    const b = await store.put({ ownerId: bob, kind: 'llm_api_key', label: 'b', value: canary() });
    const i = await store.put({ ownerId: null, kind: 'llm_api_key', label: 'i', value: canary() });
    const copy = (from: string, to: string) =>
      client.query(
        `UPDATE secrets t SET ciphertext = s.ciphertext, nonce = s.nonce, dek_wrapped = s.dek_wrapped, aad = s.aad
         FROM secrets s WHERE s.id = $1 AND t.id = $2`,
        [from, to],
      );
    await copy(a, b); // autre ligne, autre propriétaire
    await copy(a, i); // vers un secret d'instance
    await expect(store.get(b)).rejects.toThrow(SecretUnreadableError);
    await expect(store.get(i)).rejects.toThrow(SecretUnreadableError);
    // Même ligne, propriétaire changé en SQL : l'AAD recalculée ne correspond plus.
    await client.query('UPDATE secrets SET owner_id = $1 WHERE id = $2', [bob, a]);
    await expect(store.get(a)).rejects.toThrow(SecretUnreadableError);
    const states = await store.list();
    expect(states.every((s) => s.state === 'unreadable' && s.unreadableSince instanceof Date)).toBe(true);
  });

  test('assert_key_loss_detected : autre MASTER_KEY → refus clair avec les empreintes, 0 secret lu ou écrit', async () => {
    const original = newKey();
    const store = await openStore({ current: original });
    const id = await store.put({ ownerId: null, kind: 'llm_api_key', label: 'k', value: canary() });
    const before = await client.query('SELECT ciphertext, updated_at, state FROM secrets');

    const other = newKey();
    const error = await keyCheck(client, { current: other }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeyCheckError);
    const message = (error as Error).message;
    expect(message).toContain(original.fingerprint);
    expect(message).toContain(other.fingerprint);
    expect(message).toMatch(/MASTER_KEY ne correspond pas/);
    expect(message).not.toContain(other.exportBase64());
    expect((await client.query('SELECT ciphertext, updated_at, state FROM secrets')).rows).toEqual(before.rows);

    // Base neuve absente : key_check réinitialisé en silence ? Non : sans témoin mais avec des secrets, refus.
    await client.query('DELETE FROM settings WHERE key = $1', [KEY_CHECK_SETTING]);
    await expect(keyCheck(client, { current: other })).rejects.toThrow(/key_check absent alors que des secrets existent/);
    await client.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)', [
      KEY_CHECK_SETTING,
      JSON.stringify(createKeyCheck(original, 1)),
    ]);

    // Perte acceptée explicitement : secrets conservés en état unreadable (« À ressaisir »), nouvelle version.
    expect(await acceptKeyLoss(client, other)).toEqual({ unreadable: 1, version: 2 });
    const store2 = await openStore({ current: other });
    await expect(store2.get(id)).rejects.toThrow(SecretUnreadableError);
    expect((await store2.list()).map((s) => [s.state, s.kekVersion])).toEqual([['unreadable', 1]]);
    await expect(acceptKeyLoss(client, other)).rejects.toThrow(/aucune perte à accepter/);
    // La clé d'origine est désormais refusée à son tour.
    await expect(keyCheck(client, { current: original })).rejects.toThrow(KeyCheckError);
  });

  test('key_check : base neuve initialisée une fois ; version inconnue refusée', async () => {
    const key = newKey();
    expect(await keyCheck(client, { current: key })).toEqual({ status: 'initialized', version: 1, fingerprint: key.fingerprint });
    expect((await keyCheck(client, { current: key })).status).toBe('ok');
    const store = secretStore(client, { current: key }, await keyCheck(client, { current: key }));
    const id = await store.put({ ownerId: null, kind: 'llm_api_key', label: 'k', value: canary() });
    await client.query('UPDATE secrets SET kek_version = 7 WHERE id = $1', [id]);
    await expect(keyCheck(client, { current: key })).rejects.toThrow(/version de clé inconnue \(7 ; courante 1\)/);
  });

  test('assert_rekey_complete (I1) : rotation interrompue puis reprise, aucune ligne sous l’ancienne version', async () => {
    const oldKey = newKey();
    const newK = newKey();
    const store = await openStore({ current: oldKey });
    const owner = await newUser();
    const expected = new Map<string, string>();
    for (let n = 0; n < 25; n += 1) {
      const value = canary();
      expected.set(await store.put({ ownerId: n % 2 ? owner : null, kind: 'llm_api_key', label: `s${n}`, value }), value);
    }
    const keyring = { current: newK, previous: oldKey };

    // Coupure après le premier lot (10 lignes validées).
    const crash = new Error('coupure simulée');
    await expect(
      rekey(client, keyring, {
        batchSize: 10,
        afterBatch: () => {
          throw crash;
        },
      }),
    ).rejects.toBe(crash);
    const mid = await client.query<{ v: number; n: number }>('SELECT kek_version AS v, count(*)::int AS n FROM secrets GROUP BY 1 ORDER BY 1');
    expect(mid.rows).toEqual([{ v: 1, n: 15 }, { v: 2, n: 10 }]);
    // Pendant la rotation, ni l'ancienne ni la nouvelle clé ne démarrent l'instance.
    await expect(keyCheck(client, { current: oldKey })).rejects.toThrow(/rotation de clé inachevée/);
    await expect(keyCheck(client, { current: newK })).rejects.toThrow(/rotation de clé inachevée/);
    // Reprise avec une troisième clé : refus.
    await expect(rekey(client, { current: newKey(), previous: oldKey })).rejects.toThrow(/rotation déjà commencée/);

    // Reprise : les 15 restantes.
    expect(await rekey(client, keyring, { batchSize: 10 })).toEqual({ status: 'done', from: 1, to: 2, rotated: 15, unreadable: 0 });
    const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM secrets WHERE kek_version <> 2 OR state <> 'ok'");
    expect(rows[0]?.n).toBe(0);
    expect((await client.query('SELECT 1 FROM settings WHERE key = $1', [REKEY_STATE_SETTING])).rowCount).toBe(0);

    // key_check mis à jour : la nouvelle clé seule démarre, toutes les valeurs sont intactes.
    await expect(keyCheck(client, { current: oldKey })).rejects.toThrow(/MASTER_KEY ne correspond pas/);
    const store2 = await openStore({ current: newK });
    for (const [id, value] of expected) expect((await store2.get(id)).reveal()).toBe(value);
    // MASTER_KEY_PREVIOUS retirable ; une relance ne fait rien.
    expect((await rekey(client, keyring)).status).toBe('already_done');
    await expect(rekey(client, { current: newK })).rejects.toThrow(/MASTER_KEY_PREVIOUS .* requise/);
    await expect(rekey(client, { current: newKey(), previous: oldKey })).rejects.toThrow(/MASTER_KEY_PREVIOUS ne correspond pas/);
  });

  test('assert_rekey_complete : toute colonne chiffrée est couverte par rekey ou le bloque', async () => {
    const { rows } = await client.query<{ col: string }>(`
      SELECT table_name || '.' || column_name AS col FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE '%ciphertext%' ORDER BY 1`);
    const listed = ENCRYPTED_COLUMNS.filter((c) => c.column !== 'value').map((c) => `${c.table}.${c.column}`).sort();
    expect(rows.map((r) => r.col)).toEqual(listed);

    // Une colonne différée (site_sessions, tâche 1.10) non vide : rekey refuse au lieu de l'oublier.
    const oldKey = newKey();
    await keyCheck(client, { current: oldKey });
    const owner = await newUser();
    await client.query(
      "INSERT INTO site_sessions (owner_id, domain, server_use_allowed, ciphertext, nonce, key_version) VALUES ($1, 'example.test', true, '\\x00', '\\x00', 1)",
      [owner],
    );
    await expect(rekey(client, { current: newKey(), previous: oldKey })).rejects.toThrow(/site_sessions\.ciphertext.*tâche 1\.10/);
  });

  test('assert_no_secret_in_logs (I1) : pino et run_logs après usage d’un secret canari → 0 occurrence', async () => {
    const store = await openStore({ current: newKey() });
    const owner = await newUser();
    const runId = await newRun(owner);
    const value = `${canary()}"level":50`;
    const id = await store.put({ ownerId: owner, kind: 'proxy_password', label: 'proxy', value });
    secretValues.clear(); // le processus qui lit n'est pas celui qui a écrit : l'ouverture doit suffire
    const secret = await store.get(id);

    const lines: string[] = [];
    const logger = pino({ level: 'trace', ...loggerRedaction() }, { write: (s: string) => void lines.push(s) });
    const proxyUrl = `http://user:${encodeURIComponent(secret.reveal())}@proxy.example:8080`;
    logger.info({ secret }, 'secret typé');
    logger.info(`appel avec ${secret.reveal()}`);
    logger.info({ url: proxyUrl, headers: { authorization: `Bearer ${secret.reveal()}` } }, 'requête');
    logger.error(new Error(`refus du proxy ${proxyUrl}`));

    const data = { value: secret.reveal(), url: proxyUrl, nested: [{ detail: `x ${secret.reveal()} y` }] };
    await appendRunLog(client, { runId, seq: 1, ownerId: owner, level: 'info', event: `proxy ${secret.reveal()}`, data });
    await appendRunLog(client, { runId, seq: 2, ownerId: owner, level: 'error', event: 'échec', data: { err: String(new Error(secret.reveal())) } });

    const logged = lines.join('\n');
    const { rows } = await client.query<{ t: string }>('SELECT event || coalesce(data::text, \'\') AS t FROM run_logs ORDER BY seq');
    const stored = rows.map((r) => r.t).join('\n');
    for (const form of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) {
      expect(logged).not.toContain(form);
      expect(stored).not.toContain(form);
    }
    expect(lines).toHaveLength(4);
    expect(rows).toHaveLength(2);
    expect(stored).toContain('[REDACTED]');
  });
});

describe(`relecture 0.3a sur PostgreSQL ${inject('pgVersion')}`, () => {
  async function extraClient(): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: tdb.url });
    await c.connect();
    opened.push(c);
    return c;
  }

  test('1 : rekey concurrent avec un lecteur à l’ancienne clé → 0 ligne unreadable', async () => {
    const [oldKey, newK] = [newKey(), newKey()];
    const reader = secretStore(await extraClient(), { current: oldKey }, await keyCheck(client, { current: oldKey }));
    const ids: string[] = [];
    for (let n = 0; n < 12; n += 1) ids.push(await reader.put({ ownerId: null, kind: 'llm_api_key', label: `s${n}`, value: canary() }));
    const errors: unknown[] = [];
    await rekey(client, { current: newK, previous: oldKey }, {
      batchSize: 4,
      afterBatch: async () => {
        for (const id of ids) await reader.get(id).catch((e: unknown) => errors.push(e));
      },
    });
    for (const id of ids) await reader.get(id).catch((e: unknown) => errors.push(e));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e instanceof SecretVersionMismatchError)).toBe(true);
    const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM secrets WHERE state = 'unreadable'");
    expect(rows[0]?.n).toBe(0);
  });

  test('2a : rekey refusé tant qu’une instance tient le verrou partagé des secrets', async () => {
    const [oldKey, newK] = [newKey(), newKey()];
    await keyCheck(client, { current: oldKey });
    const instance = await extraClient();
    const release = await holdSecretsLock(instance);
    await expect(rekey(client, { current: newK, previous: oldKey })).rejects.toThrow(/des instances tournent encore.*arrêtez-les/);
    await release();
    expect((await rekey(client, { current: newK, previous: oldKey })).status).toBe('done');
  });

  test('2b : put() refusé pendant une rotation et après, avec l’ancienne clé', async () => {
    const [oldKey, newK] = [newKey(), newKey()];
    const old = await openStore({ current: oldKey });
    await old.put({ ownerId: null, kind: 'llm_api_key', label: 'a', value: canary() });
    await old.put({ ownerId: null, kind: 'llm_api_key', label: 'b', value: canary() });
    const stop = new Error('coupure');
    await expect(
      rekey(client, { current: newK, previous: oldKey }, { batchSize: 1, afterBatch: () => { throw stop; } }),
    ).rejects.toBe(stop);
    await expect(old.put({ ownerId: null, kind: 'llm_api_key', label: 'c', value: canary() })).rejects.toThrow(RekeyInProgressError);
    await rekey(client, { current: newK, previous: oldKey });
    await expect(old.put({ ownerId: null, kind: 'llm_api_key', label: 'd', value: canary() })).rejects.toThrow(RekeyInProgressError);
    const { rows } = await client.query<{ v: number; n: number }>('SELECT kek_version AS v, count(*)::int AS n FROM secrets GROUP BY 1');
    expect(rows).toEqual([{ v: 2, n: 2 }]);
    expect((await keyCheck(client, { current: newK })).status).toBe('ok');
  });

  test('10 : échange du seul dek_wrapped entre deux lignes, ou changement de kind → illisible', async () => {
    const store = await openStore({ current: newKey() });
    const owner = await newUser();
    const a = await store.put({ ownerId: owner, kind: 'llm_api_key', label: 'a', value: canary() });
    const b = await store.put({ ownerId: owner, kind: 'llm_api_key', label: 'b', value: canary() });
    const c = await store.put({ ownerId: owner, kind: 'llm_api_key', label: 'c', value: canary() });
    await client.query(
      `UPDATE secrets t SET dek_wrapped = s.dek_wrapped FROM secrets s
       WHERE (t.id, s.id) IN (($1::uuid, $2::uuid), ($2::uuid, $1::uuid))`,
      [a, b],
    );
    await client.query("UPDATE secrets SET kind = 'proxy_url' WHERE id = $1", [c]);
    for (const id of [a, b, c]) await expect(store.get(id)).rejects.toThrow(SecretUnreadableError);
  });

  test('10 : canari réaliste (espace ! ~ " :) via en-tête Basic, form-encoded et Authorization majuscule → 0 occurrence', async () => {
    const store = await openStore({ current: newKey() });
    const owner = await newUser();
    const runId = await newRun(owner);
    const value = `${canary()} p@ss!~"x:y`;
    const id = await store.put({ ownerId: owner, kind: 'proxy_password', label: 'p', value });
    secretValues.clear();
    const s = (await store.get(id)).reveal();
    const basic = `Basic ${Buffer.from(`user:${s}`).toString('base64')}`;
    const form = new URLSearchParams({ password: s, q: s }).toString();
    const lines: string[] = [];
    const logger = pino({ ...loggerRedaction() }, { write: (l: string) => void lines.push(l) });
    logger.info({ headers: { Authorization: basic } }, 'basic');
    logger.info({ body: form }, `form ${form}`);
    logger.info({ proxy: `http://user:${encodeURIComponent(s)}@p.example/?sig=${encodeURIComponent(s)}&q=${encodeURIComponent(s)}` }, 'url');
    await appendRunLog(client, { runId, seq: 1, ownerId: owner, level: 'info', event: 'x', data: { basic, form } });
    const { rows } = await client.query<{ t: string }>('SELECT data::text AS t FROM run_logs');
    const all = lines.join('\n') + rows.map((r) => r.t).join('\n');
    const b64 = Buffer.from(`user:${s}`).toString('base64');
    for (const form2 of [s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s), new URLSearchParams({ q: s }).toString().slice(2), b64.slice(8, 24)]) {
      expect(all).not.toContain(form2);
    }
  });
});
