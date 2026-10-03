// SPDX-License-Identifier: AGPL-3.0-only
// Mode « SYM ne lâche pas » (D-49, 04 §6, tâche 2.16) : décisions pures, sans I/O ni horloge propre.
// - activation : opt-in par API, acte humain en console seulement (une clé reçoit 403), version courante, mémoire
//   négative en service et plafond effectif > 0 exigés (409 `persistence_not_eligible`) ; la désactivation est libre ;
// - entrée : seulement après une classe de la transition 16, jamais après `not_compilable` ni une géo-restriction (451) ;
// - issue d'une tentative : retour à `sain`, nouvel essai au créneau suivant, ou fin du mode (`refused` sur un « non »,
//   `ineligible` sur toute issue hors des classes de 16, `exhausted` sur un plafond) ; SYM ne relance jamais un « non » ;
// - créneaux : 1 h, 6 h, 24 h puis chaque jour (`PERSISTENCE_SCHEDULE`, à valider), jitter ±20 % ;
// - reports SANS compter la tentative : disjoncteur du domaine ouvert, `Retry-After` en cours, bail de réparation tenu,
//   créneau du domaine pris par une autre API.
import { isGeoRestrictionDetail } from '../exec/classify.js';
import type { FailureClass } from '../model/enums.js';
import { BACKOFF_CLASSES, BLOCKING_CLASSES, INVESTIGATION_ACTION_CLASSES } from '../status/types.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type PersistencePolicy = {
  /** Délais successifs entre deux tentatives ; le dernier se répète (« puis chaque jour »). */
  readonly scheduleMs: readonly number[];
  readonly jitterRatio: number;
  /** `PERSISTENCE_BUDGET_USD_DEFAULT` : plafond quand `persistence_budget_usd` vaut `null` (jamais « illimité »). */
  readonly budgetUsdDefault: number;
  /** `PERSISTENCE_MAX_DAYS` : durée maximale en `erreur`, puis `persistence_exhausted`. */
  readonly maxDays: number;
  /** Largeur du créneau d'un domaine enregistrable : une seule tentative par domaine et par créneau. */
  readonly domainSlotMs: number;
  /** Report quand le bail de réparation est tenu ou qu'une tentative du même domaine est en cours. */
  readonly busyRetryMs: number;
};

/** Valeurs de 14 §2 (« à valider ») : `1h,6h,24h,24h…`, 1 $, 30 j. */
export const PERSISTENCE_DEFAULTS: PersistencePolicy = {
  scheduleMs: [HOUR_MS, 6 * HOUR_MS, DAY_MS],
  jitterRatio: 0.2,
  budgetUsdDefault: 1,
  maxDays: 30,
  domainSlotMs: HOUR_MS,
  busyRetryMs: 15 * MINUTE_MS,
};

export class PersistenceConfigError extends Error {
  override name = 'PersistenceConfigError';
}

const UNIT_MS: Record<string, number> = { s: 1000, m: MINUTE_MS, h: HOUR_MS, d: DAY_MS };

/** `1h,6h,24h,24h…` : durées (s, m, h, d) ; points de suspension finaux ignorés (le dernier délai se répète). */
export function parsePersistenceSchedule(text: string): number[] {
  const parts = text.replace(/(?:…|\.\.\.)\s*$/u, '').split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) throw new PersistenceConfigError('PERSISTENCE_SCHEDULE vide : délais du type 1h,6h,24h attendus.');
  return parts.map((part) => {
    const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(part);
    const ms = match === null ? Number.NaN : Number(match[1]) * UNIT_MS[match[2]!]!;
    if (!Number.isFinite(ms) || ms < MINUTE_MS) throw new PersistenceConfigError(`PERSISTENCE_SCHEDULE invalide (« ${part} ») : durée d'au moins 1 minute attendue (s, m, h, d).`);
    return ms;
  });
}

/** Politique lue une fois au démarrage du worker (14 §2). */
export function persistencePolicyFromEnv(env: Readonly<Record<string, string | undefined>>): PersistencePolicy {
  const d = PERSISTENCE_DEFAULTS;
  const schedule = env['PERSISTENCE_SCHEDULE'];
  const budget = env['PERSISTENCE_BUDGET_USD_DEFAULT'];
  const days = env['PERSISTENCE_MAX_DAYS'];
  const budgetUsdDefault = budget === undefined || budget === '' ? d.budgetUsdDefault : Number(budget);
  // Plafond d'instance nul ou négatif : accepté (il refuse toute activation sans plafond propre), jamais « illimité ».
  if (!Number.isFinite(budgetUsdDefault)) throw new PersistenceConfigError('PERSISTENCE_BUDGET_USD_DEFAULT invalide : montant en dollars attendu (jamais illimité).');
  const maxDays = days === undefined || days === '' ? d.maxDays : Number(days);
  if (!Number.isInteger(maxDays) || maxDays < 1) throw new PersistenceConfigError('PERSISTENCE_MAX_DAYS invalide : entier ≥ 1 attendu.');
  return { ...d, scheduleMs: schedule === undefined || schedule === '' ? d.scheduleMs : parsePersistenceSchedule(schedule), budgetUsdDefault, maxDays };
}

/** Délai avant la tentative suivante, `attempts` tentatives déjà comptées ; jitter ±`jitterRatio`. Jamais `null` : le dernier délai se répète. */
export function persistenceDelayMs(policy: PersistencePolicy, attempts: number, random: () => number): number {
  const index = Math.min(Math.max(0, Math.trunc(attempts)), policy.scheduleMs.length - 1);
  const base = policy.scheduleMs[index]!;
  return Math.round(base * (1 + policy.jitterRatio * (2 * random() - 1)));
}

/** `persistence_budget_usd` ou, s'il vaut `null`, le défaut d'instance. Jamais « illimité ». */
export function effectivePersistenceBudgetUsd(policy: PersistencePolicy, budgetUsd: number | null): number {
  return budgetUsd ?? policy.budgetUsdDefault;
}

// ---------------------------------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------------------------------

/** Origine de la bascule : seule une session console est un acte humain explicite (jamais une clé, MCP, une règle, l'agent). */
export type PersistenceActor = 'console' | 'apikey' | 'mcp' | 'system';

export const PERSISTENCE_NOT_ELIGIBLE_REASONS = ['no_current_version', 'negative_memory_unavailable', 'budget_not_positive'] as const;
export type PersistenceNotEligibleReason = (typeof PERSISTENCE_NOT_ELIGIBLE_REASONS)[number];

export type PersistenceActivationDecision =
  | { ok: true }
  | { ok: false; status: 403; code: 'human_confirmation_required' }
  | { ok: false; status: 409; code: 'persistence_not_eligible'; reason: PersistenceNotEligibleReason };

export function decidePersistenceActivation(input: {
  enable: boolean;
  actor: PersistenceActor;
  hasCurrentVersion: boolean;
  negativeMemoryAvailable: boolean;
  effectiveBudgetUsd: number;
}): PersistenceActivationDecision {
  // Désactiver reste permis à toute clé du scope : ne rien relancer n'est jamais coûteux.
  if (!input.enable) return { ok: true };
  if (input.actor !== 'console') return { ok: false, status: 403, code: 'human_confirmation_required' };
  if (!input.hasCurrentVersion) return { ok: false, status: 409, code: 'persistence_not_eligible', reason: 'no_current_version' };
  if (!input.negativeMemoryAvailable) return { ok: false, status: 409, code: 'persistence_not_eligible', reason: 'negative_memory_unavailable' };
  if (!(input.effectiveBudgetUsd > 0)) return { ok: false, status: 409, code: 'persistence_not_eligible', reason: 'budget_not_positive' };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Entrée et issue d'une tentative
// ---------------------------------------------------------------------------------------------------------------

/** Faits d'un échec : classe, détail (code de journal, ex. `geo_restriction`), statut HTTP s'il est connu. */
export type PersistenceFailure = {
  failureClass: FailureClass | null;
  detail?: string | null;
  httpStatus?: number | null;
};

/**
 * 451 ou géo-restriction (`network`, tout code de journal `geo_*` du classifieur : `geo_restriction`, `geo_redirect`
 * — redirection de pays —, 04 §7) : un « non » légal ou géographique.
 */
export function isGeoRestriction(failure: PersistenceFailure): boolean {
  return failure.httpStatus === 451 || (failure.failureClass === 'network' && isGeoRestrictionDetail(failure.detail));
}

const includes = (list: readonly string[], value: string | null): boolean => value !== null && list.includes(value);

export type PersistenceEntry = { eligible: true } | { eligible: false; reason: 'geo_restricted' | 'not_compilable' | 'class_not_eligible' };

/** Entrée en mode : classe de la transition 16 seulement, jamais `not_compilable` ni une géo-restriction. */
export function persistenceEntry(failure: PersistenceFailure): PersistenceEntry {
  if (failure.detail === 'not_compilable') return { eligible: false, reason: 'not_compilable' };
  if (isGeoRestriction(failure)) return { eligible: false, reason: 'geo_restricted' };
  if (!includes(BACKOFF_CLASSES, failure.failureClass)) return { eligible: false, reason: 'class_not_eligible' };
  return { eligible: true };
}

export type PersistenceEnded = 'refused' | 'ineligible' | 'exhausted';

export type PersistenceAttemptOutcome =
  /** Stratégie conforme : transition 1, retour à `sain`. */
  | { kind: 'recovered' }
  /** Toujours en erreur (21) : nouvel essai au créneau suivant (`Retry-After` et disjoncteur respectés). */
  | { kind: 'retry'; reason: string }
  | { kind: 'ended'; ended: PersistenceEnded; reason: string };

/** Arrêts sans classe d'échec : le défi en tunnel est un refus ; proxy ou tunnel manquants rendent la main à l'humain. */
const REFUSAL_STOPS = ['challenge_in_tunnel'] as const;
/**
 * Issues qui gardent le mode : les classes de la transition 16, le budget ou le délai d'enquête épuisés sans stratégie
 * conforme (`run_budget_exceeded`, la 21 ordinaire), l'indisponibilité passagère et le 429 (créneau suivant, après
 * `Retry-After`). Toute autre issue arrête le mode.
 */
const RETRY_CLASSES = [...BACKOFF_CLASSES, 'run_budget_exceeded', 'transient', 'rate_limited'] as const;

export function persistenceAttemptOutcome(run: {
  state: string;
  failureClass: FailureClass | null;
  detail?: string | null;
  httpStatus?: number | null;
}): PersistenceAttemptOutcome {
  if (run.state === 'succeeded') return { kind: 'recovered' };
  const cls = run.failureClass;
  const detail = run.detail ?? null;
  // Un « non » : refus, défi, robots.txt, 401, 403, connexion ou paiement requis, 451, géo-restriction, refus du LLM.
  if (includes(BLOCKING_CLASSES, cls) || includes(INVESTIGATION_ACTION_CLASSES, cls)) return { kind: 'ended', ended: 'refused', reason: cls! };
  if (run.httpStatus === 401 || run.httpStatus === 403) return { kind: 'ended', ended: 'refused', reason: `http_${String(run.httpStatus)}` };
  if (isGeoRestriction(run)) return { kind: 'ended', ended: 'refused', reason: 'geo_restricted' };
  if (cls === 'llm_refused') return { kind: 'ended', ended: 'refused', reason: cls };
  if (cls === null) {
    if (includes(REFUSAL_STOPS, detail)) return { kind: 'ended', ended: 'refused', reason: detail! };
    return { kind: 'ended', ended: 'ineligible', reason: detail ?? 'stopped' };
  }
  if (detail === 'not_compilable') return { kind: 'ended', ended: 'ineligible', reason: 'not_compilable' };
  if (cls === 'budget_exceeded') return { kind: 'ended', ended: 'exhausted', reason: 'persistence_exhausted' };
  if (includes(RETRY_CLASSES, cls)) return { kind: 'retry', reason: cls };
  // `llm_auth`, `llm_quota_exhausted`, `not_found` et toute autre issue hors des classes de 16.
  return { kind: 'ended', ended: 'ineligible', reason: cls };
}

// ---------------------------------------------------------------------------------------------------------------
// Plafonds et reports
// ---------------------------------------------------------------------------------------------------------------

export type PersistenceCap = 'max_days' | 'budget' | 'daily_budget';

/** Plafond atteint (`persistence_exhausted`) : durée en `erreur`, dépense depuis l'entrée en `erreur`, budget du jour. */
export function persistenceCapReached(input: {
  now: Date;
  enteredErrorAt: Date;
  spentUsd: number;
  budgetUsd: number;
  dailySpentUsd: number;
  budgetDailyUsd: number;
  maxDays: number;
}): PersistenceCap | null {
  if (input.now.getTime() - input.enteredErrorAt.getTime() >= input.maxDays * DAY_MS) return 'max_days';
  if (!(input.budgetUsd > 0) || input.spentUsd >= input.budgetUsd) return 'budget';
  if (input.dailySpentUsd >= input.budgetDailyUsd) return 'daily_budget';
  return null;
}

export type PersistenceDeferral = { reason: 'circuit_open' | 'retry_after' | 'repair_lease' | 'domain_slot'; until: Date };

/**
 * Report d'une tentative due, sans la compter : disjoncteur du domaine ouvert, pénalité `Retry-After` (429), bail de
 * réparation tenu, créneau du domaine pris. `null` : la tentative part.
 */
export function persistenceDeferral(input: {
  now: Date;
  policy: PersistencePolicy;
  circuit: 'closed' | 'open' | 'half_open' | null;
  circuitOpenUntil: Date | null;
  penaltyUntil: Date | null;
  leaseHeldByOther: boolean;
  domainBusyUntil: Date | null;
}): PersistenceDeferral | null {
  const now = input.now.getTime();
  const later = (ms: number) => new Date(Math.max(ms, now + MINUTE_MS));
  // Disjoncteur ouvert : rien avant `circuit_open_until` ; au-delà, la cadence du domaine décide de la sonde (04 §7).
  if (input.circuit === 'open' && (input.circuitOpenUntil === null || input.circuitOpenUntil.getTime() > now)) {
    return { reason: 'circuit_open', until: later(input.circuitOpenUntil?.getTime() ?? now + input.policy.busyRetryMs) };
  }
  if (input.penaltyUntil !== null && input.penaltyUntil.getTime() > now) return { reason: 'retry_after', until: later(input.penaltyUntil.getTime()) };
  if (input.leaseHeldByOther) return { reason: 'repair_lease', until: later(now + input.policy.busyRetryMs) };
  if (input.domainBusyUntil !== null && input.domainBusyUntil.getTime() > now) return { reason: 'domain_slot', until: later(input.domainBusyUntil.getTime()) };
  return null;
}
