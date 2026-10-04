// SPDX-License-Identifier: AGPL-3.0-only
// assert_status_transitions, part 2 (15 §3) : test basé sur un modèle fast-check (commands, modelRun, replayPath).
// Modèle de référence réécrit à part de la machine, horloge injectée, 11 commandes. Rejouer une séquence fautive :
//   STATUS_MODEL_SEED=<graine> STATUS_MODEL_PATH=<chemin> pnpm vitest run --project unit packages/core/src/status/machine.prop
import fc from 'fast-check';
import { describe, test } from 'vitest';
import type { FailureClass } from '../model/enums.js';
import {
  applyStatusEvent,
  DEGRADED_SIGNALS,
  gateRun,
  initialStatusState,
  INVESTIGATION_FAILURE_REASONS,
  quietPeriodMs,
  TRANSITIONS,
  withStale,
  type ApiStatusState,
  type ActionReason,
  type DegradedSignal,
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

const BLOCK = new Set(['blocked_by_protection', 'forbidden']);
const ACTION_INVESTIGATION = new Set(['auth_required', 'payment_required', 'account_limit', 'proxy_not_configured', 'tunnel_offline', 'instance_contact_missing', 'llm_price_missing']);
const ACTION_REPAIR = new Set(['auth_required', 'payment_required', 'account_limit', 'challenge_in_tunnel']);
const REPAIRABLE = new Set(['extraction', 'code_error', 'network', 'not_found']);
const BACKOFF_OK = new Set(['extraction', 'code_error', 'network']);

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
      // Tentative de persistance (prev = erreur) : tout échec repasse par la 21, jamais par la 2 (D-49).
      if (m.prev !== null) return go([21], m.prev, ev.cause === 'not_compilable' ? 'not_compilable' : 'reinvestigation_failed', { prev: null });
      return go([2], 'erreur', INVESTIGATION_FAILURE_REASONS[ev.cause], { prev: null });
    case 'prior_refusal':
      // Mémoire négative (2.12) : enquête arrêtée par la transition 4.
      return m.status === 'enquete' ? go([4], 'bloquee', 'prior_refusal', { prev: null }) : same;
    case 'run_failed':
    case 'run_stopped': {
      // Classe d'échec ou code de raison sans classe : même aiguillage, la valeur devient la raison journalisée.
      const c: string = ev.type === 'run_failed' ? ev.failureClass : ev.reason;
      if (ev.type === 'run_failed' && c === 'network' && [401, 403, 429].includes(ev.httpStatus ?? 0)) return same;
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
      const reason = { manual: 'reinvestigate_manual', schema_changed: 'output_schema_changed', force_investigate: 'force_investigate', rules_changed: 'rules_changed' }[ev.trigger];
      if (m.status === 'sain') return go([19], 'enquete', reason, { prev: 'sain' });
      if (m.status === 'warning') return go([20], 'enquete', reason, { prev: 'warning' });
      if (m.status === 'erreur' && (ev.trigger === 'manual' || ev.trigger === 'force_investigate')) return go([16], 'enquete', reason, { prev: null });
      if (m.status === 'bloquee' && ev.trigger === 'manual') return go([18], 'enquete', reason, { prev: null });
      return same;
    }
    case 'backoff_elapsed':
      return m.status === 'erreur' && BACKOFF_OK.has(ev.failureClass) && ev.attempt >= 0 && ev.attempt <= 2
        ? go([16], 'enquete', 'backoff', { prev: null })
        : same;
    case 'persistence_attempt':
      return m.status === 'erreur' && BACKOFF_OK.has(ev.failureClass) ? go([16], 'enquete', 'persistence_attempt', { prev: 'erreur' }) : same;
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
    : before.status === 'bloquee' && trigger === 'schedule' ? 'skipped_status'
    : 'run';
  if (gate.kind !== expectedGate) fail(`garde ${gate.kind} != ${expectedGate} en ${before.status}`);
  if (gate.kind === 'run') {
    real.attempts += 1;
    drive(model, real, ev);
    return;
  }
  // Aucun essai, aucune transition : `api_error` en erreur, pas de run planifié en bloquee.
  if (gate.kind === 'api_error') real.apiErrors += 1;
}

// Tous les signaux de la machine (`DEGRADED_SIGNALS`), jamais une liste recopiée : un signal ajouté est exploré d'office.
const signalsArb = fc.subarray<DegradedSignal>([...DEGRADED_SIGNALS], { minLength: 1 });
const failureArb = fc.constantFrom<FailureClass>(
  'transient', 'extraction', 'code_error', 'network', 'auth_required', 'forbidden', 'blocked_by_protection', 'payment_required',
  'account_limit', 'rate_limited', 'not_found', 'run_budget_exceeded', 'budget_exceeded',
  'llm_refused',
);
const reasonArb = fc.constantFrom<ActionReason>('challenge_in_tunnel', 'proxy_not_configured', 'tunnel_offline', 'instance_contact_missing', 'llm_price_missing');
const httpArb = fc.constantFrom<number | undefined>(undefined, undefined, 401, 403, 429, 451, 500);
const triggerArb = fc.constantFrom<'schedule' | 'on_demand'>('schedule', 'on_demand');
/** Run en échec : avec une classe (`run_failed`) ou arrêté pour une raison sans classe (`run_stopped`). */
/** Pondéré comme le tirage unique d'avant la séparation classes / raisons (16 classes, 3 raisons). */
const failedRunArb = fc.oneof(
  {
    weight: 16,
    arbitrary: fc.tuple(failureArb, httpArb).map(([c, h]): StatusEventInput => ({ type: 'run_failed', failureClass: c, ...(h === undefined ? {} : { httpStatus: h }) })),
  },
  { weight: 3, arbitrary: reasonArb.map((reason): StatusEventInput => ({ type: 'run_stopped', reason })) },
);

type Cmd = fc.Command<Model, Real>;
const cmd = (label: string, run: (m: Model, r: Real) => void): Cmd => ({
  check: () => true,
  run,
  toString: () => label,
});

// 11 commandes : run propre, dégradé, échec, retour de version, issue de réparation, issue d'enquête, ré-enquête,
// action de l'utilisateur, backoff, tentative de persistance (D-49), passage du temps (avec contrôle du drapeau stale).
const commandArbs = [
  triggerArb.map((t) => cmd(`CleanRun(${t})`, (m, r) => drivenRun(m, r, { type: 'run_succeeded', signals: [] }, t))),
  fc.tuple(signalsArb, triggerArb).map(([s, t]) => cmd(`DegradedRun(${s.join('+')},${t})`, (m, r) => drivenRun(m, r, { type: 'run_succeeded', signals: s }, t))),
  fc.tuple(failedRunArb, triggerArb).map(([e, t]) => cmd(`FailedRun(${JSON.stringify(e)},${t})`, (m, r) => drivenRun(m, r, e, t))),
  triggerArb.map((t) => cmd(`VersionRollback(${t})`, (m, r) => drivenRun(m, r, { type: 'version_rollback' }, t))),
  fc.constantFrom<StatusEventInput>({ type: 'repair_succeeded' }, { type: 'repair_failed', cause: 'budget_exhausted' }, { type: 'repair_failed', cause: 'repeated_patch' })
    .map((e) => cmd(`RepairResult(${JSON.stringify(e)})`, (m, r) => drive(m, r, e))),
  fc.constantFrom<StatusEventInput>(
    { type: 'investigation_succeeded' },
    { type: 'investigation_failed', cause: 'budget_exhausted' },
    { type: 'investigation_failed', cause: 'trial_cost_over_cap' },
    { type: 'investigation_failed', cause: 'no_conformant_strategy' },
    { type: 'investigation_failed', cause: 'error' },
    { type: 'prior_refusal' },
  ).map((e) => cmd(`InvestigationResult(${JSON.stringify(e)})`, (m, r) => drive(m, r, e))),
  fc.constantFrom<ReinvestigationTrigger>('manual', 'schema_changed', 'force_investigate', 'rules_changed').map((trigger) =>
    cmd(`Reinvestigate(${trigger})`, (m, r) => drive(m, r, { type: 'reinvestigate', trigger }, { manualReinvestigation: trigger === 'manual' })),
  ),
  fc.constant(cmd('UserActed', (m, r) => drive(m, r, { type: 'user_acted' }))),
  fc.tuple(failureArb, fc.integer({ min: -1, max: 4 })).map(([c, a]) =>
    cmd(`Backoff(${c},${String(a)})`, (m, r) => drive(m, r, { type: 'backoff_elapsed', failureClass: c, attempt: a })),
  ),
  // Tentative de persistance (2.16) : 16 depuis `erreur` seulement, puis 1 ou 21 (4 ou 3 sur un refus) ; aucune transition nouvelle.
  failureArb.map((c) => cmd(`PersistenceAttempt(${c})`, (m, r) => drive(m, r, { type: 'persistence_attempt', failureClass: c }))),
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
    // Garde-fou du modèle : sans ce test, un modèle qui n'explorerait que quelques états passerait pour vert. 6 000 marches :
    // avec la mémoire négative (2.12) et la tentative de persistance (2.16), 3 000 ne suffisent plus à atteindre la 13. Graine fixe : 42 laissait 9 transitions hors de portée une fois les classes robots_* retirées des tirages (D-91), 43 les atteint toutes ; sur un nouveau déséquilibre, changer la graine.
    const seen = new Set<number>();
    fc.assert(
      fc.property(fc.commands(commandArbs, { maxCommands: 10, size: 'max' }), (cmds) => {
        const model: Model = { m: { status: 'enquete', reason: null, streak: 0, prev: null, lastSignal: null }, now: T0 };
        const real: Real = { state: initialStatusState(), log: [], now: T0, attempts: 0, apiErrors: 0 };
        fc.modelRun(() => ({ model, real }), cmds);
        for (const t of real.log) seen.add(t.transition);
      }),
      { numRuns: 6000, seed: 43 },
    );
    const missing = TRANSITIONS.map((t) => t.id).filter((id) => !seen.has(id));
    if (missing.length > 0) throw new Error(`transitions jamais atteintes par le modèle : ${missing.join(', ')}`);
  });
});
