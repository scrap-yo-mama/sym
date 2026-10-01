// SPDX-License-Identifier: AGPL-3.0-only
// assert_status_transitions, part 2 (15 §3) : test basé sur un modèle fast-check (commands, modelRun, replayPath).
// Modèle de référence réécrit à part de la machine, horloge injectée, 10 commandes. Rejouer une séquence fautive :
//   STATUS_MODEL_SEED=<graine> STATUS_MODEL_PATH=<chemin> pnpm vitest run --project unit packages/core/src/status/machine.prop
import fc from 'fast-check';
import { describe, test } from 'vitest';
import {
  applyStatusEvent,
  gateRun,
  initialStatusState,
  quietPeriodMs,
  TRANSITIONS,
  withStale,
  type ApiStatusState,
  type DegradedSignal,
  type FailureClass,
  type ReinvestigationTrigger,
  type Status,
  type StatusEventInput,
  type TransitionRecord,
} from './index.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const PERIOD: number | null = null; // pas de planification : D = 7 j

// ---------------------------------------------------------------- modèle de référence

type ModelState = { status: Status; reason: string | null; streak: number; prev: Status | null; lastSignal: number | null };
type Expected = { ids: number[]; next: ModelState };

const BLOCK = new Set(['blocked_by_protection', 'forbidden', 'robots_disallowed']);
const ACTION_INVESTIGATION = new Set(['auth_required', 'payment_required', 'account_limit', 'proxy_not_configured', 'tunnel_offline']);
const ACTION_REPAIR = new Set(['auth_required', 'payment_required', 'account_limit', 'challenge_in_tunnel']);
const REPAIRABLE = new Set(['extraction', 'code_error', 'network', 'not_found']);
const BACKOFF_OK = new Set(['extraction', 'code_error', 'network', 'robots_unreachable']);

function modelStep(m: ModelState, ev: StatusEventInput, now: number): Expected {
  const same: Expected = { ids: [], next: m };
  const go = (ids: number[], status: Status, reason: string, patch: Partial<ModelState> = {}): Expected => ({
    ids,
    next: { ...m, ...patch, status, reason },
  });
  const signal = { lastSignal: now };
  switch (ev.type) {
    case 'investigation_succeeded':
      return m.status === 'enquete' ? go([1], 'sain', 'strategy_conform', { streak: 0, prev: null }) : same;
    case 'investigation_failed':
      if (m.status !== 'enquete') return same;
      if (ev.cause === 'budget_exhausted' && m.prev !== null) return go([21], m.prev, 'reinvestigation_failed', { prev: null });
      return go([2], 'erreur', ev.cause === 'robots_unreachable' ? 'robots_unreachable' : 'investigation_budget_exhausted', { prev: null });
    case 'run_failed': {
      const c: string = ev.failureClass;
      if (c === 'network' && [401, 403, 429].includes(ev.httpStatus ?? 0)) return same;
      if (m.status === 'enquete') {
        if (ACTION_INVESTIGATION.has(c)) return go([3], 'action_requise', c, { prev: null });
        if (BLOCK.has(c)) return go([4], 'bloquee', c, { prev: null });
        return same;
      }
      if (m.status === 'reparation') {
        if (BLOCK.has(c)) return go([15], 'bloquee', c);
        if (ACTION_REPAIR.has(c)) return go([14], 'action_requise', c);
        return same;
      }
      if (m.status !== 'sain' && m.status !== 'warning') return same;
      const fromSain = m.status === 'sain';
      if (c === 'transient') return go([fromSain ? 6 : 8], 'warning', 'unavailable', { streak: 0, ...signal });
      if (REPAIRABLE.has(c) || BLOCK.has(c) || ACTION_REPAIR.has(c)) {
        const first = fromSain ? 10 : 11;
        const into = { streak: 0, ...signal };
        if (BLOCK.has(c)) return { ids: [first, 15], next: { ...m, ...into, status: 'bloquee', reason: c } };
        if (ACTION_REPAIR.has(c)) return { ids: [first, 14], next: { ...m, ...into, status: 'action_requise', reason: c } };
        return go([first], 'reparation', c, into);
      }
      return same;
    }
    case 'run_succeeded': {
      if (m.status !== 'sain' && m.status !== 'warning') return same;
      if (ev.signals.length === 0) {
        if (m.status === 'sain') return same;
        const quiet = m.lastSignal === null || now - m.lastSignal >= Math.max(7 * DAY, 3 * (PERIOD ?? 0));
        if (m.streak + 1 >= 3) return go([9], 'sain', 'clean_streak', { streak: 0 });
        if (quiet) return go([9], 'sain', 'quiet_period', { streak: 0 });
        return { ids: [], next: { ...m, streak: m.streak + 1 } };
      }
      const onlySlow = ev.signals.every((s) => s === 'slow');
      return go([m.status === 'sain' ? 5 : 8], 'warning', ev.signals[0]!, { streak: onlySlow ? m.streak : 0, ...signal });
    }
    case 'version_rollback':
      if (m.status === 'sain') return go([7], 'warning', 'version_rollback', { streak: 0, ...signal });
      if (m.status === 'warning') return go([8], 'warning', 'version_rollback', { streak: 0, ...signal });
      return same;
    case 'repair_succeeded':
      return m.status === 'reparation' ? go([12], 'warning', 'repaired', { streak: 0, ...signal }) : same;
    case 'repair_failed':
      return m.status === 'reparation'
        ? go([13], 'erreur', ev.cause === 'repeated_patch' ? 'repair_repeated_patch' : 'repair_budget_exhausted')
        : same;
    case 'reinvestigate': {
      const reason = { manual: 'reinvestigate_manual', schema_changed: 'output_schema_changed', force_investigate: 'force_investigate' }[ev.trigger];
      if (m.status === 'sain') return go([19], 'enquete', reason, { prev: 'sain' });
      if (m.status === 'warning') return go([20], 'enquete', reason, { prev: 'warning' });
      if (m.status === 'erreur' && ev.trigger !== 'schema_changed') return go([16], 'enquete', reason, { prev: null });
      if (m.status === 'bloquee' && ev.trigger === 'manual') return go([18], 'enquete', reason, { prev: null });
      return same;
    }
    case 'backoff_elapsed':
      return m.status === 'erreur' && BACKOFF_OK.has(ev.failureClass) && ev.attempt >= 0 && ev.attempt <= 2
        ? go([16], 'enquete', 'backoff', { prev: null })
        : same;
    case 'user_acted':
      return m.status === 'action_requise' ? go([17], 'enquete', 'user_acted', { prev: null }) : same;
  }
}

// ---------------------------------------------------------------- système sous test (machine + journal en mémoire)

type Model = { m: ModelState; now: number };
type Real = {
  state: ApiStatusState;
  log: TransitionRecord[];
  now: number;
  attempts: number;
  apiErrors: number;
};

const ctxOf = (r: Real) => ({ clock: { now: () => new Date(r.now) }, schedulePeriodMs: PERIOD });

function fail(message: string): never {
  throw new Error(message);
}

/** Applique un événement à la machine réelle et vérifie les invariants locaux et l'égalité avec le modèle. */
function drive(model: Model, real: Real, ev: StatusEventInput, opts: { manualReinvestigation?: boolean } = {}): void {
  const before = real.state;
  const expected = modelStep(model.m, ev, model.now);
  const step = applyStatusEvent(before, ev, ctxOf(real));
  real.log.push(...step.transitions);
  real.state = step.state;
  model.m = expected.next;

  // Modèle et implémentation : mêmes transitions, statuts, raisons, clean_streak.
  const ids = step.transitions.map((t) => t.transition);
  if (JSON.stringify(ids) !== JSON.stringify(expected.ids)) fail(`transitions ${JSON.stringify(ids)} != modèle ${JSON.stringify(expected.ids)} (${before.status}, ${JSON.stringify(ev)})`);
  const s = step.state;
  const n = expected.next;
  if (s.status !== n.status || s.reason !== (n.reason ?? s.reason) || s.cleanStreak !== n.streak || s.previousStatus !== n.prev) {
    fail(`état ${JSON.stringify(s)} != modèle ${JSON.stringify(n)}`);
  }
  // Aucun changement de statut sans événement journalisé, chaînés de l'ancien au nouveau statut.
  if (step.transitions.length === 0) {
    if (s.status !== before.status) fail('statut changé sans ligne status_events');
  } else {
    let at: Status = before.status;
    for (const t of step.transitions) {
      if (t.from !== at) fail(`chaîne rompue : ${t.from} != ${at}`);
      at = t.to;
    }
    if (at !== s.status) fail('dernier to_status différent du statut final');
  }
  // Chaque transition journalisée existe dans la table des 21, avec un code de raison stable de cette transition.
  for (const t of step.transitions) {
    const def = TRANSITIONS.find((d) => d.id === t.transition);
    if (def === undefined || def.from !== t.from || !def.reasons.includes(t.reason)) fail(`transition hors table : ${JSON.stringify(t)}`);
    if (t.transition !== 21 && def.to !== t.to) fail(`to_status hors table : ${JSON.stringify(t)}`);
    if (t.transition === 21 && t.to !== before.previousStatus) fail('21 ne revient pas à previous_status');
  }
  // `bloquee` ne se quitte que par ré-enquête manuelle (18).
  if (before.status === 'bloquee' && s.status !== 'bloquee') {
    if (!(opts.manualReinvestigation === true && ids.length === 1 && ids[0] === 18)) fail('bloquee quittée autrement que par 18 manuel');
  }
  // Aucun 401, 403 ou 429 ne produit la classe network.
  if (ev.type === 'run_failed' && ev.failureClass === 'network' && [401, 403, 429].includes(ev.httpStatus ?? 0)) {
    if (step.ok || step.transitions.length > 0 || s !== before) fail('un 401/403/429 a été accepté comme network');
  }
  if (step.transitions.some((t) => t.reason === 'network' && ev.type === 'run_failed' && [401, 403, 429].includes(ev.httpStatus ?? 0))) {
    fail('raison network sur un 401/403/429');
  }
}

/** Commande « run » : la garde décide d'abord ; seul un run autorisé fait un essai et applique l'événement. */
function drivenRun(model: Model, real: Real, ev: StatusEventInput, trigger: 'schedule' | 'on_demand'): void {
  const before = real.state;
  const gate = gateRun(before, { trigger });
  const expectedGate =
    before.status === 'erreur' ? 'api_error'
    : before.status === 'bloquee' && before.reason === 'robots_disallowed' ? 'refused'
    : before.status === 'bloquee' && trigger === 'schedule' ? 'skipped_status'
    : 'run';
  if (gate.kind !== expectedGate) fail(`garde ${gate.kind} != ${expectedGate} en ${before.status}`);
  if (gate.kind === 'run') {
    real.attempts += 1;
    drive(model, real, ev);
    return;
  }
  // Aucun essai, aucune transition : `api_error` en erreur, 0 requête après robots_disallowed, pas de run planifié en bloquee.
  if (gate.kind === 'api_error') real.apiErrors += 1;
}

const signalsArb = fc.subarray<DegradedSignal>(
  ['retried', 'escalated', 'repaired', 'optional_fields_missing', 'volume_anomaly', 'pagination_short', 'slow', 'cost_anomaly'],
  { minLength: 1 },
);
const failureArb = fc.constantFrom<FailureClass>(
  'transient', 'extraction', 'code_error', 'network', 'auth_required', 'forbidden', 'blocked_by_protection', 'robots_disallowed',
  'payment_required', 'account_limit', 'challenge_in_tunnel', 'proxy_not_configured', 'tunnel_offline', 'rate_limited', 'not_found',
  'robots_unreachable', 'llm_refused',
);
const httpArb = fc.constantFrom<number | undefined>(undefined, undefined, 401, 403, 429, 451, 500);
const triggerArb = fc.constantFrom<'schedule' | 'on_demand'>('schedule', 'on_demand');

type Cmd = fc.Command<Model, Real>;
const cmd = (label: string, run: (m: Model, r: Real) => void): Cmd => ({
  check: () => true,
  run,
  toString: () => label,
});

// 10 commandes : run propre, dégradé, échec, retour de version, issue de réparation, issue d'enquête, ré-enquête,
// action de l'utilisateur, backoff, passage du temps (avec contrôle du drapeau stale).
const commandArbs = [
  triggerArb.map((t) => cmd(`CleanRun(${t})`, (m, r) => drivenRun(m, r, { type: 'run_succeeded', signals: [] }, t))),
  fc.tuple(signalsArb, triggerArb).map(([s, t]) => cmd(`DegradedRun(${s.join('+')},${t})`, (m, r) => drivenRun(m, r, { type: 'run_succeeded', signals: s }, t))),
  fc.tuple(failureArb, httpArb, triggerArb).map(([c, h, t]) =>
    cmd(`FailedRun(${c},${String(h)},${t})`, (m, r) => drivenRun(m, r, { type: 'run_failed', failureClass: c, ...(h === undefined ? {} : { httpStatus: h }) }, t)),
  ),
  triggerArb.map((t) => cmd(`VersionRollback(${t})`, (m, r) => drivenRun(m, r, { type: 'version_rollback' }, t))),
  fc.constantFrom<StatusEventInput>({ type: 'repair_succeeded' }, { type: 'repair_failed', cause: 'budget_exhausted' }, { type: 'repair_failed', cause: 'repeated_patch' })
    .map((e) => cmd(`RepairResult(${JSON.stringify(e)})`, (m, r) => drive(m, r, e))),
  fc.constantFrom<StatusEventInput>(
    { type: 'investigation_succeeded' },
    { type: 'investigation_failed', cause: 'budget_exhausted' },
    { type: 'investigation_failed', cause: 'robots_unreachable' },
  ).map((e) => cmd(`InvestigationResult(${JSON.stringify(e)})`, (m, r) => drive(m, r, e))),
  fc.constantFrom<ReinvestigationTrigger>('manual', 'schema_changed', 'force_investigate').map((trigger) =>
    cmd(`Reinvestigate(${trigger})`, (m, r) => drive(m, r, { type: 'reinvestigate', trigger }, { manualReinvestigation: trigger === 'manual' })),
  ),
  fc.constant(cmd('UserActed', (m, r) => drive(m, r, { type: 'user_acted' }))),
  fc.tuple(failureArb, fc.integer({ min: -1, max: 4 })).map(([c, a]) =>
    cmd(`Backoff(${c},${String(a)})`, (m, r) => drive(m, r, { type: 'backoff_elapsed', failureClass: c, attempt: a })),
  ),
  fc.tuple(fc.integer({ min: 0, max: 30 }), fc.boolean(), fc.boolean(), fc.boolean()).map(([days, canary, confirmed, ran]) =>
    cmd(`TimePasses(${String(days)}j,canary=${String(canary)})`, (m, r) => {
      m.now += days * DAY;
      r.now += days * DAY;
      const before = r.state;
      const logLength = r.log.length;
      const input = { lastRunAt: ran ? r.now - days * DAY : null, canaryFailing: canary, breakConfirmed: confirmed };
      const after = withStale(before, input, ctxOf(r));
      const stale = (ran && days * DAY >= quietPeriodMs(PERIOD)) || (canary && !confirmed);
      if (after.stale !== stale) fail('stale incohérent');
      if (after.status !== before.status || after.reason !== before.reason || after.cleanStreak !== before.cleanStreak) {
        fail('stale a modifié l\'état');
      }
      if (r.log.length !== logLength) fail('stale a produit une transition');
      r.state = after;
    }),
  ),
];

function seedFromEnv(): { seed?: number; path?: string } {
  const seed = process.env.STATUS_MODEL_SEED;
  const path = process.env.STATUS_MODEL_PATH;
  return { ...(seed === undefined ? {} : { seed: Number(seed) }), ...(path === undefined ? {} : { path }) };
}

describe('assert_status_transitions (modèle)', () => {
  test('modèle fast-check : statuts, raisons, clean_streak et invariants de 15 §3', () => {
    const { seed, path } = seedFromEnv();
    fc.assert(
      fc.property(
        fc.commands(commandArbs, { maxCommands: 10, size: 'max', ...(path === undefined ? {} : { replayPath: path }) }),
        (cmds) => {
          const setup = () => {
            const state = initialStatusState();
            return {
              model: { m: { status: state.status, reason: null, streak: 0, prev: null, lastSignal: null }, now: T0 } as Model,
              real: { state, log: [], now: T0, attempts: 0, apiErrors: 0 } as Real,
            };
          };
          fc.modelRun(setup, cmds);
        },
      ),
      { numRuns: 400, ...(seed === undefined ? {} : { seed }), ...(path === undefined ? {} : { endOnFailure: false }) },
    );
  });

  test('couverture : la marche aléatoire atteint les 21 transitions', () => {
    // Garde-fou du modèle : sans ce test, un modèle qui n'explorerait que quelques états passerait pour vert.
    const seen = new Set<number>();
    fc.assert(
      fc.property(fc.commands(commandArbs, { maxCommands: 10, size: 'max' }), (cmds) => {
        const model: Model = { m: { status: 'enquete', reason: null, streak: 0, prev: null, lastSignal: null }, now: T0 };
        const real: Real = { state: initialStatusState(), log: [], now: T0, attempts: 0, apiErrors: 0 };
        fc.modelRun(() => ({ model, real }), cmds);
        for (const t of real.log) seen.add(t.transition);
      }),
      { numRuns: 3000, seed: 42 },
    );
    const missing = TRANSITIONS.map((t) => t.id).filter((id) => !seen.has(id));
    if (missing.length > 0) throw new Error(`transitions jamais atteintes par le modèle : ${missing.join(', ')}`);
  });
});
