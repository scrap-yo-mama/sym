// SPDX-License-Identifier: AGPL-3.0-only
// Registre des profils persistants sur PostgreSQL (cdc/sym-browser 04c § 4.2, tâche 3.1) : verrou d'écriture posé par un
// seul UPDATE atomique (sessions terminées comprises), 2e écriture refusée avec la session qui tient le verrou, bascule du
// pointeur de version et libération du verrou dans la même instruction, cloisonnement par client.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { PgProfileRegistry } from './profiles.js';

let tdb: TestDatabase;
let pool: pg.Pool;
let registry: PgProfileRegistry;

beforeAll(async () => {
  tdb = await createTestDatabase('profiles');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 10 });
  registry = new PgProfileRegistry(pool);
});
afterAll(async () => {
  await pool.end();
  await tdb.drop();
});

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await pool.query(sql, params)).rows[0] as T;
}

async function tenant(): Promise<{ tenantId: string; apiKeyId: string }> {
  const { id: tenantId } = await one<{ id: string }>('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [`t-${randomUUID()}`]);
  const { id: apiKeyId } = await one<{ id: string }>(
    "INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, $2, 'h', ARRAY['sessions:write']) RETURNING id",
    [tenantId, `k-${randomUUID()}`],
  );
  return { tenantId, apiKeyId };
}

async function session(t: { tenantId: string; apiKeyId: string }, profileId: string, mode: 'read' | 'write'): Promise<string> {
  const row = await one<{ id: string }>(
    "INSERT INTO sessions (tenant_id, api_key_id, type, profile_id, profile_mode, expires_at) VALUES ($1, $2, 'dedicated', $3, $4, now() + interval '1 hour') RETURNING id",
    [t.tenantId, t.apiKeyId, profileId, mode],
  );
  return row.id;
}

async function endSession(id: string, state: 'ended' | 'timed_out' | 'failed' = 'ended'): Promise<void> {
  const reason = { ended: 'released', timed_out: 'timeout', failed: 'crash' }[state];
  await pool.query("UPDATE sessions SET state = $2, end_reason = $3, started_at = now() - interval '1 second', ended_at = now() WHERE id = $1", [id, state, reason]);
}

describe('PgProfileRegistry (04c § 4.2)', () => {
  test('create puis get : profil vide (version 0, sans objet ni verrou) ; nom unique par client', async () => {
    const t = await tenant();
    const profileId = await registry.create(t.tenantId, 'fixture');
    expect(await registry.get(t.tenantId, profileId)).toEqual({ tenantId: t.tenantId, profileId, name: 'fixture', version: 0, objectKey: null, sizeBytes: 0, lockSessionId: null });
    await expect(registry.create(t.tenantId, 'fixture')).rejects.toMatchObject({ code: '23505' });
  });

  test('verrou d’écriture : posé pour la 1re session, refusé à la 2e avec lockedBySession, rejouable par son détenteur', async () => {
    const t = await tenant();
    const profileId = await registry.create(t.tenantId, 'verrou');
    const s1 = await session(t, profileId, 'write');
    const s2 = await session(t, profileId, 'write');
    expect(await registry.acquireWriteLock(t.tenantId, profileId, s1)).toMatchObject({ ok: true, profile: { version: 0, lockSessionId: s1 } });
    expect(await registry.acquireWriteLock(t.tenantId, profileId, s2)).toEqual({ ok: false, reason: 'locked', lockedBySession: s1 });
    expect(await registry.acquireWriteLock(t.tenantId, profileId, s1)).toMatchObject({ ok: true });
  });

  test('20 demandes simultanées sur des connexions distinctes : un seul verrou posé', async () => {
    const t = await tenant();
    const profileId = await registry.create(t.tenantId, 'course');
    const sessions = await Promise.all(Array.from({ length: 20 }, () => session(t, profileId, 'write')));
    const results = await Promise.all(sessions.map((s) => registry.acquireWriteLock(t.tenantId, profileId, s)));
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const holder = (await registry.get(t.tenantId, profileId))!.lockSessionId;
    for (const r of results.filter((x) => !x.ok)) expect(r).toEqual({ ok: false, reason: 'locked', lockedBySession: holder });
  });

  test.each(['ended', 'timed_out', 'failed'] as const)('verrou d’une session terminée (%s) : repris par la suivante', async (state) => {
    const t = await tenant();
    const profileId = await registry.create(t.tenantId, `reprise-${state}`);
    const dead = await session(t, profileId, 'write');
    expect((await registry.acquireWriteLock(t.tenantId, profileId, dead)).ok).toBe(true);
    await endSession(dead, state);
    const next = await session(t, profileId, 'write');
    expect(await registry.acquireWriteLock(t.tenantId, profileId, next)).toMatchObject({ ok: true, profile: { lockSessionId: next } });
  });

  test('commitVersion : v{n+1}, clé, taille, verrou libéré dans la même instruction ; refusée sans le verrou ou hors séquence', async () => {
    const t = await tenant();
    const profileId = await registry.create(t.tenantId, 'versions');
    const s1 = await session(t, profileId, 'write');
    const other = await session(t, profileId, 'write');
    await registry.acquireWriteLock(t.tenantId, profileId, s1);
    const key = (v: number) => `profiles/${t.tenantId}/${profileId}/v${v}`;
    expect(await registry.commitVersion(t.tenantId, profileId, other, { version: 1, objectKey: key(1), sizeBytes: 10 })).toBe(false);
    expect(await registry.commitVersion(t.tenantId, profileId, s1, { version: 2, objectKey: key(2), sizeBytes: 10 })).toBe(false);
    expect(await registry.commitVersion(t.tenantId, profileId, s1, { version: 1, objectKey: key(1), sizeBytes: 1234 })).toBe(true);
    expect(await registry.get(t.tenantId, profileId)).toMatchObject({ version: 1, objectKey: key(1), sizeBytes: 1234, lockSessionId: null });
    // Sans verrou, plus de commit possible pour s1.
    expect(await registry.commitVersion(t.tenantId, profileId, s1, { version: 2, objectKey: key(2), sizeBytes: 1 })).toBe(false);
  });

  test('releaseLock : seulement par son détenteur, idempotent', async () => {
    const t = await tenant();
    const profileId = await registry.create(t.tenantId, 'libération');
    const s1 = await session(t, profileId, 'write');
    const s2 = await session(t, profileId, 'write');
    await registry.acquireWriteLock(t.tenantId, profileId, s1);
    await registry.releaseLock(t.tenantId, profileId, s2);
    expect((await registry.get(t.tenantId, profileId))!.lockSessionId).toBe(s1);
    await registry.releaseLock(t.tenantId, profileId, s1);
    await registry.releaseLock(t.tenantId, profileId, s1);
    expect((await registry.get(t.tenantId, profileId))!.lockSessionId).toBeNull();
  });

  test('cloisonnement par client : profil d’un autre client introuvable, verrou impossible', async () => {
    const a = await tenant();
    const b = await tenant();
    const profileId = await registry.create(a.tenantId, 'à A');
    const sb = await session(b, (await registry.create(b.tenantId, 'à B')), 'write');
    expect(await registry.get(b.tenantId, profileId)).toBeUndefined();
    expect(await registry.acquireWriteLock(b.tenantId, profileId, sb)).toEqual({ ok: false, reason: 'not_found' });
    expect(await registry.acquireWriteLock(a.tenantId, randomUUID(), sb)).toEqual({ ok: false, reason: 'not_found' });
  });
});
