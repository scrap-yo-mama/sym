// SPDX-License-Identifier: AGPL-3.0-only
// Cadence par domaine distribuée sur base réelle (tâche 1.9, matrice PG) : réservation atomique entre deux pools,
// Retry-After, disjoncteur, budget de retries. Horloge injectée ou créneaux lus, jamais de sleep.
import { DomainPacer, type PacingClock, type PacingStore } from '@runtime/core';
import { buildNetworkRungs, NetworkLadder, parseNetworkPolicy, parseProxyDefinitions } from '@runtime/core/net';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { PgPacingStore } from './pacing.js';

let tdb: TestDatabase;
const pools: pg.Pool[] = [];
const pool = (max = 4) => {
  const p = new pg.Pool({ connectionString: tdb.url, max });
  pools.push(p);
  return p;
};

beforeEach(async () => {
  tdb = await createTestDatabase('pacing');
  await migrateUp({ connectionString: tdb.url });
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
  await tdb.drop();
});

/** Horloge manuelle : `sleep` enregistre l'attente et rend la main tout de suite. */
function manualClock(start = '2026-10-01T12:00:00Z') {
  let t = new Date(start).getTime();
  const sleeps: number[] = [];
  const clock: PacingClock & { advance(ms: number): void } = {
    now: () => new Date(t),
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
    advance: (ms) => void (t += ms),
  };
  return { clock, sleeps };
}

const state = async (p: pg.Pool, domain: string) =>
  (await p.query('SELECT * FROM domain_pacing_state WHERE domain = $1', [domain])).rows[0] as Record<string, unknown>;

describe('assert_pacing_key_is_domain : deux workers, une base', () => {
  test('écart ≥ min_delay_ms entre deux requêtes au même domaine, depuis deux API et deux utilisateurs', async () => {
    const minDelayMs = 40;
    const slots: number[] = [];
    // Un worker = un pool + un pacer ; le magasin enregistrant relève chaque créneau réservé. Attente : horloge factice.
    const worker = (hosts: string[], n: number) => {
      const inner = new PgPacingStore(pool());
      const store: PacingStore = {
        reserve: async (r) => {
          const res = await inner.reserve(r);
          if (res.granted) slots.push(res.slot.getTime());
          return res;
        },
        record: (d, o) => inner.record(d, o),
      };
      const clock: PacingClock = { now: () => new Date(), sleep: () => Promise.resolve() };
      const pacer = new DomainPacer(store, { clock });
      return async () => {
        for (let i = 0; i < n; i++) {
          const grant = await pacer.acquire(`https://${hosts[i % hosts.length]}/items/${i}`, { minDelayMs, maxWaitMs: 600_000 });
          if (!grant.granted) throw new Error('refus inattendu');
        }
      };
    };
    // A : API 1 de l'utilisateur 1 ; B : API 2 de l'utilisateur 2 ; même site, hôtes différents.
    await Promise.all([worker(['www.example.com', 'example.com'], 15)(), worker(['api.example.com', 'shop.example.com'], 15)()]);

    slots.sort((x, y) => x - y);
    expect(slots).toHaveLength(30);
    for (let i = 1; i < slots.length; i++) expect((slots[i] as number) - (slots[i - 1] as number)).toBeGreaterThanOrEqual(minDelayMs);

    const p = pool();
    const rows = (await p.query('SELECT domain, window_requests FROM domain_pacing_state')).rows;
    expect(rows).toEqual([{ domain: 'example.com', window_requests: 30 }]);
    const cols = (await p.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'domain_pacing_state'")).rows.map(
      (r: { column_name: string }) => r.column_name,
    );
    expect(cols.filter((c) => /owner|project|proxy|^ip|api|user/.test(c))).toEqual([]);
  });

  test('les créneaux réservés en concurrence sont tous distincts et espacés d’au moins min_delay_ms', async () => {
    const minDelayMs = 25;
    const reserve = async (p: pg.Pool, n: number) => {
      const store = new PgPacingStore(p);
      const out: number[] = [];
      await Promise.all(
        Array.from({ length: n }, async () => {
          const r = await store.reserve({ domain: 'example.com', minDelayMs, jitterMs: 0, maxWaitMs: 600_000, isRetry: false });
          if (!r.granted) throw new Error('refus inattendu');
          out.push(r.slot.getTime());
        }),
      );
      return out;
    };
    const [fromA, fromB] = await Promise.all([reserve(pool(6), 20), reserve(pool(6), 20)]);
    const slots = [...fromA, ...fromB].sort((x, y) => x - y);
    expect(slots).toHaveLength(40);
    for (let i = 1; i < slots.length; i++) expect((slots[i] as number) - (slots[i - 1] as number)).toBeGreaterThanOrEqual(minDelayMs);
  });

  test('un autre domaine n’est pas sérialisé derrière le premier', async () => {
    const p = pool();
    const store = new PgPacingStore(p);
    const req = { minDelayMs: 60_000, jitterMs: 0, maxWaitMs: 600_000, isRetry: false };
    const first = await store.reserve({ domain: 'example.com', ...req });
    const queued = await store.reserve({ domain: 'example.com', ...req });
    const other = await store.reserve({ domain: 'example.org', ...req });
    if (!first.granted || !queued.granted || !other.granted) throw new Error('refus inattendu');
    expect(queued.slot.getTime() - first.slot.getTime()).toBeGreaterThanOrEqual(60_000);
    expect(other.slot.getTime()).toBeLessThan(first.slot.getTime() + 5_000);
  });

  test('Crawl-delay plus grand que min_delay_ms : c’est lui qui espace les requêtes', async () => {
    const { clock } = manualClock();
    const pacer = new DomainPacer(new PgPacingStore(pool(), { now: clock.now }), { clock, random: () => 0 });
    const a = await pacer.acquire('https://example.com/a', { minDelayMs: 1500, crawlDelayMs: 8000 });
    const b = await pacer.acquire('https://example.com/b', { minDelayMs: 1500, crawlDelayMs: 8000 });
    expect(a).toMatchObject({ granted: true, waitedMs: 0 });
    expect(b).toMatchObject({ granted: true, waitedMs: 8000 });
  });

  test('5 × 429 : disjoncteur ouvert, aucun changement de proxy ni d’IP', async () => {
    const { clock } = manualClock();
    const p = pool();
    const pacer = new DomainPacer(new PgPacingStore(p, { now: clock.now }), { clock, random: () => 0 });
    const proxies = parseProxyDefinitions([
      { id: 'dc1', type: 'dc', url: 'http://dc.proxy.test:8080', price: { perGbUsd: 1, perRequestUsd: 0 } },
      { id: 'res1', type: 'res', url: 'http://res.proxy.test:8080', price: { perGbUsd: 5, perRequestUsd: 0 } },
    ]);
    const ladder = new NetworkLadder(buildNetworkRungs(parseNetworkPolicy({ allow: ['direct', 'dc_proxy', 'res_proxy'] }), proxies));
    const before = ladder.current;

    let last;
    for (let i = 1; i <= 5; i++) {
      const grant = await pacer.acquire('https://example.com/x');
      expect(grant.granted).toBe(true);
      const step = ladder.onFailure('rate_limited');
      expect(step).toMatchObject({ decision: 'slow_down', changed: false });
      last = await pacer.report('https://example.com/x', { kind: 'rate_limited', retryAfter: null });
      expect(last.opened).toBe(i === 5);
      clock.advance(1000); // reste bien avant la fin du délai du disjoncteur (60 s)
    }
    expect(last).toMatchObject({ circuit: 'open', consecutiveFailures: 5 });
    expect(ladder.current).toBe(before);
    expect(ladder.hops).toHaveLength(1);

    const refused = await pacer.acquire('https://example.com/x');
    expect(refused).toMatchObject({ granted: false, reason: 'circuit_open' });
    expect(await state(p, 'example.com')).toMatchObject({ circuit_state: 'open', circuit_trips: 1 });
  });
});

describe('Retry-After, ralentissement à sens unique', () => {
  test('aucun créneau avant la fin du Retry-After, pour tous les workers', async () => {
    const { clock } = manualClock();
    const store = new PgPacingStore(pool(), { now: clock.now });
    const pacer = new DomainPacer(store, { clock, random: () => 0 });
    await pacer.acquire('https://example.com');
    await pacer.report('https://example.com', { kind: 'rate_limited', retryAfter: '5' });
    clock.advance(1000);
    // Un second worker (autre pool) voit la même pénalité.
    const other = new DomainPacer(new PgPacingStore(pool(), { now: clock.now }), { clock, random: () => 0 });
    const grant = await other.acquire('https://example.com', { maxWaitMs: 60_000 });
    expect(grant).toMatchObject({ granted: true });
    expect((grant as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(4000);
    // Attente au-delà de max_wait_ms : refus, le job est différé.
    const tight = await other.acquire('https://example.com', { maxWaitMs: 100 });
    expect(tight).toMatchObject({ granted: false, reason: 'max_wait' });
  });

  test('le délai s’allonge à chaque 429, plafonné, et ne se raccourcit pas sur quelques succès', async () => {
    const { clock } = manualClock();
    const p = pool();
    const pacer = new DomainPacer(new PgPacingStore(p, { now: clock.now }), { clock, random: () => 0 });
    await pacer.report('https://example.com', { kind: 'rate_limited' });
    expect((await state(p, 'example.com')).adaptive_delay_ms).toBe(3000);
    await pacer.report('https://example.com', { kind: 'rate_limited' });
    expect((await state(p, 'example.com')).adaptive_delay_ms).toBe(6000);
    for (let i = 0; i < 3; i++) await pacer.report('https://example.com', { kind: 'ok' });
    expect(await state(p, 'example.com')).toMatchObject({ adaptive_delay_ms: 6000, consecutive_failures: 0 });
    clock.advance(60_000);
    await pacer.acquire('https://example.com');
    const next = await pacer.acquire('https://example.com');
    expect(next).toMatchObject({ granted: true, waitedMs: 6000 });
  });
});

describe('décroissance du ralentissement adaptatif', () => {
  async function slowed() {
    const { clock } = manualClock();
    const p = pool();
    const pacer = new DomainPacer(new PgPacingStore(p, { now: clock.now }), { clock, random: () => 0 });
    for (let i = 0; i < 5; i++) await pacer.report('https://example.com', { kind: 'rate_limited' });
    return { clock, p, pacer };
  }
  const adaptive = async (p: pg.Pool) => (await state(p, 'example.com')).adaptive_delay_ms;

  test('après 5 × 429, chaque série de 10 succès divise le délai par 2 jusqu’à 0 (jamais sous min_delay_ms)', async () => {
    const { p, pacer } = await slowed();
    expect(await adaptive(p)).toBe(30_000);
    const seen: unknown[] = [];
    for (let palier = 0; palier < 5; palier++) {
      for (let i = 0; i < 9; i++) await pacer.report('https://example.com', { kind: 'ok' });
      seen.push(await adaptive(p)); // pas encore de palier
      await pacer.report('https://example.com', { kind: 'ok' });
      seen.push(await adaptive(p));
    }
    expect(seen).toEqual([30_000, 15_000, 15_000, 7500, 7500, 3750, 3750, 1875, 1875, 0]);
  });

  test('un refus remet le compteur de succès à zéro', async () => {
    const { p, pacer } = await slowed();
    for (let i = 0; i < 9; i++) await pacer.report('https://example.com', { kind: 'ok' });
    await pacer.report('https://example.com', { kind: 'rate_limited' });
    for (let i = 0; i < 9; i++) await pacer.report('https://example.com', { kind: 'ok' });
    expect(await adaptive(p)).toBe(30_000);
  });

  test('durée calme de 15 min sans refus : un palier par période, sur l’horloge injectée', async () => {
    const { clock, p, pacer } = await slowed();
    clock.advance(14 * 60_000);
    await pacer.report('https://example.com', { kind: 'ok' });
    expect(await adaptive(p)).toBe(30_000);
    clock.advance(60_000);
    await pacer.report('https://example.com', { kind: 'ok' });
    expect(await adaptive(p)).toBe(15_000);
    await pacer.report('https://example.com', { kind: 'ok' });
    expect(await adaptive(p)).toBe(15_000);
  });

  test('N configurable', async () => {
    const { clock } = manualClock();
    const p = pool();
    const pacer = new DomainPacer(new PgPacingStore(p, { now: clock.now, policy: { adaptiveDecaySuccesses: 2 } }), { clock });
    await pacer.report('https://example.com', { kind: 'rate_limited' });
    await pacer.report('https://example.com', { kind: 'ok' });
    await pacer.report('https://example.com', { kind: 'ok' });
    expect(await adaptive(p)).toBe(0); // 3000 / 2 = 1500, pas au-dessus du plancher
  });
});

describe('disjoncteur : ouvert, demi-ouvert, refermé', () => {
  async function tripped() {
    const { clock } = manualClock();
    const p = pool();
    const store = new PgPacingStore(p, { now: clock.now });
    const pacer = new DomainPacer(store, { clock, random: () => 0 });
    for (let i = 0; i < 5; i++) await pacer.report('https://example.com', { kind: 'rate_limited' });
    return { clock, p, store, pacer };
  }

  test('demi-ouvert après le délai : un seul essai à la fois ; succès → refermé', async () => {
    const { clock, p, pacer } = await tripped();
    expect(await pacer.acquire('https://example.com')).toMatchObject({ granted: false, reason: 'circuit_open' });
    clock.advance(60_000);
    const probe = await pacer.acquire('https://example.com', { maxWaitMs: 600_000 });
    expect(probe).toMatchObject({ granted: true, probe: true });
    expect(await state(p, 'example.com')).toMatchObject({ circuit_state: 'half_open' });
    expect(await pacer.acquire('https://example.com', { maxWaitMs: 600_000 })).toMatchObject({ granted: false, reason: 'circuit_open' });
    const closed = await pacer.report('https://example.com', { kind: 'ok' });
    expect(closed).toMatchObject({ circuit: 'closed', consecutiveFailures: 0 });
    expect(await state(p, 'example.com')).toMatchObject({ circuit_trips: 0, circuit_open_until: null });
  });

  test('essai en échec : rouvert avec un délai doublé ; essai perdu : un autre essai après probe_timeout', async () => {
    const { clock, p, pacer } = await tripped();
    clock.advance(60_000);
    await pacer.acquire('https://example.com', { maxWaitMs: 600_000 });
    const reopened = await pacer.report('https://example.com', { kind: 'rate_limited' });
    expect(reopened).toMatchObject({ circuit: 'open', opened: true });
    const row = await state(p, 'example.com');
    expect(row.circuit_trips).toBe(2);
    expect((row.circuit_open_until as Date).getTime() - clock.now().getTime()).toBe(120_000);

    clock.advance(120_000);
    await pacer.acquire('https://example.com', { maxWaitMs: 600_000 }); // essai, le worker meurt sans verdict
    clock.advance(30_000);
    expect(await pacer.acquire('https://example.com', { maxWaitMs: 600_000 })).toMatchObject({ granted: false, reason: 'circuit_open' });
    clock.advance(31_000);
    expect(await pacer.acquire('https://example.com', { maxWaitMs: 600_000 })).toMatchObject({ granted: true, probe: true });
  });

  test('un Retry-After plus long que le délai repousse le demi-ouvert ; réarmement manuel', async () => {
    const { clock, p, store, pacer } = await tripped();
    await pacer.report('https://example.com', { kind: 'rate_limited' }); // déjà ouvert : pas de réouverture
    await store.reset('example.com');
    for (let i = 0; i < 5; i++) await pacer.report('https://example.com', { kind: 'rate_limited', retryAfter: '600' });
    const row = await state(p, 'example.com');
    expect((row.circuit_open_until as Date).getTime() - clock.now().getTime()).toBe(600_000);
    await store.reset('example.com');
    expect(await state(p, 'example.com')).toMatchObject({ circuit_state: 'closed', adaptive_delay_ms: 0, penalty_until: null });
    expect(await pacer.acquire('https://example.com')).toMatchObject({ granted: true });
  });
});

describe('budget de retries de 10 %', () => {
  test('20 requêtes : 2 réessais, le troisième est refusé ; la fenêtre se renouvelle', async () => {
    const { clock } = manualClock();
    const pacer = new DomainPacer(new PgPacingStore(pool(), { now: clock.now }), { clock, random: () => 0 });
    const opts = { minDelayMs: 0, maxWaitMs: 600_000 };
    for (let i = 0; i < 20; i++) await pacer.acquire('https://example.com', opts);
    expect(await pacer.acquire('https://example.com', { ...opts, isRetry: true })).toMatchObject({ granted: true });
    expect(await pacer.acquire('https://example.com', { ...opts, isRetry: true })).toMatchObject({ granted: true });
    const third = await pacer.acquire('https://example.com', { ...opts, isRetry: true });
    expect(third).toMatchObject({ granted: false, reason: 'retry_budget' });
    clock.advance(3_600_000);
    // Fenêtre neuve sans requête : pas de réessai avant une première requête.
    expect(await pacer.acquire('https://example.com', { ...opts, isRetry: true })).toMatchObject({ granted: false, reason: 'retry_budget' });
    await pacer.acquire('https://example.com', opts);
    expect(await pacer.acquire('https://example.com', { ...opts, isRetry: true })).toMatchObject({ granted: true });
  });
});
