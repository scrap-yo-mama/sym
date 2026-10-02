// SPDX-License-Identifier: AGPL-3.0-only
// Comptage de bout en bout (cdc/sym-browser 04d § 4, tâche 2.6) sur PostgreSQL réel : nœuds simulés (vrai superviseur de
// sessions du nœud, vrai compteur et vrai usage.wal, pool sans processus) → clôtures en base → réconciliation de la
// passerelle → `GET /v1/usage` et `GET /v1/usage.csv`.
//   assert_usage_reconciled (BINV5, D9) : 1 000 sessions simulées dont des plantages de Chromium, un nœud dont les
//     écritures finales sont perdues (journal seul) puis qui revient, et un nœud tué en pleine session ; pour chaque clé
//     d'API, Σ secondes facturées = Σ ceil(durée mesurée par le nœud) et Σ octets identique ; écart restant 0.
//   D11 et recette 16 : 20 sessions de durées variées dont 2 tuées ; export CSV identique à l'API d'usage, cellules à
//     `=`, `+`, `-`, `@` préfixées d'une apostrophe.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { billedSeconds, createManualClock, type ManualClock, type SessionStore } from '@sym-browser/core';
import { createPgSessionStore, insertSession, recordHeartbeat, recordUsageSnapshots, sweepLostNodes } from '@sym-browser/db';
import { SessionSupervisor, type SessionPool } from '@sym-browser/node/sessions';
import { replayUsageWal, UsageMeter, UsageWal } from '@sym-browser/node/usage';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../../test/helpers/harness.js';
import { parseCsv } from './csv.js';

type KeyName = 'a' | 'aRead' | 'b';
type Truth = { key: KeyName; browserMs: number; bytesIn: number; bytesOut: number };

let h: Harness;
let dir: string;
const wals: UsageWal[] = [];
const keyIds = {} as Record<KeyName, string>;
const tenantOf = (key: KeyName): string => (key === 'b' ? h.tenantB : h.tenantA);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'symb-gw-usage-'));
  h = await createHarness({ usageWal: async () => (await Promise.all(wals.map((w) => w.read()))).flat() });
  const { rows } = await h.pool.query<{ id: string; key_prefix: string }>('SELECT id, key_prefix FROM api_keys');
  const byPrefix = Object.fromEntries(rows.map((r) => [r.key_prefix, r.id]));
  keyIds.a = byPrefix['symb_a_w'] ?? '';
  keyIds.aRead = byPrefix['symb_a_r'] ?? '';
  keyIds.b = byPrefix['symb_b_w'] ?? '';
});
afterAll(async () => {
  await Promise.all(wals.map((w) => w.close()));
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Générateur pseudo-aléatoire déterministe (mulberry32) : la suite rejoue toujours les mêmes 1 000 sessions. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nœud simulé : son horloge monotone, son compteur, son usage.wal, son superviseur, un pool sans processus. */
async function simNode(nodeId: string) {
  const beat = () => recordHeartbeat(h.pool, {
    nodeId,
    url: `http://${nodeId}.internal:3000`,
    region: 'frankfurt',
    playwrightVersion: '1.63.0',
    chromiumVersion: '153.0.8010.12',
    appVersion: '0.0.0',
    slotsTotal: 64,
    slotsFree: 64,
    rssBytes: null,
    limitBytes: null,
  });
  await beat();
  const clock: ManualClock = createManualClock(0);
  const wallBase = Date.now() - 3_600_000;
  const meter = new UsageMeter({ nodeId, monotonic: () => clock.now(), now: () => wallBase + clock.now() });
  const wal = await UsageWal.open(join(dir, `${nodeId}.wal`));
  const leases = new Map<string, AbortController>();
  /** Sessions dont l'écriture finale est perdue (le nœud meurt entre usage.wal et la base). */
  const lostWrites = new Set<string>();
  const pg = createPgSessionStore(h.pool);
  const store: SessionStore = {
    ...pg,
    transition: (input) => (input.to !== 'running' && lostWrites.has(input.sessionId) ? Promise.reject(new Error('nœud tué')) : pg.transition(input)),
    recordUsage: (closure) => (lostWrites.has(closure.sessionId) ? Promise.reject(new Error('nœud tué')) : pg.recordUsage!(closure)),
  };
  const pool: SessionPool = {
    async acquire(request) {
      const controller = new AbortController();
      leases.set(request.sessionId, controller);
      return { signal: controller.signal, release: async () => undefined } as unknown as Awaited<ReturnType<SessionPool['acquire']>>;
    },
  };
  const supervisor = new SessionSupervisor({ nodeId, pool, store, clock, usage: { meter, wal }, onError: () => undefined });
  return { nodeId, beat, clock, meter, wal, leases, lostWrites, supervisor, store: pg };
}
type SimNode = Awaited<ReturnType<typeof simNode>>;

/** Session créée par l'API (ligne `pending`), démarrée sur le nœud ; `timeoutMs` : fin au plus tard. */
async function startOn(node: SimNode, key: KeyName, timeoutMs = 3_600_000): Promise<{ id: string; startedAt: number }> {
  const inserted = await insertSession(h.pool, {
    tenantId: tenantOf(key),
    apiKeyId: keyIds[key],
    type: 'dedicated',
    region: null,
    timeoutSeconds: 3600,
    options: {},
    egressPolicy: {},
    metadata: {},
  });
  if (!inserted.ok) throw new Error('insertion');
  const id = inserted.session.id;
  const outcome = await node.supervisor.start({
    sessionId: id,
    type: 'dedicated',
    tenantId: tenantOf(key),
    expiresAt: node.clock.now() + timeoutMs,
    maxExpiresAt: node.clock.now() + 3_600_000,
    idleTimeoutSeconds: 3600,
  });
  expect(outcome).toEqual({ ok: true });
  return { id, startedAt: node.clock.now() };
}

/** Trafic d'egress simulé sur 1 à 3 époques ; rend les octets réellement comptés (Σ des fins d'époque). */
function traffic(node: SimNode, sessionId: string, rand: () => number): { bytesIn: number; bytesOut: number } {
  let bytesIn = 0;
  let bytesOut = 0;
  const epochs = 1 + Math.floor(rand() * 3);
  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    let inE = 0;
    let outE = 0;
    for (let step = 0; step < 3; step += 1) {
      inE += Math.floor(rand() * 2_000_000);
      outE += Math.floor(rand() * 50_000);
      node.meter.observe(sessionId, { epoch, requests: step, blocked: 0, bytesIn: inE, bytesOut: outE, budgetExceeded: false });
    }
    bytesIn += inE;
    bytesOut += outE;
  }
  return { bytesIn, bytesOut };
}

async function api(url: string, key: KeyName | 'aAdmin' | 'bAdmin' | null, method: 'GET' | 'POST' = 'GET') {
  const res = await h.app.inject({ method, url, headers: key ? { authorization: `Bearer ${h.keys[key]}` } : {} });
  return { status: res.statusCode, headers: res.headers, text: res.body, json: () => res.json() };
}

const PERIOD = (): string => `from=${encodeURIComponent(new Date(Date.now() - 30 * 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`;

/** Totaux attendus d'un ensemble de sessions, à partir des mesures du nœud. */
function expectedTotals(truths: Iterable<Truth>) {
  const totals = { sessions: 0, billedSeconds: 0, bytesIn: 0, bytesOut: 0 };
  for (const t of truths) {
    totals.sessions += 1;
    totals.billedSeconds += billedSeconds(t.browserMs);
    totals.bytesIn += t.bytesIn;
    totals.bytesOut += t.bytesOut;
  }
  return totals;
}

/** Totaux du CSV (lignes de données) dans la forme de l'API. */
function csvTotals(text: string) {
  const [header, ...rows] = parseCsv(text);
  expect(header?.slice(0, 6)).toEqual(['period', 'api_key_prefix', 'sessions', 'billed_seconds', 'bytes_in', 'bytes_out']);
  const sum = (col: number) => rows.reduce((acc, row) => acc + Number(row[col]), 0);
  return { rows, totals: { sessions: sum(2), billedSeconds: sum(3), bytesIn: sum(4), bytesOut: sum(5) } };
}

describe('assert_usage_reconciled (BINV5, D9)', () => {
  test('1 000 sessions simulées, plantages de Chromium et de nœuds : Σ facturé = Σ mesuré par le nœud, par clé, écart 0', async () => {
    const rand = random(2_6);
    const keys: KeyName[] = ['a', 'aRead', 'b'];
    const pick = (): KeyName => keys[Math.floor(rand() * keys.length)] ?? 'a';
    const truth = new Map<string, Truth>();
    const tally = { released: 0, crash: 0, timeout: 0, budget: 0, shutdown: 0, lostWrite: 0, killedNode: 0 };

    // Nœud 1 : 800 sessions par lots de 40, fins variées (libération, plantage de Chromium, délai, budget, arrêt du nœud).
    const n1 = await simNode('sim-1');
    wals.push(n1.wal);
    for (let batch = 0; batch < 20; batch += 1) {
      const live: { id: string; startedAt: number; key: KeyName; bytes: { bytesIn: number; bytesOut: number }; timeoutMs?: number }[] = [];
      for (let i = 0; i < 40; i += 1) {
        const key = pick();
        // Délai total au-delà de la durée du lot : il tombe après les autres fins, dans l'ordre des échéances.
        const timed = rand() < 0.1;
        const timeoutMs = timed ? 200_000 + Math.floor(rand() * 90_000) : undefined;
        n1.clock.advance(Math.floor(rand() * 300));
        const s = await startOn(n1, key, timeoutMs);
        live.push({ ...s, key, bytes: traffic(n1, s.id, rand), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      }
      for (const s of live) {
        if (s.timeoutMs !== undefined) continue;
        n1.clock.advance(Math.floor(rand() * 4_000));
        const roll = rand();
        if (batch === 19 && roll < 0.3) continue; // finies par l'arrêt du nœud ci-dessous
        const endedAt = n1.clock.now();
        if (roll < 0.12) {
          n1.leases.get(s.id)?.abort('crash');
          tally.crash += 1;
        } else if (roll < 0.17) {
          await n1.supervisor.end(s.id, 'budget_exceeded');
          tally.budget += 1;
        } else {
          await n1.supervisor.end(s.id, 'released');
          tally.released += 1;
        }
        await n1.supervisor.idle();
        truth.set(s.id, { key: s.key, browserMs: endedAt - s.startedAt, ...s.bytes });
      }
      // Les délais totaux tombent, un à un ; le reste du dernier lot finit par l'arrêt du nœud.
      const timed = live.filter((s) => s.timeoutMs !== undefined).sort((x, y) => x.startedAt + (x.timeoutMs ?? 0) - (y.startedAt + (y.timeoutMs ?? 0)));
      for (const s of timed) {
        n1.clock.advance(s.startedAt + (s.timeoutMs ?? 0) - n1.clock.now());
        await n1.supervisor.idle();
        truth.set(s.id, { key: s.key, browserMs: s.timeoutMs ?? 0, ...s.bytes });
        tally.timeout += 1;
      }
      if (batch === 19) {
        const remaining = live.filter((s) => !truth.has(s.id));
        const at = n1.clock.now();
        await n1.supervisor.shutdown();
        for (const s of remaining) truth.set(s.id, { key: s.key, browserMs: at - s.startedAt, ...s.bytes });
        tally.shutdown += remaining.length;
      }
    }
    await n1.supervisor.idle();

    // Nœud 2 : 120 sessions ; 30 clôtures atteignent usage.wal mais jamais la base (nœud tué juste après), puis il revient.
    const n2 = await simNode('sim-2');
    const n2Sessions: { id: string; startedAt: number; key: KeyName; bytes: { bytesIn: number; bytesOut: number } }[] = [];
    for (let i = 0; i < 120; i += 1) {
      n2.clock.advance(Math.floor(rand() * 200));
      const key = pick();
      const s = await startOn(n2, key);
      n2Sessions.push({ ...s, key, bytes: traffic(n2, s.id, rand) });
    }
    n2.clock.advance(5_000);
    await recordUsageSnapshots(h.pool, 'sim-2', n2.meter.live()); // dernier instantané reçu par la base
    for (const [i, s] of n2Sessions.entries()) {
      if (i % 4 === 0) {
        n2.lostWrites.add(s.id);
        tally.lostWrite += 1;
      }
      n2.clock.advance(Math.floor(rand() * 3_000));
      const endedAt = n2.clock.now();
      await n2.supervisor.end(s.id, 'released');
      truth.set(s.id, { key: s.key, browserMs: endedAt - s.startedAt, ...s.bytes });
    }

    // Nœud 3 : 80 sessions, 20 finies normalement, puis le nœud est tué (kill -9 simulé) ; dernière mesure = instantané.
    const n3 = await simNode('sim-3');
    const n3Live: { id: string; key: KeyName; startedAt: number; bytes: { bytesIn: number; bytesOut: number } }[] = [];
    for (let i = 0; i < 80; i += 1) {
      n3.clock.advance(Math.floor(rand() * 500));
      const key = pick();
      const s = await startOn(n3, key);
      const bytes = traffic(n3, s.id, rand);
      if (i % 4 === 0) {
        n3.clock.advance(Math.floor(rand() * 2_000));
        const endedAt = n3.clock.now();
        await n3.supervisor.end(s.id, 'released');
        truth.set(s.id, { key, browserMs: endedAt - s.startedAt, ...bytes });
      } else n3Live.push({ ...s, key, bytes });
    }
    n3.clock.advance(7_777);
    const lastSnapshot = n3.meter.live();
    await recordUsageSnapshots(h.pool, 'sim-3', lastSnapshot);
    for (const snap of lastSnapshot) {
      const s = n3Live.find((x) => x.id === snap.sessionId);
      if (s) truth.set(s.id, { key: s.key, browserMs: snap.browserMs, bytesIn: snap.bytesIn, bytesOut: snap.bytesOut });
    }
    tally.killedNode = n3Live.length;
    // Après l'instantané, le nœud continue de tourner quelques secondes puis meurt : ces secondes ne sont mesurées par personne.
    n3.clock.advance(4_000);

    expect(truth.size).toBe(1_000);
    expect(tally.crash).toBeGreaterThanOrEqual(50);
    expect(tally.timeout).toBeGreaterThanOrEqual(30);

    // Nœuds 2 et 3 muets : déclarés perdus, leurs sessions running passent failed node_lost.
    await n1.beat();
    await h.pool.query("UPDATE nodes SET last_beat_at = now() - interval '1 minute' WHERE id IN ('sim-2', 'sim-3')");
    const swept = await sweepLostNodes(h.pool);
    expect(swept.sessions).toHaveLength(tally.lostWrite + tally.killedNode);

    // Réconciliation (journaux joignables : nœud 1 seulement) → sessions des nœuds perdus reconstruites.
    const first = await api('/v1/admin/usage/reconcile', 'aAdmin', 'POST');
    expect(first.status).toBe(202);
    expect(first.json().reconciliation).toMatchObject({ reconstructed: tally.lostWrite + tally.killedNode, remainingDriftSeconds: 0, remainingDriftBytes: 0 });

    // Le nœud 2 revient : son journal redevient lisible ; la réconciliation mesure l'écart et remplace les reconstructions.
    n2.lostWrites.clear();
    wals.push(n2.wal);
    const second = (await api('/v1/admin/usage/reconcile', 'aAdmin', 'POST')).json().reconciliation;
    expect(second.replaced).toBe(tally.lostWrite);
    expect(second.driftSeconds).toBeGreaterThan(0);
    expect(second).toMatchObject({ remainingDriftSeconds: 0, remainingDriftBytes: 0 });
    // Rejeu de usage.wal au redémarrage du nœud : tout est déjà juste.
    const replay = await replayUsageWal(n2.wal, n2.store);
    expect(replay).toEqual({ inserted: 0, replaced: 0, unchanged: 120, notFound: 0 });
    const third = (await api('/v1/admin/usage/reconcile', 'aAdmin', 'POST')).json().reconciliation;
    expect(third).toMatchObject({ inserted: 0, replaced: 0, reconstructed: 0, driftSeconds: 0, driftBytes: 0, remainingDriftSeconds: 0, remainingDriftBytes: 0 });

    // Base : une clôture par session lancée, Σ billed_seconds = Σ ceil(browser_ms / 1000).
    const { rows } = await h.pool.query<{ n: string; billed: string; ceil: string }>(
      'SELECT count(*)::text AS n, sum(billed_seconds)::text AS billed, sum(ceil(browser_ms / 1000.0))::bigint::text AS ceil FROM usage_records WHERE node_id LIKE $1',
      ['sim-%'],
    );
    expect(rows[0]).toEqual({ n: '1000', billed: rows[0]?.ceil, ceil: rows[0]?.ceil });

    // API d'usage par clé (sa propre clé pour sessions:read ; tout le client pour admin) et par session : égalité exacte.
    for (const key of keys) {
      const mine = [...truth.values()].filter((t) => t.key === key);
      const asKey = await api(`/v1/usage?${PERIOD()}`, key);
      expect(asKey.status).toBe(200);
      expect(asKey.json().totals).toEqual(expectedTotals(mine));
      const asAdmin = await api(`/v1/usage?${PERIOD()}&apiKeyId=${keyIds[key]}`, key === 'b' ? 'bAdmin' : 'aAdmin');
      expect(asAdmin.json().totals).toEqual(expectedTotals(mine));
      const csv = await api(`/v1/usage.csv?${PERIOD()}`, key);
      expect(csvTotals(csv.text).totals).toEqual(asKey.json().totals);
    }
    const perSession = (await api(`/v1/usage?${PERIOD()}&groupBy=session`, 'aAdmin')).json();
    const tenantA = [...truth].filter(([, t]) => t.key !== 'b');
    expect(perSession.items).toHaveLength(tenantA.length);
    for (const item of perSession.items) {
      const t = truth.get(item.sessionId);
      expect({ billedSeconds: item.billedSeconds, bytesIn: item.bytesIn, bytesOut: item.bytesOut }).toEqual({ billedSeconds: billedSeconds(t?.browserMs ?? -1), bytesIn: t?.bytesIn, bytesOut: t?.bytesOut });
    }
    expect(perSession.totals).toEqual(expectedTotals(tenantA.map(([, t]) => t)));
  }, 240_000);
});

describe('recette 16 et D11 : export CSV identique à l’API d’usage', () => {
  test('20 sessions de durées variées dont 2 tuées : Σ secondes et octets facturés = Σ mesuré ; CSV = API, par jour et par clé', async () => {
    const rand = random(16);
    const node = await simNode('sim-16');
    wals.push(node.wal);
    // Clé dont le préfixe commence par `=` : la cellule CSV est neutralisée.
    const evil = (await h.pool.query<{ id: string }>("INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, '=HYPERLINK(1)', 'h', ARRAY['sessions:read']) RETURNING id", [h.tenantB])).rows[0]?.id ?? '';
    const before = (await api(`/v1/usage?${PERIOD()}`, 'bAdmin')).json().totals;
    const truths: Truth[] = [];
    const started: { id: string; startedAt: number; bytes: { bytesIn: number; bytesOut: number } }[] = [];
    for (let i = 0; i < 20; i += 1) {
      const inserted = await insertSession(h.pool, { tenantId: h.tenantB, apiKeyId: i % 2 === 0 ? keyIds.b : evil, type: 'dedicated', region: null, timeoutSeconds: 3600, options: {}, egressPolicy: {}, metadata: {} });
      if (!inserted.ok) throw new Error('insertion');
      await node.supervisor.start({ sessionId: inserted.session.id, type: 'dedicated', tenantId: h.tenantB, expiresAt: node.clock.now() + 3_600_000, maxExpiresAt: node.clock.now() + 3_600_000, idleTimeoutSeconds: 3600 });
      started.push({ id: inserted.session.id, startedAt: node.clock.now(), bytes: traffic(node, inserted.session.id, rand) });
      node.clock.advance(137);
    }
    for (const [i, s] of started.entries()) {
      node.clock.advance(250 + Math.floor(rand() * 9_000));
      const endedAt = node.clock.now();
      if (i === 4 || i === 13) node.leases.get(s.id)?.abort('crash'); // 2 Chromium tués
      else await node.supervisor.end(s.id, 'released');
      await node.supervisor.idle();
      truths.push({ key: 'b', browserMs: endedAt - s.startedAt, ...s.bytes });
    }
    await node.supervisor.idle();
    const killed = await h.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM sessions s JOIN usage_records u ON u.session_id = s.id WHERE s.node_id = 'sim-16' AND s.state = 'failed' AND s.end_reason = 'crash'");
    expect(killed.rows[0]?.n).toBe('2');

    const after = (await api(`/v1/usage?${PERIOD()}`, 'bAdmin')).json().totals;
    const delta = { sessions: after.sessions - before.sessions, billedSeconds: after.billedSeconds - before.billedSeconds, bytesIn: after.bytesIn - before.bytesIn, bytesOut: after.bytesOut - before.bytesOut };
    expect(delta).toEqual(expectedTotals(truths));

    for (const groupBy of ['key', 'key,day', 'day', 'session']) {
      const json = await api(`/v1/usage?${PERIOD()}&groupBy=${groupBy}`, 'bAdmin');
      expect(json.status).toBe(200);
      const csv = await api(`/v1/usage.csv?${PERIOD()}&groupBy=${groupBy}`, 'bAdmin');
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/^text\/csv/);
      const { rows, totals } = csvTotals(csv.text);
      expect(rows).toHaveLength(json.json().items.length);
      expect(totals).toEqual(json.json().totals);
    }
    const csv = await api(`/v1/usage.csv?${PERIOD()}&groupBy=key`, 'bAdmin');
    expect(csv.text).toContain("'=HYPERLINK(1)");
    expect(csv.text).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});

describe('accès à l’API d’usage', () => {
  test('sans clé 401 ; sessions:read limité à sa clé (autre clé : 403) ; réconciliation réservée à admin', async () => {
    expect((await api('/v1/usage', null)).status).toBe(401);
    expect((await api(`/v1/usage?apiKeyId=${keyIds.a}`, 'aRead')).status).toBe(403);
    const own = await api('/v1/usage', 'aRead');
    expect(own.status).toBe(200);
    expect(own.json().items.every((i: { apiKeyId: string }) => i.apiKeyId === keyIds.aRead)).toBe(true);
    expect((await api('/v1/admin/usage/reconcile', 'a', 'POST')).status).toBe(403);
    // Admin d'un autre client : la clé de A n'existe pas pour lui (aucune ligne).
    expect((await api(`/v1/usage?apiKeyId=${keyIds.a}`, 'bAdmin')).json().totals).toEqual({ sessions: 0, billedSeconds: 0, bytesIn: 0, bytesOut: 0 });
  });

  test('période par défaut : mois UTC courant ; paramètres invalides : 422 invalid_option', async () => {
    const res = await api('/v1/usage', 'aAdmin');
    const now = new Date();
    expect(res.json().period).toEqual({
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    });
    for (const query of ['groupBy=tenant', 'from=hier', 'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z', 'apiKeyId=pas-un-uuid']) {
      const bad = await api(`/v1/usage?${query}`, 'aAdmin');
      expect(bad.status, query).toBe(422);
      expect(bad.json().error.code).toBe('invalid_option');
    }
  });
});
