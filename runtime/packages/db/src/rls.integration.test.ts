// SPDX-License-Identifier: AGPL-3.0-only
// RLS en SQL brut (INV12, 15 § 5, migration 0003) : sous `runtime_app`, l'utilisateur B ne lit ni n'écrit aucune ligne
// de A, sur TOUTES les tables portant owner_id (découvertes dans le catalogue, pas listées à la main) ; journal d'audit
// en ajout seul (assert_audit_append_only) ; propriétés du rôle applicatif.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createTestDatabase, withClient, type TestDatabase } from '../../../tests/helpers/pg.js';
import { appendAudit } from './audit.js';
import { migrateUp } from './migrate.js';
import { APP_ROLE, withActor } from './rls.js';

let tdb: TestDatabase;
let pool: pg.Pool;
let ownerTables: string[];
const A = randomUUID();
const B = randomUUID();
const ADMIN = randomUUID();

async function expectDenied(promise: Promise<unknown>, code = '42501'): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  tdb = await createTestDatabase('rls');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 3 });
  ownerTables = (
    await pool.query<{ t: string }>(`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'owner_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`)
  ).rows.map((r) => r.t);

  // Jeu de données de A (identité système : propriétaire des tables).
  await withClient(tdb.url, async (c) => {
    for (const [id, email, role] of [[A, 'zz_test_a@example.test', 'member'], [B, 'zz_test_b@example.test', 'member'], [ADMIN, 'zz_test_admin@example.test', 'admin']]) {
      await c.query("INSERT INTO users (id, email, role, status) VALUES ($1, $2, $3, 'active')", [id, email, role]);
    }
    const api = (await c.query<{ id: string }>("INSERT INTO apis (slug, owner_id, requires_session) VALUES ('zz_test_a_private', $1, true) RETURNING id", [A])).rows[0]!.id;
    await c.query("INSERT INTO apis (slug, owner_id, visibility) VALUES ('zz_test_a_shared', $1, 'instance')", [A]);
    await c.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', 'user')", [api, A]);
    const run = (await c.query<{ id: string }>(
      "INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, input) VALUES ($1, $2, $2, 'rest', '{\"secret_input\": 1}') RETURNING id",
      [api, A],
    )).rows[0]!.id;
    await c.query("INSERT INTO run_attempts (run_id, seq, owner_id, execution, network) VALUES ($1, 1, $2, 'fetch', 'direct')", [run, A]);
    await c.query("INSERT INTO run_logs (run_id, seq, owner_id, level, event) VALUES ($1, 1, $2, 'info', 'zz_test')", [run, A]);
    await c.query("INSERT INTO run_artifacts (run_id, owner_id, kind, bytes, sensitivity, ciphertext, nonce, key_version) VALUES ($1, $2, 'trace', 1, 'high', '\\x00', '\\x00', 1)", [run, A]);
    await c.query("INSERT INTO investigation_events (run_id, seq, owner_id, kind) VALUES ($1, 1, $2, 'zz_test')", [run, A]);
    // Quarantaine D-49 (0017, 2.3) : échantillon et raisons du run de A, jamais lisibles par B.
    await c.query(
      `INSERT INTO run_rejected_items (run_id, api_id, owner_id, total_rejected, by_reason, sample) VALUES ($1, $2, $3, 1, '[{"keyword":"type","instance_path":"/x","count":1}]', '[{"x":"[masqué]"}]')`,
      [run, api, A],
    );
    // Règles Markdown (2.10, 0018) : fichier privé de A et source d'une version de A.
    const rule = (await c.query<{ id: string }>("INSERT INTO rule_files (owner_id, kind, name, description, applies_to, current_version) VALUES ($1, 'rule', 'zz-test-a', 'zz', '{*}', 1) RETURNING id", [A])).rows[0]!.id;
    const content = '---\nname: zz-test-a\n---\nzz\n';
    await c.query("INSERT INTO rule_file_versions (rule_file_id, version, content, sha256, description, applies_to, origin) VALUES ($1, 1, $2, encode(sha256(convert_to($2, 'UTF8')), 'hex'), 'zz', '{*}', 'ui')", [rule, content]);
    await c.query("INSERT INTO strategy_version_rules (api_id, strategy_version, owner_id, rule_file_id, rule_version, sha256, level, loaded) SELECT $1, 1, $2, $3, 1, sha256, 'domain', 'injected' FROM rule_file_versions WHERE rule_file_id = $3", [api, A, rule]);
    await c.query("INSERT INTO status_events (api_id, owner_id, to_status) VALUES ($1, $2, 'sain')", [api, A]);
    const ds = (await c.query<{ id: string }>('INSERT INTO datasets (api_id, run_id, owner_id) VALUES ($1, $2, $3) RETURNING id', [api, run, A])).rows[0]!.id;
    await c.query("INSERT INTO dataset_items (dataset_id, seq, owner_id, item, size_bytes) VALUES ($1, 1, $2, '{\"x\": 1}', 8)", [ds, A]);
    await c.query("INSERT INTO dedup_keys (api_id, key_hash, owner_id) VALUES ($1, 'zz_test', $2)", [api, A]);
    await c.query("INSERT INTO schedules (api_id, owner_id, cron) VALUES ($1, $2, '0 * * * *')", [api, A]);
    await c.query("INSERT INTO site_sessions (owner_id, domain, server_use_allowed, ciphertext, nonce, dek_wrapped, alg, key_version) VALUES ($1, 'zz-test.example', true, '\\x00', '\\x00', '\\x00', 'aes-256-gcm', 1)", [A]);
    const tunnel = (await c.query<{ id: string }>("INSERT INTO tunnels (owner_id, device_id, token_hash, expires_at) VALUES ($1, 'zz_test', 'zz_test_hash', now() + interval '1 day') RETURNING id", [A])).rows[0]!.id;
    await c.query("INSERT INTO tunnel_jobs (run_id, tunnel_id, owner_id, cmd, domain) VALUES ($1, $2, $3, 'page_fetch', 'zz-test.example')", [run, tunnel, A]);
    await c.query("INSERT INTO extension_pairing_codes (owner_id, code_hash, expires_at) VALUES ($1, 'zz_test_code_hash', now() + interval '5 minutes')", [A]);
    const sub = (await c.query<{ id: string }>("INSERT INTO webhook_subscriptions (owner_id, url) VALUES ($1, 'https://zz-test.example/hook') RETURNING id", [A])).rows[0]!.id;
    await c.query('INSERT INTO webhook_deliveries (subscription_id, owner_id, event, dispatch_id) VALUES ($1, $2, $3, $4)', [sub, A, 'zz_test', randomUUID()]);
    await c.query(
      "INSERT INTO secrets (owner_id, kind, label, ciphertext, nonce, aad, dek_wrapped, kek_version) VALUES ($1, 'zz_test', 'zz_test', '\\x00', '\\x00', '\\x00', '\\x00', 1)",
      [A],
    );
    await c.query("INSERT INTO api_keys (user_id, label, prefix, key_hash, expires_at) VALUES ($1, 'zz_test', 'sy_live_zz', 'zz_test_key_hash', now() + interval '1 day')", [A]);
  });
});
afterAll(async () => {
  await pool.end();
  await tdb.drop();
});

describe(`RLS sur PostgreSQL ${inject('pgVersion')}`, () => {
  test('rôle applicatif : ni superutilisateur, ni BYPASSRLS, propriétaire d’aucune table', async () => {
    const role = (await pool.query('SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1', [APP_ROLE])).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    const owned = await pool.query("SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = $1", [APP_ROLE]);
    expect(owned.rowCount).toBe(0);
  });

  test('RLS active sur chaque table portant owner_id, et sur api_keys', async () => {
    expect(ownerTables.length).toBeGreaterThanOrEqual(18);
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1) AND relnamespace = 'public'::regnamespace",
      [[...ownerTables, 'api_keys']],
    );
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
    expect(rows).toHaveLength(ownerTables.length + 1);
  });

  test('assert_cross_user_denied (SQL brut) : B ne lit aucune ligne de A, sur toutes les tables à owner_id', async () => {
    const seeded = await withClient(tdb.url, async (c) => {
      const out: Record<string, number> = {};
      for (const t of ownerTables) out[t] = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE owner_id = $1`, [A])).rows[0]!.n;
      return out;
    });
    // Toutes les tables ont au moins une ligne de A : le test porte sur des données réelles.
    expect(Object.entries(seeded).filter(([, n]) => n === 0)).toEqual([]);

    for (const actor of [{ userId: B, role: 'member' as const }, { userId: ADMIN, role: 'admin' as const }, null]) {
      await withActor(pool, actor, async (db) => {
        for (const t of ownerTables) {
          const visible = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE owner_id = $1`, [A])).rows[0]!.n;
          // Seule exception prévue (13 § 3) : l'API de A partagée en `instance` sans session, lisible par un autre utilisateur.
          const expected = actor && t === 'apis' ? 1 : 0;
          expect(visible, `${t} vu par ${actor?.role ?? 'anonyme'}`).toBe(expected);
        }
        expect((await db.query("SELECT slug FROM apis")).rows).toEqual(actor ? [{ slug: 'zz_test_a_shared' }] : []);
        expect((await db.query('SELECT 1 FROM api_keys')).rowCount).toBe(0);
      });
    }
  });

  test('B n’écrit aucune ligne de A : UPDATE et DELETE sans effet, INSERT au nom de A refusé', async () => {
    await withActor(pool, { userId: B, role: 'member' }, async (db) => {
      for (const t of ownerTables) {
        expect((await db.query(`UPDATE ${t} SET owner_id = owner_id WHERE owner_id = $1`, [A])).rowCount, `UPDATE ${t}`).toBe(0);
        expect((await db.query(`DELETE FROM ${t} WHERE owner_id = $1`, [A])).rowCount, `DELETE ${t}`).toBe(0);
      }
      expect((await db.query('UPDATE api_keys SET revoked_at = now() WHERE user_id = $1', [A])).rowCount).toBe(0);
    });
    // Rien n'a bougé côté A.
    const intact = await withClient(tdb.url, async (c) => (await c.query("SELECT count(*)::int AS n FROM apis WHERE owner_id = $1", [A])).rows[0]!.n);
    expect(intact).toBe(2);
    // Écrire au nom de A, ou réattribuer une ligne à A : refusé par WITH CHECK.
    const client = await pool.connect();
    try {
      for (const sql of [
        ["INSERT INTO apis (slug, owner_id) VALUES ('zz_test_b_as_a', $1)", [A]],
        ["INSERT INTO site_sessions (owner_id, domain) VALUES ($1, 'zz-test-b.example')", [A]],
        ["INSERT INTO api_keys (user_id, label, prefix, key_hash, expires_at) VALUES ($1, 'x', 'x', 'zz_b_as_a', now() + interval '1 day')", [A]],
      ] as const) {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
        await client.query("SELECT set_config('app.user_id', $1, true)", [B]);
        await expectDenied(client.query(sql[0], [...sql[1]]));
        await client.query('ROLLBACK');
      }
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await client.query("SELECT set_config('app.user_id', $1, true)", [B]);
      await client.query("INSERT INTO apis (slug, owner_id) VALUES ('zz_test_b_own', $1)", [B]);
      await expectDenied(client.query('UPDATE apis SET owner_id = $1 WHERE owner_id = $2', [A, B]));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  test('A voit et modifie ses propres lignes', async () => {
    await withActor(pool, { userId: A, role: 'member' }, async (db) => {
      for (const t of ownerTables) {
        const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;
        expect(n, t).toBeGreaterThan(0);
      }
      expect((await db.query('UPDATE api_keys SET last_used_at = now() WHERE user_id = $1', [A])).rowCount).toBe(1);
    });
  });

  test('vues d’administration : métadonnées pour admin et owner, rien pour un autre membre', async () => {
    await withActor(pool, { userId: ADMIN, role: 'admin' }, async (db) => {
      expect((await db.query('SELECT * FROM admin_run_metadata WHERE owner_id = $1', [A])).rowCount).toBe(1);
      expect((await db.query('SELECT * FROM admin_dataset_usage WHERE owner_id = $1', [A])).rowCount).toBe(1);
      expect((await db.query('SELECT * FROM runs WHERE owner_id = $1', [A])).rowCount).toBe(0);
    });
    await withActor(pool, { userId: B, role: 'member' }, async (db) => {
      expect((await db.query('SELECT * FROM admin_run_metadata WHERE owner_id = $1', [A])).rowCount).toBe(0);
      expect((await db.query('SELECT * FROM admin_dataset_usage WHERE owner_id = $1', [A])).rowCount).toBe(0);
    });
  });

  test('tables d’auth et utilisateurs inaccessibles au rôle applicatif', async () => {
    for (const t of ['users', 'auth_sessions', 'auth_accounts', 'verifications', 'two_factor', 'backup_codes', 'settings']) {
      await expectDenied(withActor(pool, { userId: A, role: 'member' }, (db) => db.query(`SELECT 1 FROM ${t}`)));
    }
  });

  test('assert_audit_append_only : INSERT permis, SELECT, UPDATE, DELETE et TRUNCATE refusés au rôle applicatif', async () => {
    await withActor(pool, { userId: A, role: 'member' }, (db) =>
      appendAudit(db, { actorUserId: A, actorVia: 'ui', action: 'zz_test.event', outcome: 'success', meta: { password: 'zz_test_pw', label: 'ok' } }),
    );
    for (const sql of ['SELECT * FROM audit_events', "UPDATE audit_events SET action = 'x'", 'DELETE FROM audit_events', 'TRUNCATE audit_events']) {
      await expectDenied(withActor(pool, { userId: A, role: 'admin' }, (db) => db.query(sql)));
    }
    const row = (await pool.query("SELECT meta FROM audit_events WHERE action = 'zz_test.event'")).rows[0];
    expect(row.meta).toEqual({ password: '[REDACTED]', label: 'ok' });
  });

  test('portée transaction : après withActor, la connexion revient à l’identité système sans paramètre', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await client.query("SELECT set_config('app.user_id', $1, true)", [A]);
      await client.query('COMMIT');
      const { rows } = await client.query("SELECT current_user = session_user AS system, coalesce(current_setting('app.user_id', true), '') AS uid");
      expect(rows[0]).toEqual({ system: true, uid: '' });
    } finally {
      client.release();
    }
  });
});
