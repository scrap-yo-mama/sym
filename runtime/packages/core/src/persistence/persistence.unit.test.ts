// SPDX-License-Identifier: AGPL-3.0-only
// Mode « SYM ne lâche pas » (D-49, 04 §6, tâche 2.16), décisions pures : activation, entrée, issue d'une tentative,
// créneaux, plafonds, reports, récit. Le volet base (horloge simulée, file, webhooks, domaine partagé, bail) est dans
// packages/db/src/persistence.integration.test.ts.
import { describe, expect, test } from 'vitest';
import { classifyExchange } from '../exec/classify.js';
import { persistenceAttemptPayload, WEBHOOK_EVENTS } from '../webhook/index.js';
import {
  decidePersistenceActivation,
  effectivePersistenceBudgetUsd,
  parsePersistenceSchedule,
  PERSISTENCE_DEFAULTS,
  PERSISTENCE_NARRATIVE,
  PERSISTENCE_NARRATIVE_KEYS,
  PERSISTENCE_SWITCH_COPY,
  persistenceAttemptOutcome,
  persistenceCapReached,
  persistenceCopyCorpus,
  persistenceDeferral,
  persistenceDelayMs,
  persistenceEntry,
  persistencePolicyFromEnv,
  renderPersistenceNarrative,
} from './index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-10-02T09:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('assert_persistence_opt_in_only', () => {
  const eligible = { enable: true, actor: 'console', hasCurrentVersion: true, negativeMemoryAvailable: true, effectiveBudgetUsd: 1 } as const;

  test('activer : acte humain en console seulement ; une clé, MCP ou le système reçoivent 403 human_confirmation_required', () => {
    expect(decidePersistenceActivation(eligible)).toEqual({ ok: true });
    for (const actor of ['apikey', 'mcp', 'system'] as const) {
      expect(decidePersistenceActivation({ ...eligible, actor })).toEqual({ ok: false, status: 403, code: 'human_confirmation_required' });
    }
  });

  test('désactiver reste permis à toute clé du scope, même sur une API inéligible', () => {
    for (const actor of ['console', 'apikey', 'mcp', 'system'] as const) {
      expect(decidePersistenceActivation({ enable: false, actor, hasCurrentVersion: false, negativeMemoryAvailable: false, effectiveBudgetUsd: 0 })).toEqual({ ok: true });
    }
  });

  test('409 persistence_not_eligible : sans version courante, sans mémoire négative, plafond effectif ≤ 0', () => {
    expect(decidePersistenceActivation({ ...eligible, hasCurrentVersion: false })).toEqual({ ok: false, status: 409, code: 'persistence_not_eligible', reason: 'no_current_version' });
    expect(decidePersistenceActivation({ ...eligible, negativeMemoryAvailable: false })).toEqual({ ok: false, status: 409, code: 'persistence_not_eligible', reason: 'negative_memory_unavailable' });
    for (const budget of [0, -1, Number.NaN]) {
      expect(decidePersistenceActivation({ ...eligible, effectiveBudgetUsd: budget })).toMatchObject({ status: 409, reason: 'budget_not_positive' });
    }
  });

  test('plafond : `null` vaut PERSISTENCE_BUDGET_USD_DEFAULT, jamais « illimité »', () => {
    expect(effectivePersistenceBudgetUsd(PERSISTENCE_DEFAULTS, null)).toBe(1);
    expect(effectivePersistenceBudgetUsd(PERSISTENCE_DEFAULTS, 3)).toBe(3);
    const zero = persistencePolicyFromEnv({ PERSISTENCE_BUDGET_USD_DEFAULT: '0' });
    expect(decidePersistenceActivation({ ...eligible, effectiveBudgetUsd: effectivePersistenceBudgetUsd(zero, null) })).toMatchObject({ reason: 'budget_not_positive' });
    expect(() => persistencePolicyFromEnv({ PERSISTENCE_BUDGET_USD_DEFAULT: 'illimité' })).toThrow(/jamais illimité/);
    expect(() => persistencePolicyFromEnv({ PERSISTENCE_BUDGET_USD_DEFAULT: 'Infinity' })).toThrow();
  });
});

describe('assert_persistence_never_on_refusal', () => {
  test('entrée : seulement après une classe de la transition 16', () => {
    for (const failureClass of ['extraction', 'code_error', 'network', 'robots_unreachable'] as const) {
      expect(persistenceEntry({ failureClass })).toEqual({ eligible: true });
    }
    for (const failureClass of ['forbidden', 'blocked_by_protection', 'robots_disallowed', 'auth_required', 'payment_required', 'not_found', 'llm_refused', 'rate_limited', 'transient', null] as const) {
      expect(persistenceEntry({ failureClass })).toEqual({ eligible: false, reason: 'class_not_eligible' });
    }
  });

  test('entrée : jamais après not_compilable, un 451 ni une géo-restriction (un « non » légal ou géographique)', () => {
    expect(persistenceEntry({ failureClass: 'network', detail: 'geo_restriction', httpStatus: 451 })).toEqual({ eligible: false, reason: 'geo_restricted' });
    expect(persistenceEntry({ failureClass: 'network', detail: 'geo_restricted' })).toEqual({ eligible: false, reason: 'geo_restricted' });
    expect(persistenceEntry({ failureClass: 'network', httpStatus: 451 })).toEqual({ eligible: false, reason: 'geo_restricted' });
    expect(persistenceEntry({ failureClass: 'extraction', detail: 'not_compilable' })).toEqual({ eligible: false, reason: 'not_compilable' });
  });

  test('géo-restriction par redirection de pays (network/geo_redirect, 04 §7) : jamais d’entrée, et fin du mode (refused) sur une tentative', () => {
    expect(persistenceEntry({ failureClass: 'network', detail: 'geo_redirect', httpStatus: 302 })).toEqual({ eligible: false, reason: 'geo_restricted' });
    expect(persistenceAttemptOutcome({ state: 'failed', failureClass: 'network', detail: 'geo_redirect' })).toEqual({ kind: 'ended', ended: 'refused', reason: 'geo_restricted' });
    // Tout code de géo-restriction que produit le classifieur (451, redirection de pays) est reconnu, sans liste recopiée.
    const url = 'https://zz-test.example/catalogue';
    const produced = [
      classifyExchange({ url, status: 451, headers: {}, body: '' }),
      classifyExchange({ url, status: 302, headers: { location: '/unavailable-in-your-country' }, body: '' }, { requestUrl: url }),
      classifyExchange({ url: 'https://zz-test.example/geo-blocked', status: 200, headers: {}, body: '<p>x</p>' }, { requestUrl: url }),
    ];
    for (const f of produced) {
      expect(f?.detail).toMatch(/^geo_/);
      const failure = { failureClass: f!.failure_class, detail: f!.detail };
      expect(persistenceEntry(failure)).toEqual({ eligible: false, reason: 'geo_restricted' });
      expect(persistenceAttemptOutcome({ state: 'failed', ...failure })).toMatchObject({ kind: 'ended', ended: 'refused' });
    }
  });

  test('issue : refus robots.txt, défi, 401, 403, connexion requise, 451, géo-restriction, llm_refused → fin du mode (refused)', () => {
    const refused = [
      { failureClass: 'robots_disallowed' },
      { failureClass: 'blocked_by_protection' },
      { failureClass: 'forbidden', httpStatus: 403 },
      { failureClass: 'auth_required', httpStatus: 401 },
      { failureClass: 'payment_required' },
      { failureClass: 'account_limit' },
      { failureClass: 'network', httpStatus: 451, detail: 'geo_restriction' },
      { failureClass: 'network', detail: 'geo_restricted' },
      { failureClass: 'llm_refused' },
      { failureClass: null, detail: 'challenge_in_tunnel' },
    ] as const;
    for (const f of refused) expect(persistenceAttemptOutcome({ state: 'failed', ...f })).toMatchObject({ kind: 'ended', ended: 'refused' });
    // Un 401 ou un 403 n'est jamais une classe réessayable, quelle que soit l'étiquette qu'il porte.
    expect(persistenceAttemptOutcome({ state: 'failed', failureClass: 'extraction', httpStatus: 403 })).toMatchObject({ kind: 'ended', ended: 'refused' });
  });

  test('issue : llm_auth, llm_quota_exhausted, not_found et toute issue hors des classes de 16 → fin du mode (ineligible)', () => {
    for (const failureClass of ['llm_auth', 'llm_quota_exhausted', 'not_found', 'llm_unknown'] as const) {
      expect(persistenceAttemptOutcome({ state: 'failed', failureClass })).toEqual({ kind: 'ended', ended: 'ineligible', reason: failureClass });
    }
    expect(persistenceAttemptOutcome({ state: 'failed', failureClass: null, detail: 'proxy_not_configured' })).toMatchObject({ kind: 'ended', ended: 'ineligible' });
    expect(persistenceAttemptOutcome({ state: 'failed', failureClass: 'extraction', detail: 'not_compilable' })).toMatchObject({ kind: 'ended', ended: 'ineligible' });
  });

  test('issue : classes de 16, enquête sans conforme, 429 et indisponibilité → créneau suivant ; succès → retour à sain', () => {
    for (const failureClass of ['extraction', 'code_error', 'network', 'robots_unreachable', 'run_budget_exceeded', 'rate_limited', 'transient'] as const) {
      expect(persistenceAttemptOutcome({ state: 'failed', failureClass })).toEqual({ kind: 'retry', reason: failureClass });
    }
    expect(persistenceAttemptOutcome({ state: 'succeeded', failureClass: null })).toEqual({ kind: 'recovered' });
  });

  // Volet `prior_refusal` (mémoire négative relue avant chaque tentative) : la mémoire de 2.12 n'est pas fusionnée.
  test.todo('assert_persistence_never_on_refusal (prior_refusal) : un refus inscrit dans la mémoire négative de 2.12 arrête le mode avant toute requête — joué en 4.2');
});

describe('assert_persistence_schedule_and_caps', () => {
  test('créneaux : 1 h, 6 h, 24 h puis chaque jour, jitter ±20 %', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 10].map((n) => persistenceDelayMs(PERSISTENCE_DEFAULTS, n, mid))).toEqual([HOUR, 6 * HOUR, DAY, DAY, DAY, DAY]);
    expect(persistenceDelayMs(PERSISTENCE_DEFAULTS, 0, () => 0)).toBe(Math.round(HOUR * 0.8));
    expect(persistenceDelayMs(PERSISTENCE_DEFAULTS, 5, () => 1)).toBe(Math.round(DAY * 1.2));
  });

  test('PERSISTENCE_SCHEDULE, PERSISTENCE_MAX_DAYS lus de l’environnement (14 §2)', () => {
    expect(parsePersistenceSchedule('1h,6h,24h,24h…')).toEqual([HOUR, 6 * HOUR, DAY, DAY]);
    expect(parsePersistenceSchedule('30m, 2h...')).toEqual([30 * 60_000, 2 * HOUR]);
    expect(() => parsePersistenceSchedule('10s')).toThrow(/au moins 1 minute/);
    expect(() => parsePersistenceSchedule('')).toThrow();
    const p = persistencePolicyFromEnv({ PERSISTENCE_SCHEDULE: '2h,1d', PERSISTENCE_MAX_DAYS: '10', PERSISTENCE_BUDGET_USD_DEFAULT: '2.5' });
    expect(p).toMatchObject({ scheduleMs: [2 * HOUR, DAY], maxDays: 10, budgetUsdDefault: 2.5 });
    expect(persistencePolicyFromEnv({})).toEqual(PERSISTENCE_DEFAULTS);
    expect(() => persistencePolicyFromEnv({ PERSISTENCE_MAX_DAYS: '0' })).toThrow();
  });

  test('plafonds : PERSISTENCE_MAX_DAYS, persistence_budget_usd cumulé, budget_daily_usd', () => {
    const base = { now: at(DAY), enteredErrorAt: T0, spentUsd: 0.2, budgetUsd: 1, dailySpentUsd: 0.1, budgetDailyUsd: 5, maxDays: 30 };
    expect(persistenceCapReached(base)).toBeNull();
    expect(persistenceCapReached({ ...base, now: at(30 * DAY) })).toBe('max_days');
    expect(persistenceCapReached({ ...base, spentUsd: 1 })).toBe('budget');
    expect(persistenceCapReached({ ...base, budgetUsd: 0 })).toBe('budget');
    expect(persistenceCapReached({ ...base, dailySpentUsd: 5 })).toBe('daily_budget');
  });

  test('reports sans compter : disjoncteur ouvert, Retry-After, bail de réparation tenu, créneau du domaine pris', () => {
    const base = { now: T0, policy: PERSISTENCE_DEFAULTS, circuit: 'closed', circuitOpenUntil: null, penaltyUntil: null, leaseHeldByOther: false, domainBusyUntil: null } as const;
    expect(persistenceDeferral(base)).toBeNull();
    expect(persistenceDeferral({ ...base, circuit: 'open', circuitOpenUntil: at(2 * HOUR) })).toEqual({ reason: 'circuit_open', until: at(2 * HOUR) });
    // Ouvert mais échu : la cadence du domaine décide de la sonde, la tentative part.
    expect(persistenceDeferral({ ...base, circuit: 'open', circuitOpenUntil: at(-1) })).toBeNull();
    expect(persistenceDeferral({ ...base, penaltyUntil: at(3 * HOUR) })).toEqual({ reason: 'retry_after', until: at(3 * HOUR) });
    expect(persistenceDeferral({ ...base, leaseHeldByOther: true })).toEqual({ reason: 'repair_lease', until: at(PERSISTENCE_DEFAULTS.busyRetryMs) });
    expect(persistenceDeferral({ ...base, domainBusyUntil: at(HOUR) })).toEqual({ reason: 'domain_slot', until: at(HOUR) });
  });

  test('webhook api.persistence_attempt : codes et compteurs, sans phrase', () => {
    expect(WEBHOOK_EVENTS).toContain('api.persistence_attempt');
    const payload = persistenceAttemptPayload(T0, { api: 'zz_test_api', api_id: 'a1', run_id: 'r1', attempt: 2, outcome: 'retry', reason: 'extraction', next_at: at(DAY), spent_usd: 0.04, ended: null });
    expect(payload).toEqual({
      type: 'api.persistence_attempt',
      timestamp: T0.toISOString(),
      data: { api: 'zz_test_api', api_id: 'a1', run_id: 'r1', attempt: 2, outcome: 'retry', reason: 'extraction', next_at: at(DAY).toISOString(), spent_usd: 0.04, ended: null },
    });
    for (const value of Object.values(payload.data)) if (typeof value === 'string') expect(value).not.toMatch(/\s/);
  });
});

describe('récit et interrupteur (narrative.persistence.*, 19b §3, 20b §3.5)', () => {
  test('gabarits en et fr, mêmes clés, rendus à la lecture', () => {
    for (const locale of ['en', 'fr'] as const) expect(Object.keys(PERSISTENCE_NARRATIVE[locale]!).sort()).toEqual([...PERSISTENCE_NARRATIVE_KEYS].sort());
    expect(renderPersistenceNarrative('fr', 'narrative.persistence.recovered', { api: 'zz_test_api' })).toContain('zz_test_api');
    expect(renderPersistenceNarrative('fr', 'narrative.persistence.recovered', { api: 'zz_test_api' })).toBe('SYM 👻\u00a0: Je n’ai pas lâché : zz_test_api est de nouveau saine.');
    expect(renderPersistenceNarrative('en', 'narrative.persistence.stopped', { reason: 'refused' })).toContain('the site said no');
  });

  test('prochain essai dit comme 04 §6 : « demain à 09:10 », jour relatif et heure locale, jamais une date ISO brute', () => {
    const now = new Date('2026-10-02T14:00:00Z');
    const paris = { now, timeZone: 'Europe/Paris' };
    // Demain 09:10 à Paris (UTC+2 en octobre).
    expect(renderPersistenceNarrative('fr', 'narrative.persistence.attempt', { nextAt: new Date('2026-10-03T07:10:00Z'), ...paris })).toBe('SYM 👻\u00a0: Toujours en erreur. Je réessaie demain à 09:10.');
    expect(renderPersistenceNarrative('en', 'narrative.persistence.attempt', { nextAt: new Date('2026-10-03T07:10:00Z'), ...paris })).toBe('SYM 👻: Still in error. I will try again tomorrow at 09:10.');
    expect(renderPersistenceNarrative('fr', 'narrative.persistence.attempt', { nextAt: new Date('2026-10-02T15:30:00Z'), ...paris })).toBe('SYM 👻\u00a0: Toujours en erreur. Je réessaie aujourd’hui à 17:30.');
    // Au-delà de demain : la date courte, dans la langue du compte.
    expect(renderPersistenceNarrative('fr', 'narrative.persistence.attempt', { nextAt: new Date('2026-10-05T07:10:00Z'), ...paris })).toBe('SYM 👻\u00a0: Toujours en erreur. Je réessaie le 05/10 à 09:10.');
    expect(renderPersistenceNarrative('en', 'narrative.persistence.attempt', { nextAt: new Date('2026-10-05T07:10:00Z'), ...paris })).toBe('SYM 👻: Still in error. I will try again on 10/05 at 09:10.');
    // Le jour relatif suit le fuseau du lecteur, pas UTC : 23:30 UTC le 2 est déjà le 3 à Paris.
    expect(renderPersistenceNarrative('fr', 'narrative.persistence.attempt', { nextAt: new Date('2026-10-02T23:30:00Z'), ...paris })).toBe('SYM 👻\u00a0: Toujours en erreur. Je réessaie demain à 01:30.');
  });

  test('l’interrupteur dit ce qu’il ne fait pas : jamais après un refus, un défi ou une connexion requise', () => {
    expect(PERSISTENCE_SWITCH_COPY.fr!.help).toBe('Réessayer seul quand l’API est en erreur. Jamais après un refus, un défi ou une connexion requise.');
    expect(PERSISTENCE_SWITCH_COPY.en!.help).toMatch(/Never after a refusal, a challenge or a required login\./);
  });

  test('corpus du mode : aucune promesse de contournement ni idiome d’invisibilité (garde d’assert_brand_copy_no_bypass_promise)', () => {
    const promise = /contourn|bypass|circumvent|unblock|débloqu|indétectable|undetect|invisible|stealth|furtif|captcha|anti-?bot|passe[- ]partout|sans être vu|unseen|ghost mode|mode fantôme/iu;
    const corpus = persistenceCopyCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(2 * (PERSISTENCE_NARRATIVE_KEYS.length + 2));
    for (const text of corpus) expect(text).not.toMatch(promise);
  });
});
