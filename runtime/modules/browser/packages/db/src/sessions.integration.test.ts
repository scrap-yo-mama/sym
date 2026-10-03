// SPDX-License-Identifier: AGPL-3.0-only
// Transitions persistées (tâche 1.2) sur PostgreSQL réel : machine à états (04 § 5), événements `state`, prolongation
// plafonnée, table de routage session → nœud (AD4), battement et détection de nœud mort (04b § 5 et § 6).
//   state_machine_model (A5) : séquences aléatoires (fast-check) jouées en base ; aucune transition hors de la table.
//   node_lost_detection (P7) : 3 battements manqués → nœud `down`, sessions `failed` raison `node_lost`, slots libérés.
import { checkTransition, type SessionState } from '@sym-browser/core';
import { END_REASONS, SESSION_STATES, type EndReason } from '@sym/contracts/browser';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { readyNodeExists } from './api.js';
import { createPgSessionStore, extendSession, recordHeartbeat, routeSession, setNodeState, sweepLostNodes, transitionSession, type NodeBeat } from './sessions.js';

let tdb: TestDatabase;
let pool: pg.Pool;
let tenantA: string;
let tenantB: string;
let keyA: string;

beforeAll(async () => {
  tdb = await createTestDatabase('sessions');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  tenantA = await id("INSERT INTO tenants (name, max_session_seconds) VALUES ('a', 600) RETURNING id");
  tenantB = await id("INSERT INTO tenants (name) VALUES ('b') RETURNING id");
  keyA = await id(
    "INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, 'symb_a', '$argon2id$v=19$m=19456,t=2,p=1$x$y', ARRAY['sessions:write']) RETURNING id",
    [tenantA],
  );
});
afterAll(async () => {
  await pool.end();
  await tdb.drop();
});

async function id(sql: string, params: unknown[] = []): Promise<string> {
  return (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';
}

const beat = (nodeId: string, extra: Partial<NodeBeat> = {}): NodeBeat => ({
  nodeId,
  url: `http://${nodeId}.internal:3000`,
  region: 'default',
  playwrightVersion: '1.63.0',
  chromiumVersion: '153.0.8010.12',
  appVersion: '0.0.0',
  slotsTotal: 4,
  slotsFree: 4,
  rssBytes: 1_000_000,
  limitBytes: 8_000_000_000,
  ...extra,
});

async function newSession(options: { nodeId?: string; timeoutSeconds?: number } = {}): Promise<string> {
  return id(
    `INSERT INTO sessions (tenant_id, api_key_id, type, node_id, expires_at)
     VALUES ($1, $2, 'dedicated', $3, now() + make_interval(secs => $4)) RETURNING id`,
    [tenantA, keyA, options.nodeId ?? null, options.timeoutSeconds ?? 300],
  );
}

type Row = { state: SessionState; end_reason: EndReason | null; node_id: string | null; started_at: Date | null; ended_at: Date | null; expires_at: Date; created_at: Date };
const row = async (sessionId: string): Promise<Row> => (await pool.query<Row>('SELECT * FROM sessions WHERE id = $1', [sessionId])).rows[0] as Row;
const stateEvents = async (sessionId: string) =>
  (await pool.query<{ data: { state: SessionState; endReason?: EndReason } }>("SELECT data FROM session_events WHERE session_id = $1 AND type = 'state' ORDER BY id", [sessionId])).rows.map((r) => r.data);

describe('transitionSession', () => {
  test('pending → running → ended : dates, nœud, raison et événements `state` persistés', async () => {
    await recordHeartbeat(pool, beat('node-t1'));
    const sessionId = await newSession();
    const started = await transitionSession(pool, { sessionId, to: 'running', reason: null, nodeId: 'node-t1' });
    expect(started).toMatchObject({ ok: true, previous: 'pending', state: 'running' });
    let r = await row(sessionId);
    expect(r).toMatchObject({ state: 'running', node_id: 'node-t1', end_reason: null, ended_at: null });
    expect(r.started_at).toBeInstanceOf(Date);

    const ended = await transitionSession(pool, { sessionId, to: 'ended', reason: 'released' });
    expect(ended).toMatchObject({ ok: true, previous: 'running', state: 'ended', endReason: 'released' });
    r = await row(sessionId);
    expect(r).toMatchObject({ state: 'ended', end_reason: 'released' });
    expect(r.ended_at!.getTime()).toBeGreaterThanOrEqual(r.started_at!.getTime());
    expect(Math.abs(r.ended_at!.getTime() - Date.now())).toBeLessThan(5_000);
    expect(await stateEvents(sessionId)).toEqual([{ state: 'running' }, { state: 'ended', endReason: 'released' }]);
  });

  test('transition hors table refusée sans écriture ; session inconnue : not_found', async () => {
    const sessionId = await newSession();
    expect(await transitionSession(pool, { sessionId, to: 'timed_out', reason: 'idle' })).toEqual({ ok: false, code: 'invalid_transition', current: 'pending' });
    expect(await transitionSession(pool, { sessionId, to: 'running', reason: 'crash' })).toEqual({ ok: false, code: 'invalid_transition', current: 'pending' });
    expect((await row(sessionId)).state).toBe('pending');
    expect(await stateEvents(sessionId)).toEqual([]);
    expect(await transitionSession(pool, { sessionId: '00000000-0000-4000-8000-000000000000', to: 'running', reason: null })).toEqual({ ok: false, code: 'not_found' });
  });

  test('deux fins concurrentes : une seule gagne, un seul événement de fin', async () => {
    await recordHeartbeat(pool, beat('node-t2'));
    const sessionId = await newSession();
    await transitionSession(pool, { sessionId, to: 'running', reason: null, nodeId: 'node-t2' });
    const results = await Promise.all([
      transitionSession(pool, { sessionId, to: 'ended', reason: 'released' }),
      transitionSession(pool, { sessionId, to: 'failed', reason: 'crash' }),
      transitionSession(pool, { sessionId, to: 'timed_out', reason: 'idle' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await stateEvents(sessionId)).filter((e) => e.endReason !== undefined)).toHaveLength(1);
  });
});

describe('state_machine_model (A5, fast-check, PostgreSQL)', () => {
  test('séquences aléatoires jouées en base : aucune transition hors de la table, événements conformes', async () => {
    await recordHeartbeat(pool, beat('node-model'));
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ to: fc.constantFrom(...SESSION_STATES), reason: fc.option(fc.constantFrom(...END_REASONS), { nil: null }) }), { maxLength: 12 }),
        async (attempts) => {
          const sessionId = await newSession();
          let model: SessionState = 'pending';
          for (const { to, reason } of attempts) {
            const outcome = await transitionSession(pool, { sessionId, to, reason, nodeId: 'node-model' });
            expect(outcome.ok).toBe(checkTransition(model, to, reason).ok);
            if (outcome.ok) model = to;
          }
          const r = await row(sessionId);
          expect(r.state).toBe(model);
          let previous: SessionState = 'pending';
          for (const event of await stateEvents(sessionId)) {
            expect(checkTransition(previous, event.state, event.endReason ?? null).ok).toBe(true);
            previous = event.state;
          }
          expect(previous).toBe(model);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('extendSession (POST /extend)', () => {
  test('ajoute du temps, plafonné par la durée max du client ; refusé sur une session terminée', async () => {
    const sessionId = await newSession({ timeoutSeconds: 300 });
    const before = await row(sessionId);
    const extended = await extendSession(pool, { sessionId, seconds: 120 });
    expect(extended.ok).toBe(true);
    expect((await row(sessionId)).expires_at.getTime() - before.expires_at.getTime()).toBe(120_000);
    // Durée max du client A : 600 s depuis la création.
    const capped = await extendSession(pool, { sessionId, seconds: 10_000 });
    expect(capped.ok && capped.expiresAt).toBe(before.created_at.getTime() + 600_000);
    await transitionSession(pool, { sessionId, to: 'failed', reason: 'quota' });
    expect(await extendSession(pool, { sessionId, seconds: 60 })).toEqual({ ok: false, code: 'invalid_state', current: 'failed' });
    expect(await extendSession(pool, { sessionId: '00000000-0000-4000-8000-000000000000', seconds: 60 })).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('routeSession (table de routage, AD4)', () => {
  test('session running → URL privée de son nœud ; autre client, pending, nœud down : refus typés', async () => {
    await recordHeartbeat(pool, beat('node-r1'));
    const sessionId = await newSession();
    expect(await routeSession(pool, { sessionId, tenantId: tenantA })).toEqual({ ok: false, code: 'not_running', state: 'pending' });
    await transitionSession(pool, { sessionId, to: 'running', reason: null, nodeId: 'node-r1' });
    expect(await routeSession(pool, { sessionId, tenantId: tenantA })).toEqual({ ok: true, nodeId: 'node-r1', nodeUrl: 'http://node-r1.internal:3000' });
    // Isolation par client (BINV7) : la session d'un autre client n'existe pas pour lui.
    expect(await routeSession(pool, { sessionId, tenantId: tenantB })).toEqual({ ok: false, code: 'not_found' });
    await pool.query("UPDATE nodes SET state = 'down' WHERE id = 'node-r1'");
    expect(await routeSession(pool, { sessionId, tenantId: tenantA })).toEqual({ ok: false, code: 'node_unavailable' });
  });
});

describe('node_lost_detection (P7)', () => {
  test('3 battements manqués : nœud down, sessions pending et running failed node_lost, slots libérés ; reprise : ready', async () => {
    await recordHeartbeat(pool, beat('node-lost', { slotsTotal: 4, slotsFree: 1 }));
    await recordHeartbeat(pool, beat('node-alive'));
    const running = await newSession();
    await transitionSession(pool, { sessionId: running, to: 'running', reason: null, nodeId: 'node-lost' });
    const pending = await newSession({ nodeId: 'node-lost' });
    const finished = await newSession();
    await transitionSession(pool, { sessionId: finished, to: 'running', reason: null, nodeId: 'node-lost' });
    await transitionSession(pool, { sessionId: finished, to: 'ended', reason: 'released' });
    const elsewhere = await newSession();
    await transitionSession(pool, { sessionId: elsewhere, to: 'running', reason: null, nodeId: 'node-alive' });

    // Battement à 5 s : 2 battements manqués (11 s) ne suffisent pas.
    await pool.query("UPDATE nodes SET last_beat_at = now() - interval '11 seconds' WHERE id = 'node-lost'");
    expect(await sweepLostNodes(pool)).toEqual({ locked: true, nodes: [], sessions: [] });
    // 3 battements manqués (plus de 15 s) : nœud perdu.
    await pool.query("UPDATE nodes SET last_beat_at = now() - interval '16 seconds' WHERE id = 'node-lost'");
    const swept = await sweepLostNodes(pool);
    expect(swept.locked).toBe(true);
    expect(swept.nodes).toEqual(['node-lost']);
    expect(swept.sessions.sort()).toEqual([running, pending].sort());

    expect(await row(running)).toMatchObject({ state: 'failed', end_reason: 'node_lost' });
    expect(await row(pending)).toMatchObject({ state: 'failed', end_reason: 'node_lost', started_at: null });
    expect(await row(finished)).toMatchObject({ state: 'ended', end_reason: 'released' });
    expect(await row(elsewhere)).toMatchObject({ state: 'running' });
    expect(await stateEvents(running)).toEqual([{ state: 'running' }, { state: 'failed', endReason: 'node_lost' }]);
    const node = (await pool.query<{ state: string; slots_free: number; slots_total: number }>("SELECT * FROM nodes WHERE id = 'node-lost'")).rows[0];
    expect(node).toMatchObject({ state: 'down', slots_free: 4, slots_total: 4 });

    // Balayage rejoué : rien de plus.
    expect(await sweepLostNodes(pool)).toMatchObject({ nodes: [], sessions: [] });
    // Battement repris : le nœud redevient ready et apprend qu'il doit détruire ses sessions locales.
    expect(await recordHeartbeat(pool, beat('node-lost', { slotsFree: 4 }))).toEqual({ state: 'ready', recovered: true });
    expect(await recordHeartbeat(pool, beat('node-lost', { slotsFree: 4 }))).toEqual({ state: 'ready', recovered: false });
  });

  test('un seul balayeur à la fois (verrou consultatif) : le second rend la main sans rien faire', async () => {
    await recordHeartbeat(pool, beat('node-lock'));
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [(await import('./sessions.js')).NODE_SWEEP_LOCK_KEY]);
      await pool.query("UPDATE nodes SET last_beat_at = now() - interval '20 seconds' WHERE id = 'node-lock'");
      expect(await sweepLostNodes(pool)).toEqual({ locked: false, nodes: [], sessions: [] });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await sweepLostNodes(pool)).nodes).toContain('node-lock');
  });

  test('battement : enregistrement du nœud (upsert), capacité publiée, nœud draining conservé', async () => {
    expect(await recordHeartbeat(pool, beat('node-new', { slotsTotal: 5, slotsFree: 3 }))).toEqual({ state: 'ready', recovered: false });
    await pool.query("UPDATE nodes SET state = 'draining' WHERE id = 'node-new'");
    expect(await recordHeartbeat(pool, beat('node-new', { slotsTotal: 5, slotsFree: 5 }))).toEqual({ state: 'draining', recovered: false });
    const node = (await pool.query("SELECT slots_total, slots_free, url FROM nodes WHERE id = 'node-new'")).rows[0];
    expect(node).toEqual({ slots_total: 5, slots_free: 5, url: 'http://node-new.internal:3000' });
  });
});

describe('node_drain_state (04b § 5 et § 9, tâche 2.7)', () => {
  test('SIGTERM : ready → draining (écarté du choix, sessions toujours routées, battement conservé), puis down (slots libérés)', async () => {
    await recordHeartbeat(pool, beat('node-drain', { region: 'region-drain', slotsTotal: 4, slotsFree: 2 }));
    const running = await newSession({ nodeId: 'node-drain' });
    await transitionSession(pool, { sessionId: running, to: 'running', reason: null, nodeId: 'node-drain' });
    expect(await readyNodeExists(pool, 'region-drain')).toBe(true);

    expect(await setNodeState(pool, { nodeId: 'node-drain', state: 'draining' })).toEqual({ state: 'draining' });
    // Plus aucune nouvelle session vers ce nœud : la passerelle ne le choisit plus (503 no_node si c'est le seul).
    expect(await readyNodeExists(pool, 'region-drain')).toBe(false);
    // Les sessions en cours restent joignables pendant la grâce, et le battement ne remet pas le nœud `ready`.
    expect(await routeSession(pool, { sessionId: running, tenantId: tenantA })).toEqual({ ok: true, nodeId: 'node-drain', nodeUrl: 'http://node-drain.internal:3000' });
    expect(await recordHeartbeat(pool, beat('node-drain', { region: 'region-drain', slotsTotal: 4, slotsFree: 3 }))).toEqual({ state: 'draining', recovered: false });
    // Un second SIGTERM ne change rien.
    expect(await setNodeState(pool, { nodeId: 'node-drain', state: 'draining' })).toEqual({ state: 'draining' });

    await transitionSession(pool, { sessionId: running, to: 'ended', reason: 'node_shutdown' });
    expect(await setNodeState(pool, { nodeId: 'node-drain', state: 'down' })).toEqual({ state: 'down' });
    const node = (await pool.query("SELECT state, slots_total, slots_free FROM nodes WHERE id = 'node-drain'")).rows[0];
    expect(node).toEqual({ state: 'down', slots_total: 4, slots_free: 4 });
    expect(await row(running)).toMatchObject({ state: 'ended', end_reason: 'node_shutdown' });
    // Un nœud `down` ne repasse pas `draining` (drainage demandé après l'arrêt : sans effet).
    expect(await setNodeState(pool, { nodeId: 'node-drain', state: 'draining' })).toEqual({ state: 'down' });
  });

  test('nœud inconnu : null, aucune ligne créée', async () => {
    expect(await setNodeState(pool, { nodeId: 'node-absent', state: 'draining' })).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM nodes WHERE id = 'node-absent'")).rows[0]).toEqual({ n: 0 });
  });
});

describe('createPgSessionStore (interface SessionStore du nœud)', () => {
  test('mêmes résultats que les fonctions, dates en millisecondes', async () => {
    await recordHeartbeat(pool, beat('node-store'));
    const store = createPgSessionStore(pool);
    const sessionId = await newSession();
    const outcome = await store.transition({ sessionId, to: 'running', reason: null, nodeId: 'node-store' });
    expect(outcome.ok && typeof outcome.at).toBe('number');
    expect(await store.extend({ sessionId, seconds: 30 })).toMatchObject({ ok: true });
    expect(await store.transition({ sessionId, to: 'timed_out', reason: 'idle' })).toMatchObject({ ok: true, state: 'timed_out', endReason: 'idle' });
  });
});
