// SPDX-License-Identifier: AGPL-3.0-only
// Admission des sessions sur PostgreSQL (cdc/sym-browser 04b § 7, 04d § 4.2, tâche 2.4) : file FIFO en base (sessions
// `pending` sans nœud), sessions simultanées par client, file bornée (globale et par client), choix du nœud au plus faible
// taux d'occupation (à égalité, le plus anciennement servi), poids des sessions en unités de slot (0.6), décisions
// sérialisées : jamais plus de sessions placées que de slots, même avec des passerelles concurrentes.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers/pg.js';
import { abandonQueuedSession, admitQueued, enqueueSession, monthlyUsage, type EnqueueRequest, type QueueLimits } from './admission.js';
import { migrateUp } from './migrate.js';
import { recordHeartbeat, transitionSession } from './sessions.js';

let tdb: TestDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  tdb = await createTestDatabase('admission');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 12 });
});
afterAll(async () => {
  await pool.end();
  await tdb.drop();
});

// Chaque test part d'un parc vide : les nœuds et les sessions des tests précédents ne pèsent pas.
beforeEach(async () => {
  await pool.query("UPDATE nodes SET state = 'down'");
  await pool.query("UPDATE sessions SET state = 'failed', end_reason = 'quota', ended_at = now() WHERE state = 'pending'");
  await pool.query("UPDATE sessions SET state = 'ended', end_reason = 'released', ended_at = now() WHERE state = 'running'");
});

const LIMITS: QueueLimits = { queueMax: 50, queueMaxPerTenant: 10 };

async function tenant(maxConcurrent = 10): Promise<{ tenantId: string; apiKeyId: string }> {
  const t = await pool.query<{ id: string }>('INSERT INTO tenants (name, max_concurrent_sessions) VALUES ($1, $2) RETURNING id', [`t-${randomUUID()}`, maxConcurrent]);
  const tenantId = t.rows[0]!.id;
  const k = await pool.query<{ id: string }>("INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, $2, 'h', ARRAY['sessions:write']) RETURNING id", [tenantId, `k-${randomUUID()}`]);
  return { tenantId, apiKeyId: k.rows[0]!.id };
}

async function node(id: string, slotsTotal: number, region = 'default'): Promise<void> {
  await recordHeartbeat(pool, { nodeId: id, url: `http://${id}.internal:3000`, region, playwrightVersion: '1.63.0', chromiumVersion: '153.0.8010.12', appVersion: '0.0.0', slotsTotal, slotsFree: slotsTotal, rssBytes: null, limitBytes: null });
  await pool.query("UPDATE nodes SET state = 'ready' WHERE id = $1", [id]);
}

function request(t: { tenantId: string; apiKeyId: string }, extra: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return { tenantId: t.tenantId, apiKeyId: t.apiKeyId, type: 'dedicated', region: null, timeoutSeconds: 300, options: {}, egressPolicy: {}, metadata: {}, slotWeight: 4, ...extra };
}

const queued = async (tenantId: string) =>
  (await pool.query<{ id: string }>("SELECT id FROM sessions WHERE tenant_id = $1 AND state = 'pending' AND node_id IS NULL ORDER BY created_at, id", [tenantId])).rows.map((r) => r.id);

async function enqueueOk(r: EnqueueRequest, limits = LIMITS) {
  const outcome = await enqueueSession(pool, r, limits);
  if (!outcome.ok) throw new Error(`refus inattendu : ${JSON.stringify(outcome)}`);
  return outcome;
}

describe('enqueueSession : sessions simultanées et file bornée', () => {
  test('quota 3, 5 demandes : 3 placées tout de suite, 2 en file ; la 6e (file du client pleine à 2) → quota_exceeded', async () => {
    await node('n-recette', 64);
    const t = await tenant(3);
    const outcomes = [];
    for (let i = 0; i < 5; i += 1) outcomes.push(await enqueueOk(request(t), { queueMax: 50, queueMaxPerTenant: 2 }));
    expect(outcomes.map((o) => o.admitted)).toEqual([true, true, true, false, false]);
    expect(outcomes.slice(0, 3).every((o) => o.nodeId === 'n-recette')).toBe(true);
    expect(await queued(t.tenantId)).toEqual(outcomes.slice(3).map((o) => o.session.id));
    expect(outcomes.map((o) => o.queuePosition)).toEqual([0, 0, 0, 1, 2]);
    const refused = await enqueueSession(pool, request(t), { queueMax: 50, queueMaxPerTenant: 2 });
    expect(refused).toEqual({ ok: false, code: 'quota_exceeded', quota: 'concurrent_sessions' });
    expect(await queued(t.tenantId)).toHaveLength(2);
  });

  test('quota 2, file par client 0 : la 3e demande → quota_exceeded, aucune session écrite', async () => {
    await node('n-a11', 64);
    const t = await tenant(2);
    await enqueueOk(request(t), { queueMax: 50, queueMaxPerTenant: 0 });
    await enqueueOk(request(t), { queueMax: 50, queueMaxPerTenant: 0 });
    const before = await pool.query('SELECT count(*)::int AS n FROM sessions WHERE tenant_id = $1', [t.tenantId]);
    expect(await enqueueSession(pool, request(t), { queueMax: 50, queueMaxPerTenant: 0 })).toEqual({ ok: false, code: 'quota_exceeded', quota: 'concurrent_sessions' });
    const after = await pool.query('SELECT count(*)::int AS n FROM sessions WHERE tenant_id = $1', [t.tenantId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  test('file globale pleine (QUEUE_MAX) faute de slots : capacity_exceeded {queue_max}', async () => {
    await node('n-plein', 4);
    const a = await tenant(10);
    const b = await tenant(10);
    expect((await enqueueOk(request(a), { queueMax: 2, queueMaxPerTenant: 10 })).admitted).toBe(true);
    expect((await enqueueOk(request(a), { queueMax: 2, queueMaxPerTenant: 10 })).admitted).toBe(false);
    expect((await enqueueOk(request(b), { queueMax: 2, queueMaxPerTenant: 10 })).admitted).toBe(false);
    expect(await enqueueSession(pool, request(b), { queueMax: 2, queueMaxPerTenant: 10 })).toEqual({ ok: false, code: 'capacity_exceeded', limit: 'queue_max' });
  });

  test('file du client pleine faute de slots (client sous son quota) : capacity_exceeded {queue_max_per_tenant}', async () => {
    await node('n-petit', 4);
    const t = await tenant(10);
    await enqueueOk(request(t), { queueMax: 50, queueMaxPerTenant: 1 });
    await enqueueOk(request(t), { queueMax: 50, queueMaxPerTenant: 1 });
    expect(await enqueueSession(pool, request(t), { queueMax: 50, queueMaxPerTenant: 1 })).toEqual({ ok: false, code: 'capacity_exceeded', limit: 'queue_max_per_tenant' });
  });

  test('identifiant réservé déjà pris : session_id_taken', async () => {
    await node('n-id', 64);
    const t = await tenant();
    const id = randomUUID();
    await enqueueOk(request(t, { id }));
    expect(await enqueueSession(pool, request(t, { id }), LIMITS)).toEqual({ ok: false, code: 'session_id_taken' });
  });
});

describe('admitQueued', () => {
  test('queue_fifo : à la libération des slots, les sessions en file sont servies dans l’ordre d’arrivée', async () => {
    await node('n-fifo', 4);
    const t = await tenant(10);
    const first = await enqueueOk(request(t));
    const waiting = [];
    for (let i = 0; i < 3; i += 1) waiting.push((await enqueueOk(request(t))).session.id);
    const served: string[] = [];
    let current = first.session.id;
    for (let i = 0; i < 3; i += 1) {
      await transitionSession(pool, { sessionId: current, to: 'failed', reason: 'crash' });
      const admitted = await admitQueued(pool);
      expect(admitted).toHaveLength(1);
      served.push(admitted[0]!.sessionId);
      current = admitted[0]!.sessionId;
    }
    expect(served).toEqual(waiting);
  });

  test('node_choice_least_loaded : nœuds à 20 % et 60 % → la session part sur celui à 20 % ; à égalité, le moins récemment servi', async () => {
    await node('n-20', 20);
    await node('n-60', 20);
    const filler = await tenant(50);
    for (let i = 0; i < 4; i += 1) await pool.query("INSERT INTO sessions (tenant_id, api_key_id, type, node_id, slot_weight, state, started_at, expires_at) VALUES ($1, $2, 'dedicated', 'n-20', 1, 'running', now(), now() + interval '1 hour')", [filler.tenantId, filler.apiKeyId]);
    for (let i = 0; i < 12; i += 1) await pool.query("INSERT INTO sessions (tenant_id, api_key_id, type, node_id, slot_weight, state, started_at, expires_at) VALUES ($1, $2, 'dedicated', 'n-60', 1, 'running', now(), now() + interval '1 hour')", [filler.tenantId, filler.apiKeyId]);
    const t = await tenant(10);
    expect((await enqueueOk(request(t))).nodeId).toBe('n-20');

    await node('n-x', 8);
    await node('n-y', 8);
    await pool.query("UPDATE nodes SET state = 'down' WHERE id IN ('n-20', 'n-60')");
    // Égalité (0 %) : le nœud jamais servi passe avant celui qui vient de l'être.
    const a = await enqueueOk(request(t));
    await transitionSession(pool, { sessionId: a.session.id, to: 'failed', reason: 'crash' });
    const b = await enqueueOk(request(t));
    expect(b.nodeId).not.toBe(a.nodeId);
    await transitionSession(pool, { sessionId: b.session.id, to: 'failed', reason: 'crash' });
    const c = await enqueueOk(request(t));
    expect(c.nodeId).toBe(a.nodeId);
  });

  test('région demandée : seuls ses nœuds ; poids shared 3 et dedicated 4 en unités de slot', async () => {
    await node('n-paris', 7, 'paris');
    await node('n-berlin', 64, 'berlin');
    const t = await tenant(10);
    const shared = await enqueueOk(request(t, { region: 'paris', type: 'shared', slotWeight: 3 }));
    expect(shared).toMatchObject({ admitted: true, nodeId: 'n-paris' });
    const dedicated = await enqueueOk(request(t, { region: 'paris', slotWeight: 4 }));
    expect(dedicated).toMatchObject({ admitted: true, nodeId: 'n-paris' });
    expect((await enqueueOk(request(t, { region: 'paris', type: 'shared', slotWeight: 3 }))).admitted).toBe(false);
  });

  test('client à son quota : ses sessions attendent sans bloquer celles des autres clients', async () => {
    await node('n-mix', 64);
    const a = await tenant(1);
    const b = await tenant(5);
    await enqueueOk(request(a));
    const aWaiting = await enqueueOk(request(a));
    const bServed = await enqueueOk(request(b));
    expect(aWaiting.admitted).toBe(false);
    expect(bServed.admitted).toBe(true);
  });

  test('passerelles concurrentes : 40 demandes simultanées sur 10 slots → exactement 10 placées, aucun nœud dépassé', async () => {
    await node('n-c1', 20);
    await node('n-c2', 20);
    const tenants = await Promise.all(Array.from({ length: 4 }, () => tenant(20)));
    const outcomes = await Promise.all(Array.from({ length: 40 }, (_, i) => enqueueSession(pool, request(tenants[i % 4]!), { queueMax: 100, queueMaxPerTenant: 100 })));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.filter((o) => o.ok && o.admitted)).toHaveLength(10);
    const { rows } = await pool.query<{ node_id: string; used: number }>(
      "SELECT node_id, sum(slot_weight)::int AS used FROM sessions WHERE node_id IN ('n-c1', 'n-c2') AND state IN ('pending', 'running') GROUP BY node_id ORDER BY node_id",
    );
    expect(rows).toEqual([{ node_id: 'n-c1', used: 20 }, { node_id: 'n-c2', used: 20 }]);
  });

  test('abandonQueuedSession : file expirée → failed raison quota, seulement si encore en file', async () => {
    await node('n-ab', 4);
    const t = await tenant(10);
    const placed = await enqueueOk(request(t));
    const waiting = await enqueueOk(request(t));
    expect(await abandonQueuedSession(pool, placed.session.id)).toBe(false);
    expect(await abandonQueuedSession(pool, waiting.session.id)).toBe(true);
    const { rows } = await pool.query('SELECT state, end_reason FROM sessions WHERE id = $1', [waiting.session.id]);
    expect(rows).toEqual([{ state: 'failed', end_reason: 'quota' }]);
  });
});

describe('monthlyUsage : minutes et octets consommés du mois', () => {
  test('somme des usages clôturés depuis le début du mois (UTC), le mois précédent exclu', async () => {
    await node('n-usage', 64);
    const t = await tenant(10);
    const close = async (startedAt: string, ms: number, bytesIn: number, bytesOut: number) => {
      const s = await pool.query<{ id: string }>(
        "INSERT INTO sessions (tenant_id, api_key_id, type, node_id, state, end_reason, started_at, ended_at, expires_at) VALUES ($1, $2, 'dedicated', 'n-usage', 'ended', 'released', $3::timestamptz, $3::timestamptz + make_interval(secs => $4::float8 / 1000), $3::timestamptz + interval '1 hour') RETURNING id",
        [t.tenantId, t.apiKeyId, startedAt, ms],
      );
      await pool.query(
        "INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source) SELECT id, tenant_id, api_key_id, node_id, started_at, ended_at, $2::bigint, ($2::bigint + 999) / 1000, $3::bigint, $4::bigint, 'node' FROM sessions WHERE id = $1",
        [s.rows[0]!.id, ms, bytesIn, bytesOut],
      );
    };
    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 1)).toISOString();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
    await close(thisMonth, 61_500, 100, 50);
    await close(thisMonth, 1_000, 1, 2);
    await close(lastMonth, 999_000, 5_000, 5_000);
    expect(await monthlyUsage(pool, t.tenantId)).toEqual({
      seconds: 63,
      bytes: 153,
      limits: { maxConcurrentSessions: 10, monthlyMinutes: 600, monthlyBytes: 10_737_418_240, maxSessionSeconds: 3600 },
    });
  });
});
