// Orchestration côté worker : réserver un créneau, attendre son heure (horloge injectée), rapporter le résultat.
// La cadence ne connaît ni proxy, ni IP, ni utilisateur, ni API : elle ne prend que la cible (clé = domaine).
// Un 429 ralentit et peut ouvrir le disjoncteur ; il ne change JAMAIS de réseau (X4, INV6) : ce module n'a d'ailleurs
// aucun accès à l'échelle réseau.
import { registrableDomain } from './domain.js';
import {
  DEFAULT_PACING_POLICY,
  effectiveMinDelayMs,
  jitterMs,
  parseRetryAfterMs,
  type PacingOutcomeKind,
  type PacingPolicy,
} from './policy.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

/** Requête de réservation transmise au magasin : le domaine seul identifie la cadence. */
export type ReserveRequest = {
  readonly domain: string;
  /** Délai effectif (API, `Crawl-delay`) de cette requête. */
  readonly minDelayMs: number;
  readonly jitterMs: number;
  readonly maxWaitMs: number;
  /** Vrai pour un réessai : il consomme le budget de retries du domaine. */
  readonly isRetry: boolean;
};

export type RefusalReason = 'circuit_open' | 'retry_budget' | 'max_wait';

export type Reservation =
  | {
      readonly granted: true;
      readonly slot: Date;
      /** Heure de la base au moment de la réservation : `slot - dbNow` est l'attente, sans écart d'horloge entre workers. */
      readonly dbNow: Date;
      /** Vrai si cette requête est l'essai du disjoncteur demi-ouvert. */
      readonly probe: boolean;
    }
  | {
      readonly granted: false;
      readonly reason: RefusalReason;
      readonly dbNow: Date;
      /** Date avant laquelle réessayer est inutile (à passer en `startAfter` du job différé). */
      readonly retryAt: Date;
    };

export type PacingOutcome = { readonly kind: PacingOutcomeKind; readonly retryAfterMs?: number };

export type OutcomeResult = {
  readonly circuit: CircuitState;
  /** Vrai si cet appel vient d'ouvrir (ou de rouvrir) le disjoncteur. */
  readonly opened: boolean;
  readonly consecutiveFailures: number;
  readonly penaltyUntil: Date | null;
  readonly adaptiveDelayMs: number;
};

export interface PacingStore {
  reserve(request: ReserveRequest): Promise<Reservation>;
  record(domain: string, outcome: PacingOutcome): Promise<OutcomeResult>;
}

export type PacingClock = {
  now(): Date;
  /** Attend `ms` millisecondes ; horloge injectée pour que les tests n'attendent pas. */
  sleep(ms: number): Promise<void>;
};

export const systemClock: PacingClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type AcquireOptions = {
  /** `min_delay_ms` de l'API ; défaut : celui de la politique. */
  readonly minDelayMs?: number;
  /** `Crawl-delay` de robots.txt en ms (fourni par le module d'accès, 1.11). */
  readonly crawlDelayMs?: number | null;
  readonly maxWaitMs?: number;
  readonly isRetry?: boolean;
};

export type Grant = { readonly granted: true; readonly domain: string; readonly waitedMs: number; readonly probe: boolean };
export type Refusal = { readonly granted: false; readonly domain: string; readonly reason: RefusalReason; readonly retryAt: Date };

export class DomainPacer {
  readonly #store: PacingStore;
  readonly #clock: PacingClock;
  readonly #random: () => number;
  readonly policy: PacingPolicy;

  constructor(store: PacingStore, options: { policy?: Partial<PacingPolicy>; clock?: PacingClock; random?: () => number } = {}) {
    this.#store = store;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.policy = { ...DEFAULT_PACING_POLICY, ...options.policy };
  }

  /**
   * Réserve un créneau pour `target` (URL ou hôte) puis attend son heure. Refus (`circuit_open`, `retry_budget`,
   * `max_wait`) : rien n'est consommé, l'appelant diffère le job jusqu'à `retryAt` sans garder de slot Chromium.
   */
  async acquire(target: string, options: AcquireOptions = {}): Promise<Grant | Refusal> {
    const domain = registrableDomain(target);
    const minDelayMs = effectiveMinDelayMs(options.minDelayMs ?? this.policy.minDelayMs, options.crawlDelayMs);
    const reservation = await this.#store.reserve({
      domain,
      minDelayMs,
      jitterMs: jitterMs(minDelayMs, this.policy.jitterRatio, this.#random),
      maxWaitMs: options.maxWaitMs ?? this.policy.maxWaitMs,
      isRetry: options.isRetry ?? false,
    });
    if (!reservation.granted) return { granted: false, domain, reason: reservation.reason, retryAt: reservation.retryAt };
    const waitedMs = Math.max(0, reservation.slot.getTime() - reservation.dbNow.getTime());
    if (waitedMs > 0) await this.#clock.sleep(waitedMs);
    return { granted: true, domain, waitedMs, probe: reservation.probe };
  }

  /** Rapporte le résultat d'une requête : un 429 (ou un 5xx) ralentit le domaine pour tous les workers. */
  report(target: string, outcome: { kind: PacingOutcomeKind; retryAfter?: string | null }): Promise<OutcomeResult> {
    const retryAfterMs = parseRetryAfterMs(outcome.retryAfter, this.#clock.now(), this.policy.maxRetryAfterMs);
    return this.#store.record(registrableDomain(target), retryAfterMs === undefined ? { kind: outcome.kind } : { kind: outcome.kind, retryAfterMs });
  }
}
