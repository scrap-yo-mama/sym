// SPDX-License-Identifier: AGPL-3.0-only
// Comptes avancés côté base (tâche 3.7, 13 § 6 et § 10, X5) : clone et transfert d'API sans jamais copier ni
// réaffecter une session de site ; désactivation et révocations en cascade ; graine TOTP scellée et anti-rejeu.
import { randomBytes } from 'node:crypto';
import { generateMasterKey, generateTotpSecret, kekFor, MasterKey } from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import {
  ApiNotFoundError,
  cloneApi,
  confirmTwoFactor,
  consumeBackupCode,
  consumeTotpStep,
  deactivateUser,
  loadTwoFactor,
  replaceBackupCodes,
  startTwoFactorEnrollment,
  transferApisWithoutSession,
} from './accounts.js';
import { migrateUp } from './migrate.js';
import { runRetentionTick } from './retention/index.js';

let tdb: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  tdb = await createTestDatabase('accounts');
  await migrateUp({ connectionString: tdb.url });
  client = new pg.Client({ connectionString: tdb.url });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await tdb.drop();
});

async function newUser(): Promise<string> {
  const { rows } = await client.query<{ id: string }>("INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id", [`zz_test_${randomBytes(4).toString('hex')}@example.test`]);
  return rows[0]!.id;
}

async function apiWithSession(ownerId: string, requiresSession: boolean): Promise<string> {
  const slug = `zz_test_api_${randomBytes(4).toString('hex')}`;
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO apis (slug, owner_id, requires_session, status, description) VALUES ($1, $2, $3, 'sain', 'zz_test définition') RETURNING id",
    [slug, ownerId, requiresSession],
  );
  const id = rows[0]!.id;
  await client.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', 'investigation')", [id, ownerId]);
  await client.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return (await client.query<{ n: number }>(sql, params)).rows[0]!.n;
}

describe('assert_clone_no_session (13 § 10, X5)', () => {
  test('une API à session clonée vers un autre utilisateur : aucune ligne site_sessions copiée, statut action_requise', async () => {
    const a = await newUser();
    const b = await newUser();
    const apiId = await apiWithSession(a, true);
    await client.query(
      "INSERT INTO site_sessions (owner_id, domain, server_use_allowed, ciphertext, nonce, dek_wrapped, alg, key_version, captured_at) VALUES ($1, 'zz-test-clone.example', true, $2, $3, $4, 'aes-256-gcm', 1, now())",
      [a, Buffer.from('zz_test_cookie_scelle'), Buffer.from('nonce-nonce1'), Buffer.from('dek-enveloppee')],
    );
    const sessionsBefore = await count('SELECT count(*)::int AS n FROM site_sessions', []);
    await client.query('BEGIN');
    const clone = await cloneApi(client, { apiId, fromOwnerId: a, toOwnerId: b });
    await client.query('COMMIT');
    expect(clone.status).toBe('action_requise');
    expect(await count('SELECT count(*)::int AS n FROM site_sessions', [])).toBe(sessionsBefore);
    expect(await count('SELECT count(*)::int AS n FROM site_sessions WHERE owner_id = $1', [b])).toBe(0);
    const row = (await client.query('SELECT owner_id, status, status_reason, visibility, requires_session, description FROM apis WHERE id = $1', [clone.id])).rows[0];
    expect(row).toEqual({ owner_id: b, status: 'action_requise', status_reason: 'session_required', visibility: 'private', requires_session: true, description: 'zz_test définition' });
    // Versions de stratégie copiées au nouveau propriétaire ; l'original est intact.
    expect((await client.query('SELECT owner_id, version FROM strategy_versions WHERE api_id = $1', [clone.id])).rows).toEqual([{ owner_id: b, version: 1 }]);
    expect((await client.query('SELECT owner_id, status FROM apis WHERE id = $1', [apiId])).rows).toEqual([{ owner_id: a, status: 'sain' }]);
    // Une API sans session clonée repart en enquête (rien n'est garanti chez le nouveau propriétaire).
    const plain = await apiWithSession(a, false);
    expect((await cloneApi(client, { apiId: plain, fromOwnerId: a, toOwnerId: b })).status).toBe('enquete');
    // Jamais par un identifiant seul : l'API d'autrui est introuvable.
    await expect(cloneApi(client, { apiId, fromOwnerId: b, toOwnerId: b })).rejects.toThrow(ApiNotFoundError);
  });

  test('transfert par l’admin : APIs sans session réaffectées (planifications suspendues), APIs avec session jamais réaffectées', async () => {
    const a = await newUser();
    const b = await newUser();
    const withSession = await apiWithSession(a, true);
    const without = await apiWithSession(a, false);
    await client.query("INSERT INTO schedules (api_id, owner_id, cron) VALUES ($1, $2, '0 * * * *')", [without, a]);
    const result = await transferApisWithoutSession(client, a, b);
    expect(result).toEqual({ transferred: [without], kept: [withSession] });
    expect((await client.query('SELECT owner_id FROM apis WHERE id = $1', [withSession])).rows).toEqual([{ owner_id: a }]);
    expect((await client.query('SELECT owner_id FROM strategy_versions WHERE api_id = $1', [without])).rows).toEqual([{ owner_id: b }]);
    expect((await client.query('SELECT owner_id, enabled FROM schedules WHERE api_id = $1', [without])).rows).toEqual([{ owner_id: b, enabled: false }]);
  });
});

describe('désactivation en cascade (13 § 6)', () => {
  test('sessions fermées, clés et jetons révoqués, cookies serveur supprimés, planifications suspendues', async () => {
    const u = await newUser();
    const by = await newUser();
    await client.query("INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [u, randomBytes(16).toString('hex')]);
    await client.query("INSERT INTO api_keys (user_id, label, prefix, key_hash, scopes, expires_at) VALUES ($1, 'k', 'sy_live_x', $2, '{apis:read}', now() + interval '9 days')", [u, randomBytes(16).toString('hex')]);
    await client.query("INSERT INTO tunnels (owner_id, device_id, token_hash, expires_at) VALUES ($1, 'zz_test_dev', $2, now() + interval '9 days')", [u, randomBytes(16).toString('hex')]);
    await client.query("INSERT INTO site_sessions (owner_id, domain, server_use_allowed) VALUES ($1, 'zz-test-deact.example', false)", [u]);
    await client.query("INSERT INTO auth_known_devices (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '9 days')", [u, randomBytes(16).toString('hex')]);
    const api = await apiWithSession(u, false);
    await client.query("INSERT INTO schedules (api_id, owner_id, cron) VALUES ($1, $2, '0 * * * *')", [api, u]);
    const done = await deactivateUser(client, u, by);
    expect(done).toEqual({ sessions: 1, apiKeys: 1, tunnels: 1, siteSessions: 1, knownDevices: 1, schedules: 1 });
    expect((await client.query('SELECT status, disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1', [u])).rows).toEqual([{ status: 'disabled', disabled: true }]);
    expect(await count('SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [u])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM apis WHERE owner_id = $1', [u])).toBe(1);
  });
});

describe('graine TOTP (13 § 7)', () => {
  test('scellée sous MASTER_KEY avec l’AAD de l’utilisateur ; anti-rejeu atomique ; codes de secours à usage unique', async () => {
    const key = MasterKey.parse(generateMasterKey());
    const kek = kekFor(key, 1);
    const u = await newUser();
    const secret = generateTotpSecret();
    expect(await startTwoFactorEnrollment(client, kek, u, secret)).toBe(true);
    expect((await loadTwoFactor(client, kek, u)).status).toBe('pending');
    await confirmTwoFactor(client, u);
    // Une 2FA active n'est jamais remplacée par un nouvel enrôlement.
    expect(await startTwoFactorEnrollment(client, kek, u, generateTotpSecret())).toBe(false);
    const state = await loadTwoFactor(client, kek, u);
    expect(state.status === 'confirmed' && state.secret.equals(secret)).toBe(true);
    const raw = (await client.query<{ secret_ciphertext: Buffer }>('SELECT secret_ciphertext FROM two_factor WHERE user_id = $1', [u])).rows[0]!.secret_ciphertext;
    expect(raw.includes(secret)).toBe(false);
    // Autre clé : illisible, marquée (jamais effacée en silence).
    expect((await loadTwoFactor(client, kekFor(MasterKey.parse(generateMasterKey()), 1), u)).status).toBe('unreadable');
    expect(await count('SELECT count(*)::int AS n FROM two_factor WHERE user_id = $1 AND unreadable_since IS NOT NULL', [u])).toBe(1);
    await client.query('UPDATE two_factor SET unreadable_since = NULL WHERE user_id = $1', [u]);

    expect(await consumeTotpStep(client, u, 100)).toBe(true);
    expect(await consumeTotpStep(client, u, 100)).toBe(false);
    expect(await consumeTotpStep(client, u, 99)).toBe(false);
    expect(await consumeTotpStep(client, u, 101)).toBe(true);

    await replaceBackupCodes(client, u, ['h1', 'h2']);
    expect(await consumeBackupCode(client, u, 'h1')).toBe(true);
    expect(await consumeBackupCode(client, u, 'h1')).toBe(false);
    // Régénération : les anciens codes sont révoqués.
    await replaceBackupCodes(client, u, ['h3']);
    expect(await consumeBackupCode(client, u, 'h2')).toBe(false);
    expect(await consumeBackupCode(client, u, 'h3')).toBe(true);
  });
});

describe('rétention de l’audit réglée par l’owner (13 § 9)', () => {
  test('audit_retention_months appliqué par la passe quotidienne', async () => {
    const pool = new pg.Pool({ connectionString: tdb.url, max: 2 });
    try {
      await client.query("INSERT INTO settings (key, value) VALUES ('security', '{\"audit_retention_months\": 1}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
      await client.query("DELETE FROM settings WHERE key = 'retention_state'");
      const now = new Date();
      await client.query(
        "INSERT INTO audit_events (at, actor_via, action, outcome) VALUES ($1::timestamptz - interval '40 days', 'system', 'zz_test.old', 'success'), ($1::timestamptz - interval '20 days', 'system', 'zz_test.recent', 'success')",
        [now],
      );
      const tick = await runRetentionTick(pool, now);
      expect(tick.daily).toBe(true);
      const left = (await client.query<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'zz_test.%' ORDER BY action")).rows.map((r) => r.action);
      expect(left).toEqual(['zz_test.recent']);
    } finally {
      await client.query("DELETE FROM settings WHERE key = 'security'");
      await pool.end();
    }
  });
});
