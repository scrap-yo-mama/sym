// Cadence par domaine (1.9), partie pure : clé = domaine, délai effectif, gigue, Retry-After, orchestration du worker.
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_PACING_POLICY,
  DomainPacer,
  effectiveMinDelayMs,
  jitterMs,
  outcomeKindOfStatus,
  PacingKeyError,
  parseRetryAfterMs,
  registrableDomain,
  type OutcomeResult,
  type PacingClock,
  type PacingOutcome,
  type PacingStore,
  type Reservation,
  type ReserveRequest,
} from './index.js';

describe('assert_pacing_key_is_domain : clé de cadence', () => {
  test('toute URL, tout hôte, tout sous-domaine d’un site donnent la même clé', () => {
    const keys = [
      'https://example.com/a?x=1',
      'http://www.example.com:8443/b',
      'https://api.example.com/v2/items',
      'EXAMPLE.com.',
      'user:pw@shop.example.com',
      'https://www2.example.com',
    ].map(registrableDomain);
    expect(new Set(keys)).toEqual(new Set(['example.com']));
  });

  test('suffixes à deux niveaux usuels ; adresses IP gardées telles quelles ; IDN normalisé', () => {
    expect(registrableDomain('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(registrableDomain('https://www.service.gouv.fr')).toBe('service.gouv.fr');
    expect(registrableDomain('http://203.0.113.7:8080/x')).toBe('203.0.113.7');
    expect(registrableDomain('https://[2001:db8::1]/x')).toBe('[2001:db8::1]');
    expect(registrableDomain('https://bücher.example.org')).toBe('example.org');
    expect(() => registrableDomain('')).toThrow(PacingKeyError);
  });

  test('le worker ne transmet au magasin que le domaine : API, utilisateur, proxy et IP n’entrent pas dans la clé', async () => {
    const seen: ReserveRequest[] = [];
    const store: PacingStore = {
      reserve: (r) => {
        seen.push(r);
        return Promise.resolve({ granted: true, slot: new Date(0), dbNow: new Date(0), probe: false });
      },
      record: () => Promise.reject(new Error('inutilisé')),
    };
    const pacer = new DomainPacer(store, { random: () => 0 });
    // Deux API, deux utilisateurs, trois proxys : le pacer ne reçoit que la cible.
    for (const target of ['https://a.example.com/x', 'https://b.example.com/y', 'https://example.com']) {
      await pacer.acquire(target);
    }
    expect(seen.map((r) => r.domain)).toEqual(['example.com', 'example.com', 'example.com']);
    expect(Object.keys(seen[0] as object).sort()).toEqual(['domain', 'isRetry', 'jitterMs', 'maxWaitMs', 'minDelayMs']);
  });
});

describe('délai effectif, gigue, Retry-After', () => {
  test('Crawl-delay prime s’il est plus grand que le réglage de l’API, jamais l’inverse', () => {
    expect(effectiveMinDelayMs(1500, 10_000)).toBe(10_000);
    expect(effectiveMinDelayMs(1500, 500)).toBe(1500);
    expect(effectiveMinDelayMs(1500, null)).toBe(1500);
    expect(() => effectiveMinDelayMs(-1)).toThrow(RangeError);
  });

  test('la gigue allonge le délai et reste bornée', () => {
    expect(jitterMs(1000, 0.2, () => 0)).toBe(0);
    expect(jitterMs(1000, 0.2, () => 0.5)).toBe(100);
    expect(jitterMs(1000, 0.2, () => 1)).toBeLessThan(200);
    expect(jitterMs(1000, 0, () => 0.9)).toBe(0);
  });

  test('Retry-After : secondes ou date HTTP, plafonné, valeur illisible ignorée', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    expect(parseRetryAfterMs('5', now, 3_600_000)).toBe(5000);
    expect(parseRetryAfterMs('999999', now, 60_000)).toBe(60_000);
    expect(parseRetryAfterMs('Thu, 01 Oct 2026 12:00:30 GMT', now, 3_600_000)).toBe(30_000);
    expect(parseRetryAfterMs('Thu, 01 Oct 2026 11:00:00 GMT', now, 3_600_000)).toBe(0);
    expect(parseRetryAfterMs('bientôt', now, 3_600_000)).toBeUndefined();
    expect(parseRetryAfterMs(null, now, 3_600_000)).toBeUndefined();
  });

  test('429 → rate_limited, 5xx → server_error, le reste n’est pas un refus', () => {
    expect([429, 503, 200, 404, 403].map(outcomeKindOfStatus)).toEqual(['rate_limited', 'server_error', 'ok', 'ok', 'ok']);
  });
});

describe('DomainPacer', () => {
  const fakeClock = () => {
    const sleeps: number[] = [];
    const clock: PacingClock = { now: () => new Date('2026-10-01T12:00:00Z'), sleep: (ms) => (sleeps.push(ms), Promise.resolve()) };
    return { clock, sleeps };
  };
  const outcome: OutcomeResult = { circuit: 'closed', opened: false, consecutiveFailures: 0, penaltyUntil: null, adaptiveDelayMs: 0 };

  test('attend slot − heure de la base sur l’horloge injectée (aucune attente réelle)', async () => {
    const { clock, sleeps } = fakeClock();
    const reservation: Reservation = { granted: true, slot: new Date(1000 + 1500), dbNow: new Date(1000), probe: false };
    const pacer = new DomainPacer({ reserve: () => Promise.resolve(reservation), record: () => Promise.resolve(outcome) }, { clock });
    const grant = await pacer.acquire('https://example.com');
    expect(grant).toEqual({ granted: true, domain: 'example.com', waitedMs: 1500, probe: false });
    expect(sleeps).toEqual([1500]);
  });

  test('refus : aucune attente, la date de report est rendue pour différer le job', async () => {
    const { clock, sleeps } = fakeClock();
    const retryAt = new Date('2026-10-01T12:05:00Z');
    const pacer = new DomainPacer(
      { reserve: () => Promise.resolve({ granted: false, reason: 'circuit_open', dbNow: clock.now(), retryAt }), record: () => Promise.resolve(outcome) },
      { clock },
    );
    expect(await pacer.acquire('https://example.com')).toEqual({ granted: false, domain: 'example.com', reason: 'circuit_open', retryAt });
    expect(sleeps).toEqual([]);
  });

  test('délai effectif = max(API, Crawl-delay) et gigue transmis au magasin ; report lit Retry-After', async () => {
    const { clock } = fakeClock();
    const reserved: ReserveRequest[] = [];
    const recorded: PacingOutcome[] = [];
    const pacer = new DomainPacer(
      {
        reserve: (r) => (reserved.push(r), Promise.resolve({ granted: true, slot: new Date(0), dbNow: new Date(0), probe: false })),
        record: (_d, o) => (recorded.push(o), Promise.resolve(outcome)),
      },
      { clock, random: () => 0.5 },
    );
    await pacer.acquire('https://example.com', { minDelayMs: 1000, crawlDelayMs: 4000, isRetry: true });
    expect(reserved[0]).toMatchObject({ minDelayMs: 4000, jitterMs: 400, maxWaitMs: DEFAULT_PACING_POLICY.maxWaitMs, isRetry: true });
    await pacer.report('https://www.example.com/x', { kind: 'rate_limited', retryAfter: '7' });
    await pacer.report('https://example.com', { kind: 'ok' });
    expect(recorded).toEqual([{ kind: 'rate_limited', retryAfterMs: 7000 }, { kind: 'ok' }]);
  });
});
