// SPDX-License-Identifier: AGPL-3.0-only
// Concordance schéma Drizzle ↔ base migrée, et garde-fous du modèle de données (cdc/sym-browser 03 § 5) :
// machine à états des sessions (04 § 5), verrou de profil (04c § 4.2), comptage exact (BINV5), isolation par client (BINV1, BINV7).
import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers/pg.js';
import { TABLES } from './index.js';
import { migrateUp } from './migrate.js';
import * as schema from './schema.js';

let tdb: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  tdb = await createTestDatabase('schema');
  await migrateUp({ connectionString: tdb.url });
  client = new pg.Client({ connectionString: tdb.url });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await tdb.drop();
});

const tables = Object.values(schema as Record<string, unknown>).filter((v): v is PgTable => is(v, PgTable));
const norm = (type: string) => type.replace(/,\s+/g, ',');

type Row = Record<string, unknown>;
async function one(sql: string, params: unknown[] = []): Promise<Row> {
  const { rows } = await client.query(sql, params);
  return rows[0] as Row;
}
async function id(sql: string, params: unknown[] = []): Promise<string> {
  return (await one(sql, params)).id as string;
}
/** Exécute `sql`, attend une erreur PostgreSQL de code `code` (23505 unique, 23503 FK, 23514 CHECK, 23502 NOT NULL). Autocommit : l'échec n'annule que l'instruction. */
async function rejects(code: string, sql: string, params: unknown[] = []): Promise<void> {
  await expect(client.query(sql, params)).rejects.toMatchObject({ code });
}

const tenant = (name: string) => id('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name]);
const apiKey = (tenantId: string, prefix: string) =>
  id("INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, $2, '$argon2id$v=19$m=19456,t=2,p=1$x$y', ARRAY['sessions:write','sessions:read']) RETURNING id", [tenantId, prefix]);
const node = (nodeId: string, total = 4) =>
  client.query(
    "INSERT INTO nodes (id, url, region, playwright_version, chromium_version, app_version, slots_total, slots_free) VALUES ($1, 'http://node:3000', 'default', '1.63.0', '153.0.8010.12', '0.0.0', $2, $2)",
    [nodeId, total],
  );
const session = (tenantId: string, keyId: string, extra = '', params: unknown[] = []) =>
  id(`INSERT INTO sessions (tenant_id, api_key_id, type, expires_at${extra ? ', ' + extra.split('|')[0] : ''}) VALUES ($1, $2, 'dedicated', now() + interval '5 minutes'${extra ? ', ' + extra.split('|')[1] : ''}) RETURNING id`, [tenantId, keyId, ...params]);

describe(`schéma de SYM Browser sur PostgreSQL ${inject('pgVersion')}`, () => {
  test('mêmes tables en base, dans TABLES et dans le schéma Drizzle (les neuf tables de 03 § 5)', async () => {
    const { rows } = await client.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'symb_schema_migrations' ORDER BY 1",
    );
    expect(rows.map((r) => r.t)).toEqual([...TABLES].sort());
    expect(tables.map((t) => getTableName(t)).sort()).toEqual([...TABLES].sort());
  });

  test.each(tables.map((t) => [getTableName(t), t] as const))('%s : colonnes, types et nullabilité concordent avec Drizzle', async (name, table) => {
    const { rows } = await client.query<{ col: string; type: string; notnull: boolean }>(
      `SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
       FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname`,
      [`public.${name}`],
    );
    const expected = getTableConfig(table)
      .columns.map((c) => ({ col: c.name, type: norm(c.getSQLType()), notnull: c.notNull || c.primary }))
      .sort((a, b) => a.col.localeCompare(b.col));
    expect(rows.map((r) => ({ col: r.col, type: norm(r.type), notnull: r.notnull }))).toEqual(expected);
  });

  test('clients : noms uniques, quotas positifs ou nuls, quotas par défaut posés', async () => {
    const t = await one("INSERT INTO tenants (name) VALUES ('quotas') RETURNING *");
    expect(Number(t.max_concurrent_sessions)).toBeGreaterThan(0);
    expect(Number(t.max_session_seconds)).toBeGreaterThan(0);
    await rejects('23505', "INSERT INTO tenants (name) VALUES ('quotas')");
    await rejects('23514', "INSERT INTO tenants (name, max_concurrent_sessions) VALUES ('neg', -1)");
    await rejects('23514', "INSERT INTO tenants (name, monthly_bytes) VALUES ('neg2', -1)");
  });

  test('clés d’API : scopes fermés et non vides, préfixe unique, empreinte obligatoire', async () => {
    const t = await tenant('keys');
    await apiKey(t, 'symb_k1');
    await rejects('23505', "INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, 'symb_k1', 'h', ARRAY['admin'])", [t]);
    await rejects('23514', "INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, 'symb_k2', 'h', ARRAY['root'])", [t]);
    await rejects('23514', "INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, 'symb_k3', 'h', ARRAY[]::text[])", [t]);
    await rejects('23502', "INSERT INTO api_keys (tenant_id, key_prefix, scopes) VALUES ($1, 'symb_k4', ARRAY['admin'])", [t]);
    const ok = await one("INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, 'symb_k5', 'h', ARRAY['sessions:write','sessions:read','profiles:write','admin']) RETURNING scopes", [t]);
    expect(ok.scopes).toHaveLength(4);
  });

  test('nœuds : états fermés, slots libres entre 0 et le total, réservation atomique conditionnelle', async () => {
    await node('node-a', 3);
    await rejects('23505', "INSERT INTO nodes (id, url, playwright_version, chromium_version, app_version, slots_total, slots_free) VALUES ('node-a', 'u', 'p', 'c', 'a', 1, 1)");
    await rejects('23514', "UPDATE nodes SET state = 'broken' WHERE id = 'node-a'");
    await rejects('23514', "UPDATE nodes SET slots_free = 4 WHERE id = 'node-a'");
    await rejects('23514', "UPDATE nodes SET slots_free = -1 WHERE id = 'node-a'");
    const first = await client.query("UPDATE nodes SET slots_free = slots_free - 2 WHERE id = 'node-a' AND slots_free >= 2");
    const second = await client.query("UPDATE nodes SET slots_free = slots_free - 2 WHERE id = 'node-a' AND slots_free >= 2");
    expect([first.rowCount, second.rowCount]).toEqual([1, 0]);
    const n = await one("SELECT state, region, last_beat_at FROM nodes WHERE id = 'node-a'");
    expect(n.state).toBe('ready');
    expect(n.region).toBe('default');
    expect(n.last_beat_at).toBeInstanceOf(Date);
  });

  test('sessions : identifiant réservable par l’appelant, doublon refusé (409 session_id_taken)', async () => {
    const t = await tenant('s-id');
    const k = await apiKey(t, 'symb_s1');
    const reserved = '6f1c0000-0000-4000-8000-000000000001';
    await client.query("INSERT INTO sessions (id, tenant_id, api_key_id, type, expires_at) VALUES ($1, $2, $3, 'shared', now() + interval '1 minute')", [reserved, t, k]);
    await rejects('23505', "INSERT INTO sessions (id, tenant_id, api_key_id, type, expires_at) VALUES ($1, $2, $3, 'shared', now())", [reserved, t, k]);
    const row = await one('SELECT state, options, egress_policy, metadata, ended_at, end_reason FROM sessions WHERE id = $1', [reserved]);
    expect(row).toMatchObject({ state: 'pending', options: {}, egress_policy: {}, metadata: {}, ended_at: null, end_reason: null });
  });

  test('sessions : types, états et raisons de fin fermés', async () => {
    const t = await tenant('s-enum');
    const k = await apiKey(t, 'symb_s2');
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, expires_at) VALUES ($1, $2, 'weird', now())", [t, k]);
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, state, expires_at) VALUES ($1, $2, 'shared', 'paused', now())", [t, k]);
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, state, end_reason, ended_at, expires_at) VALUES ($1, $2, 'shared', 'ended', 'bored', now(), now())", [t, k]);
  });

  test('sessions : état terminal cohérent avec raison et date de fin (04 § 5)', async () => {
    const t = await tenant('s-fsm');
    const k = await apiKey(t, 'symb_s3');
    const ins = (state: string, reason: string | null, ended: boolean, started = true) =>
      client.query(
        `INSERT INTO sessions (tenant_id, api_key_id, type, state, end_reason, started_at, ended_at, expires_at)
         VALUES ($1, $2, 'dedicated', $3, $4, ${started ? 'now()' : 'NULL'}, ${ended ? 'now()' : 'NULL'}, now() + interval '1 minute')`,
        [t, k, state, reason],
      );
    // Valides, une ligne par couple (état, raison) de la table de 04 § 5.
    for (const [state, reason] of [
      ['ended', 'released'], ['ended', 'budget_exceeded'], ['ended', 'node_shutdown'], ['ended', 'quota'],
      ['timed_out', 'timeout'], ['timed_out', 'idle'], ['failed', 'crash'], ['failed', 'node_lost'], ['failed', 'quota'],
    ] as const) {
      await ins(state, reason, true);
    }
    await ins('pending', null, false, false);
    await ins('running', null, false);
    // Invalides.
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, state, end_reason, ended_at, expires_at) VALUES ($1, $2, 'shared', 'ended', 'crash', now(), now())", [t, k]);
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, state, end_reason, ended_at, expires_at) VALUES ($1, $2, 'shared', 'timed_out', 'released', now(), now())", [t, k]);
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, state, end_reason, ended_at, expires_at) VALUES ($1, $2, 'shared', 'failed', 'released', now(), now())", [t, k]);
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, state, expires_at) VALUES ($1, $2, 'shared', 'ended', now())", [t, k]); // terminal sans raison ni date
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, state, end_reason, expires_at) VALUES ($1, $2, 'shared', 'running', 'released', now())", [t, k]); // raison sans état terminal
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, state, started_at, expires_at) VALUES ($1, $2, 'shared', 'pending', now(), now())", [t, k]); // pending déjà démarrée
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, state, started_at, ended_at, end_reason, expires_at) VALUES ($1, $2, 'shared', 'ended', now(), now() - interval '1 hour', 'released', now())", [t, k]); // fin avant début
  });

  test('sessions : metadata objet JSON, profil et mode ensemble ou absents', async () => {
    const t = await tenant('s-meta');
    const k = await apiKey(t, 'symb_s4');
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, metadata, expires_at) VALUES ($1, $2, 'shared', '[1]', now())", [t, k]);
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, options, expires_at) VALUES ($1, $2, 'shared', '\"x\"', now())", [t, k]);
    const p = await id("INSERT INTO profiles (tenant_id, name) VALUES ($1, 'p') RETURNING id", [t]);
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, profile_id, expires_at) VALUES ($1, $2, 'dedicated', $3, now())", [t, k, p]);
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, profile_mode, expires_at) VALUES ($1, $2, 'dedicated', 'read', now())", [t, k]);
    await rejects('23514', "INSERT INTO sessions (tenant_id, api_key_id, type, profile_id, profile_mode, expires_at) VALUES ($1, $2, 'shared', $3, 'read', now())", [t, k, p]); // un profil implique dedicated
    await client.query("INSERT INTO sessions (tenant_id, api_key_id, type, profile_id, profile_mode, metadata, expires_at) VALUES ($1, $2, 'dedicated', $3, 'write', '{\"job\":\"j1\"}', now())", [t, k, p]);
  });

  test('isolation par client : une session, un profil ou une clé d’un autre client est refusé par clé étrangère', async () => {
    const t1 = await tenant('iso-1');
    const t2 = await tenant('iso-2');
    const k1 = await apiKey(t1, 'symb_i1');
    const k2 = await apiKey(t2, 'symb_i2');
    const p1 = await id("INSERT INTO profiles (tenant_id, name) VALUES ($1, 'p') RETURNING id", [t1]);
    await rejects('23503', "INSERT INTO sessions (tenant_id, api_key_id, type, expires_at) VALUES ($1, $2, 'shared', now())", [t1, k2]); // clé d'un autre client
    await rejects('23503', "INSERT INTO sessions (tenant_id, api_key_id, type, profile_id, profile_mode, expires_at) VALUES ($1, $2, 'dedicated', $3, 'read', now())", [t2, k2, p1]); // profil d'un autre client
    const s1 = await session(t1, k1);
    await rejects('23503', "INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source) VALUES ($1, $2, $3, 'node-a', now(), now(), 0, 0, 0, 0, 'node')", [s1, t2, k2]);
  });

  test('profils : nom unique par client, version et clé d’objet cohérentes, taille positive', async () => {
    const t = await tenant('profiles');
    const k = await apiKey(t, 'symb_p1');
    const empty = await one("INSERT INTO profiles (tenant_id, name) VALUES ($1, 'main') RETURNING *", [t]);
    expect(empty).toMatchObject({ version: 0, object_key: null, lock_session_id: null });
    expect(Number(empty.size_bytes)).toBe(0);
    await rejects('23505', "INSERT INTO profiles (tenant_id, name) VALUES ($1, 'main')", [t]);
    const other = await tenant('profiles-other');
    await client.query("INSERT INTO profiles (tenant_id, name) VALUES ($1, 'main')", [other]); // même nom, autre client
    await rejects('23514', "INSERT INTO profiles (tenant_id, name, version) VALUES ($1, 'v1', 1)", [t]); // version sans objet
    await rejects('23514', "INSERT INTO profiles (tenant_id, name, object_key) VALUES ($1, 'k0', 'profiles/x/y/v1')", [t]); // objet sans version
    await rejects('23514', "INSERT INTO profiles (tenant_id, name, size_bytes) VALUES ($1, 'neg', -1)", [t]);
    await client.query("UPDATE profiles SET version = 1, object_key = 'profiles/t/p/v1', size_bytes = 10 WHERE id = $1", [empty.id]);

    // Verrou d'écriture exclusif de 04c § 4.2 : un seul porteur ; une session terminée le laisse prendre.
    const s1 = await session(t, k);
    const s2 = await session(t, k);
    const lock = "UPDATE profiles SET lock_session_id = $2 WHERE id = $1 AND (lock_session_id IS NULL OR lock_session_id IN (SELECT id FROM sessions WHERE state IN ('ended', 'timed_out', 'failed')))";
    expect((await client.query(lock, [empty.id, s1])).rowCount).toBe(1);
    expect((await client.query(lock, [empty.id, s2])).rowCount).toBe(0);
    await client.query("UPDATE sessions SET state = 'ended', end_reason = 'released', started_at = now(), ended_at = now() WHERE id = $1", [s1]);
    expect((await client.query(lock, [empty.id, s2])).rowCount).toBe(1);
    await rejects('23503', 'UPDATE profiles SET lock_session_id = $2 WHERE id = $1', [empty.id, '00000000-0000-4000-8000-0000000000ff']);
  });

  test('profils de proxy : types fermés, port valide, identifiants chiffrés optionnels, nom unique par client', async () => {
    const t = await tenant('proxies');
    const base = "INSERT INTO proxy_profiles (tenant_id, name, type, host, port) VALUES ($1, $2, $3, 'proxy.example.test', $4)";
    for (const [i, type] of ['http', 'https', 'socks5'].entries()) await client.query(base, [t, `p${i}`, type, 8080]);
    await rejects('23514', base, [t, 'bad-type', 'ftp', 8080]);
    await rejects('23514', base, [t, 'bad-port0', 'http', 0]);
    await rejects('23514', base, [t, 'bad-port', 'http', 70000]);
    await rejects('23505', base, [t, 'p0', 'http', 8080]);
    const row = await one("INSERT INTO proxy_profiles (tenant_id, name, type, host, port, kind, credentials_encrypted) VALUES ($1, 'enc', 'socks5', 'h', 1080, 'isp', 'v1.AAAA') RETURNING dns_via_proxy, kind, credentials_encrypted", [t]);
    expect(row).toMatchObject({ dns_via_proxy: true, kind: 'isp', credentials_encrypted: 'v1.AAAA' });
    await rejects('23514', "INSERT INTO proxy_profiles (tenant_id, name, type, host, port, kind) VALUES ($1, 'k', 'http', 'h', 1, 'residential')", [t]);
  });

  test('événements de session : types fermés, ordre total par identifiant, supprimés avec la session', async () => {
    const t = await tenant('events');
    const k = await apiKey(t, 'symb_e1');
    const s = await session(t, k);
    for (const type of ['state', 'egress.blocked', 'egress.budget_exceeded', 'download', 'recording.ready', 'recording.truncated', 'profile.save_failed', 'storage_state.exported', 'live.input']) {
      await client.query("INSERT INTO session_events (session_id, type, data) VALUES ($1, $2, '{\"x\":1}')", [s, type]);
    }
    await rejects('23514', "INSERT INTO session_events (session_id, type) VALUES ($1, 'mystery')", [s]);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM session_events WHERE session_id = $1 ORDER BY id', [s]);
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.id)).size).toBe(9);
    await client.query('DELETE FROM sessions WHERE id = $1', [s]);
    expect((await one('SELECT count(*)::int AS n FROM session_events WHERE session_id = $1', [s])).n).toBe(0);
  });

  test('artefacts : types fermés, taille positive, expiration obligatoire, supprimés avec la session', async () => {
    const t = await tenant('artifacts');
    const k = await apiKey(t, 'symb_a1');
    const s = await session(t, k);
    const ins = "INSERT INTO artifacts (session_id, type, object_key, size_bytes, expires_at) VALUES ($1, $2, 'sessions/x/y', $3, now() + interval '24 hours')";
    for (const type of ['trace', 'har', 'video', 'console', 'network', 'download']) await client.query(ins, [s, type, 10]);
    await rejects('23514', ins, [s, 'screenshot', 10]);
    await rejects('23514', ins, [s, 'trace', -1]);
    await rejects('23502', "INSERT INTO artifacts (session_id, type, object_key, size_bytes) VALUES ($1, 'har', 'k', 1)", [s]);
    await client.query('DELETE FROM sessions WHERE id = $1', [s]);
    expect((await one('SELECT count(*)::int AS n FROM artifacts WHERE session_id = $1', [s])).n).toBe(0);
  });

  test('assert_usage_reconciled (BINV5, base) : secondes facturées = ceil(durée en ms / 1000), à la seconde près', async () => {
    const t = await tenant('usage');
    const k = await apiKey(t, 'symb_u1');
    await node('node-u');
    const ins = (sessionId: string, ms: number, billed: number, extra = 'node') =>
      client.query(
        "INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source) VALUES ($1, $2, $3, 'node-u', now() - interval '1 minute', now(), $4, $5, 100, 200, $6)",
        [sessionId, t, k, ms, billed, extra],
      );
    const cases: Array<[number, number]> = [[0, 0], [1, 1], [999, 1], [1000, 1], [1001, 2], [61_500, 62]];
    for (const [ms, billed] of cases) await ins(await session(t, k), ms, billed);
    await rejects('23514', "INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source) VALUES ($1, $2, $3, 'node-u', now(), now(), 1001, 1, 0, 0, 'node')", [await session(t, k), t, k]); // arrondi vers le bas
    await rejects('23514', "INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source) VALUES ($1, $2, $3, 'node-u', now(), now(), 1000, 2, 0, 0, 'node')", [await session(t, k), t, k]); // sur-facturation
    const s = await session(t, k);
    await rejects('23514', "INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source) VALUES ($1, $2, $3, 'node-u', now(), now(), 1000, 1, -1, 0, 'node')", [s, t, k]);
    await rejects('23514', "INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source) VALUES ($1, $2, $3, 'node-u', now(), now(), 1000, 1, 0, 0, 'guess')", [s, t, k]);
    await rejects('23514', "INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source) VALUES ($1, $2, $3, 'node-u', now(), now() - interval '1 hour', 1000, 1, 0, 0, 'node')", [s, t, k]);
  });

  test('usage : une ligne par session (clé primaire), écriture idempotente, reconstruction remplaçable par la mesure du nœud', async () => {
    const t = await tenant('usage-idem');
    const k = await apiKey(t, 'symb_u2');
    await node('node-i');
    const s = await session(t, k);
    const upsert = (ms: number, billed: number, source: string) =>
      client.query(
        `INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source)
         VALUES ($1, $2, $3, 'node-i', now(), now(), $4, $5, 1, 2, $6)
         ON CONFLICT (session_id) DO UPDATE SET browser_ms = EXCLUDED.browser_ms, billed_seconds = EXCLUDED.billed_seconds, source = EXCLUDED.source, updated_at = now()`,
        [s, t, k, ms, billed, source],
      );
    await upsert(5000, 5, 'reconstructed');
    await upsert(5200, 6, 'node');
    await upsert(5200, 6, 'node');
    expect(await one('SELECT count(*)::int AS n, max(billed_seconds) AS b, max(source) AS s FROM usage_records WHERE session_id = $1', [s])).toMatchObject({ n: 1, b: '6', s: 'node' });
    // Le comptage survit à la session : on ne supprime pas une session comptée.
    await rejects('23503', 'DELETE FROM sessions WHERE id = $1', [s]);
  });

  test('relations : on ne supprime pas un client, une clé ou un nœud référencés par des sessions', async () => {
    const t = await tenant('restrict');
    const k = await apiKey(t, 'symb_r1');
    await node('node-r');
    await client.query("INSERT INTO sessions (tenant_id, api_key_id, node_id, type, expires_at) VALUES ($1, $2, 'node-r', 'shared', now())", [t, k]);
    await rejects('23503', 'DELETE FROM tenants WHERE id = $1', [t]);
    await rejects('23503', 'DELETE FROM api_keys WHERE id = $1', [k]);
    await rejects('23503', "DELETE FROM nodes WHERE id = 'node-r'");
  });

  test('index : routage session → nœud, quotas de sessions simultanées, filtre metadata, purge des expirations', async () => {
    const { rows } = await client.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'");
    const defs = rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/ON public\.sessions USING btree \(tenant_id, created_at/);
    expect(defs).toMatch(/ON public\.sessions USING btree \(node_id\)/);
    expect(defs).toMatch(/ON public\.sessions USING gin \(metadata/);
    expect(defs).toMatch(/ON public\.artifacts USING btree \(expires_at\)/);
    expect(defs).toMatch(/ON public\.session_events USING btree \(session_id, id\)/);
    expect(defs).toMatch(/ON public\.usage_records USING btree \(tenant_id, ended_at\)/);
    expect(defs).toMatch(/ON public\.usage_records USING btree \(api_key_id, ended_at\)/);
  });
});
