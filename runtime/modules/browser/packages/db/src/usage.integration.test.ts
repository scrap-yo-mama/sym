// SPDX-License-Identifier: AGPL-3.0-only
// Comptage en base (cdc/sym-browser 04d § 4.1, § 4.3, § 4.4 ; tâche 2.6, BINV5) sur PostgreSQL réel :
//   - clôture dans la même instruction que l'état final (une transition refusée n'écrit aucun usage) ;
//   - clôture seule idempotente (rejeu de usage.wal), qui remplace une valeur reconstruite et jamais une mesure ;
//   - reconstruction des sessions d'un nœud perdu sur sa dernière mesure reçue (`source: reconstructed`) ;
//   - réconciliation : écart mesuré contre usage.wal, corrigé, écart restant 0, rapport gardé ;
//   - agrégats de l'API d'usage (par clé, jour, session ; période [from, to)).
import type { UsageClosure } from '@sym-browser/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { recordHeartbeat, sweepLostNodes, transitionSession, type NodeBeat } from './sessions.js';
import { lastUsageReconciliation, queryUsage, reconcileUsage, recordUsage, recordUsageSnapshots } from './usage.js';

let tdb: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let keyA: string;
let keyB: string;

const beat = (nodeId: string): NodeBeat => ({
  nodeId,
  url: `http://${nodeId}.internal:3000`,
  region: 'default',
  playwrightVersion: '1.63.0',
  chromiumVersion: '153.0.8010.12',
  appVersion: '0.0.0',
  slotsTotal: 8,
  slotsFree: 8,
  rssBytes: null,
  limitBytes: null,
});

async function id(sql: string, params: unknown[] = []): Promise<string> {
  return (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';
}

beforeAll(async () => {
  tdb = await createTestDatabase('usage');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  tenant = await id("INSERT INTO tenants (name) VALUES ('u') RETURNING id");
  const key = (prefix: string) =>
    id("INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, $2, 'h', ARRAY['sessions:read']) RETURNING id", [tenant, prefix]);
  keyA = await key('symb_ua');
  keyB = await key('symb_ub');
  await recordHeartbeat(pool, beat('node-u1'));
  await recordHeartbeat(pool, beat('node-u2'));
});
afterAll(async () => {
  await pool.end();
  await tdb.drop();
});

async function running(nodeId: string, apiKeyId = keyA): Promise<string> {
  const sessionId = await id("INSERT INTO sessions (tenant_id, api_key_id, type, expires_at) VALUES ($1, $2, 'dedicated', now() + interval '1 hour') RETURNING id", [tenant, apiKeyId]);
  expect((await transitionSession(pool, { sessionId, to: 'running', reason: null, nodeId })).ok).toBe(true);
  return sessionId;
}

const closure = (sessionId: string, nodeId: string, browserMs: number, startedAt = Date.UTC(2026, 9, 2, 10), bytes: [number, number] = [0, 0]): UsageClosure => ({
  sessionId,
  nodeId,
  startedAt,
  browserMs,
  bytesIn: bytes[0],
  bytesOut: bytes[1],
});

async function usageRow(sessionId: string) {
  const { rows } = await pool.query(
    'SELECT browser_ms::int, billed_seconds::int, bytes_in::int, bytes_out::int, source, started_at, ended_at, api_key_id, tenant_id FROM usage_records WHERE session_id = $1',
    [sessionId],
  );
  return rows[0];
}

describe('clôture', () => {
  test('état final et usage dans la même instruction ; ceil(ms / 1000) ; ended_at = started_at + durée', async () => {
    const s = await running('node-u1');
    const startedAt = Date.UTC(2026, 9, 2, 10, 0, 0, 250);
    const outcome = await transitionSession(pool, { sessionId: s, to: 'ended', reason: 'released', usage: closure(s, 'node-u1', 61_001, startedAt, [5_000, 700]) });
    expect(outcome.ok).toBe(true);
    const row = await usageRow(s);
    expect(row).toMatchObject({ browser_ms: 61_001, billed_seconds: 62, bytes_in: 5_000, bytes_out: 700, source: 'node', api_key_id: keyA, tenant_id: tenant });
    expect(row.started_at.getTime()).toBe(startedAt);
    expect(row.ended_at.getTime()).toBe(startedAt + 61_001);
  });

  test('transition refusée (session déjà terminée) : aucun usage écrit par cette instruction', async () => {
    const s = await running('node-u1');
    await transitionSession(pool, { sessionId: s, to: 'failed', reason: 'node_lost' });
    const outcome = await transitionSession(pool, { sessionId: s, to: 'ended', reason: 'released', usage: closure(s, 'node-u1', 1_000) });
    expect(outcome).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(await usageRow(s)).toBeUndefined();
    // La clôture arrive seule (comme le fait le superviseur) : la suite ne voit pas de session à reconstruire.
    expect(await recordUsage(pool, closure(s, 'node-u1', 1_000))).toBe('inserted');
  });

  test('clôture seule : insérée, rejouée sans effet, jamais écrasée par une autre mesure ; session inconnue signalée', async () => {
    const s = await running('node-u1');
    expect(await recordUsage(pool, closure(s, 'node-u1', 3_000))).toBe('inserted');
    expect(await recordUsage(pool, closure(s, 'node-u1', 3_000))).toBe('unchanged');
    expect(await recordUsage(pool, closure(s, 'node-u1', 9_000))).toBe('unchanged');
    expect(await usageRow(s)).toMatchObject({ browser_ms: 3_000, billed_seconds: 3 });
    expect(await recordUsage(pool, closure('00000000-0000-4000-8000-000000000000', 'node-u1', 1))).toBe('not_found');
  });
});

describe('nœud perdu, reconstruction et réconciliation', () => {
  test('reconstruit sur le dernier instantané, puis remplacé par la mesure de usage.wal ; écart mesuré puis nul', async () => {
    await recordHeartbeat(pool, beat('node-lost'));
    const measured = await running('node-lost', keyB);
    const unseen = await running('node-lost', keyB);
    const t0 = Date.UTC(2026, 9, 2, 11);
    await recordUsageSnapshots(pool, 'node-lost', [closure(measured, 'node-lost', 20_000, t0, [100, 10]), closure(unseen, 'node-lost', 8_500, t0, [50, 5])]);
    await recordUsageSnapshots(pool, 'node-lost', [closure(measured, 'node-lost', 30_000, t0, [300, 30])]); // instantané plus récent
    await pool.query("UPDATE nodes SET last_beat_at = now() - interval '1 minute' WHERE id = 'node-lost'");
    expect((await sweepLostNodes(pool)).sessions.sort()).toEqual([measured, unseen].sort());

    // Première réconciliation : le journal du nœud perdu est hors d'atteinte ; ses sessions sont reconstruites.
    const first = await reconcileUsage(pool, { closures: [] });
    expect(first).toMatchObject({ reconstructed: 2, inserted: 0, replaced: 0, remainingDriftSeconds: 0, remainingDriftBytes: 0 });
    expect(await usageRow(measured)).toMatchObject({ browser_ms: 30_000, billed_seconds: 30, bytes_in: 300, bytes_out: 30, source: 'reconstructed' });
    expect(await usageRow(unseen)).toMatchObject({ browser_ms: 8_500, billed_seconds: 9, source: 'reconstructed' });

    // Le nœud revient avec sa clôture réelle (36,2 s) : écart de 7 s mesuré, corrigé, puis plus rien à corriger.
    const wal = [closure(measured, 'node-lost', 36_200, t0, [420, 42])];
    const second = await reconcileUsage(pool, { closures: wal });
    expect(second).toMatchObject({ replaced: 1, driftSeconds: 7, driftBytes: 132, remainingDriftSeconds: 0, remainingDriftBytes: 0 });
    expect(await usageRow(measured)).toMatchObject({ browser_ms: 36_200, billed_seconds: 37, bytes_in: 420, bytes_out: 42, source: 'node' });
    const third = await reconcileUsage(pool, { closures: wal });
    expect(third).toMatchObject({ inserted: 0, replaced: 0, reconstructed: 0, driftSeconds: 0, driftBytes: 0 });
    expect(await lastUsageReconciliation(pool)).toMatchObject({ driftSeconds: 0, remainingDriftSeconds: 0 });
  });

  test('session terminée sans clôture ni instantané (fin écrite par la passerelle) : reconstruite sur ses dates', async () => {
    const s = await running('node-u2');
    await pool.query("UPDATE sessions SET started_at = now() - interval '5 seconds' WHERE id = $1", [s]);
    await transitionSession(pool, { sessionId: s, to: 'ended', reason: 'released' });
    await reconcileUsage(pool, { closures: [] });
    const row = await usageRow(s);
    expect(row.source).toBe('reconstructed');
    expect(row.browser_ms).toBeGreaterThanOrEqual(5_000);
    expect(row.billed_seconds).toBe(Math.ceil(row.browser_ms / 1000));
  });

  test('clôture du journal absente de la base (base injoignable à la fin) : insérée par la réconciliation, écart compté', async () => {
    const s = await running('node-u2');
    const report = await reconcileUsage(pool, { closures: [closure(s, 'node-u2', 4_001, Date.UTC(2026, 9, 2, 12), [10, 20])] });
    expect(report).toMatchObject({ inserted: 1, driftSeconds: 5, driftBytes: 30, remainingDriftSeconds: 0 });
  });
});

describe('agrégats de l’API d’usage', () => {
  test('par clé, par jour et par session sur [from, to) ; totaux = somme des lignes', async () => {
    const t = await id("INSERT INTO tenants (name) VALUES ('agg') RETURNING id");
    const k1 = await id("INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, 'symb_g1', 'h', ARRAY['sessions:read']) RETURNING id", [t]);
    const k2 = await id("INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, 'symb_g2', 'h', ARRAY['sessions:read']) RETURNING id", [t]);
    const make = async (key: string, start: number, ms: number, bytes: [number, number]) => {
      const s = await id("INSERT INTO sessions (tenant_id, api_key_id, type, expires_at) VALUES ($1, $2, 'shared', now() + interval '1 hour') RETURNING id", [t, key]);
      await transitionSession(pool, { sessionId: s, to: 'running', reason: null, nodeId: 'node-u1' });
      await transitionSession(pool, { sessionId: s, to: 'ended', reason: 'released', usage: closure(s, 'node-u1', ms, start, bytes) });
      return s;
    };
    const d1 = Date.UTC(2026, 8, 1, 10);
    const d2 = Date.UTC(2026, 8, 2, 23, 59, 59);
    await make(k1, d1, 1_500, [10, 1]);
    await make(k1, d2, 999, [20, 2]); // finit le 3 septembre à 00:00:00.998
    await make(k2, d1, 60_000, [30, 3]);
    await make(k2, Date.UTC(2026, 9, 1), 1_000, [1, 1]); // hors période
    const from = new Date(Date.UTC(2026, 8, 1));
    const to = new Date(Date.UTC(2026, 9, 1));

    const byKey = await queryUsage(pool, { tenantId: t, from, to, groupBy: ['key'] });
    expect(byKey.items).toEqual([
      { apiKeyId: k1, apiKeyPrefix: 'symb_g1', sessions: 2, billedSeconds: 3, bytesIn: 30, bytesOut: 3 },
      { apiKeyId: k2, apiKeyPrefix: 'symb_g2', sessions: 1, billedSeconds: 60, bytesIn: 30, bytesOut: 3 },
    ].sort((a, b) => a.apiKeyId.localeCompare(b.apiKeyId)));
    expect(byKey.totals).toEqual({ sessions: 3, billedSeconds: 63, bytesIn: 60, bytesOut: 6 });

    const byDay = await queryUsage(pool, { tenantId: t, from, to, groupBy: ['key', 'day'], apiKeyId: k1 });
    expect(byDay.items.map((i) => [i.day, i.billedSeconds])).toEqual([
      ['2026-09-01', 2],
      ['2026-09-03', 1],
    ]);
    expect(byDay.totals).toEqual({ sessions: 2, billedSeconds: 3, bytesIn: 30, bytesOut: 3 });

    const bySession = await queryUsage(pool, { tenantId: t, from, to, groupBy: ['session'] });
    expect(bySession.items).toHaveLength(3);
    expect(bySession.items.every((i) => i.sessions === 1 && typeof i.sessionId === 'string')).toBe(true);
    expect(bySession.totals).toEqual(byKey.totals);

    // Un autre client ne voit rien.
    expect((await queryUsage(pool, { tenantId: tenant, from, to, groupBy: ['key'], apiKeyId: k1 })).totals).toEqual({ sessions: 0, billedSeconds: 0, bytesIn: 0, bytesOut: 0 });
  });
});
