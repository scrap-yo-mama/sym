// Cadence par domaine distribuée (tâche 1.9, 04 § 7, 17, O6 § 06) : magasin PostgreSQL de `domain_pacing_state`.
//
// - Clé = domaine seul : ni owner_id, ni project_id, ni proxy, ni IP (assert_pacing_key_is_domain).
// - La réservation d'un créneau est UNE instruction SQL : verrou de ligne (FOR UPDATE) dans la requête, aucun verrou
//   applicatif, aucune fonction de session (compatible pooler en mode transaction). Horloge de la base
//   (clock_timestamp()) sauf horloge injectée pour les tests.
// - La création de la ligne d'un domaine neuf (INSERT ... ON CONFLICT DO NOTHING) précède, une fois, la réservation.
import {
  DEFAULT_PACING_POLICY,
  type OutcomeResult,
  type PacingOutcome,
  type PacingPolicy,
  type PacingStore,
  type ReserveRequest,
  type Reservation,
  type CircuitState,
  type RefusalReason,
} from '@runtime/core';
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

/**
 * Réservation atomique. $1 domaine, $2 délai effectif (ms), $3 gigue (ms), $4 attente max (ms), $5 réessai,
 * $6 horloge injectée (null = base), $7 part de réessais, $8 fenêtre (ms), $9 délai d'une requête d'essai perdue (ms),
 * $10 plancher de réessais.
 * Ordre des refus : disjoncteur, budget de retries, attente maximale. Un refus n'écrit rien.
 * Le créneau suivant est `slot + délai + gigue` : l'écart début à début est au moins `délai`.
 */
const RESERVE_SQL = `
WITH cur AS (
  SELECT d.domain, d.next_slot_at, d.adaptive_delay_ms, d.penalty_until, d.circuit_state, d.circuit_open_until,
         d.probe_started_at, d.window_started_at, d.window_requests, d.window_retries,
         coalesce($6::timestamptz, clock_timestamp()) AS t
  FROM domain_pacing_state d
  WHERE d.domain = $1
  FOR UPDATE
), calc AS (
  SELECT cur.*,
    CASE
      WHEN circuit_state = 'closed' THEN 'closed'
      WHEN circuit_state = 'open' AND t >= circuit_open_until THEN 'probe'
      WHEN circuit_state = 'half_open'
           AND (probe_started_at IS NULL OR t >= probe_started_at + make_interval(secs => $9::int / 1000.0)) THEN 'probe'
      ELSE 'blocked'
    END AS circ,
    (window_started_at IS NULL OR t >= window_started_at + make_interval(secs => $8::int / 1000.0)) AS w_reset,
    greatest(next_slot_at, coalesce(penalty_until, '-infinity'), t) AS slot,
    greatest($2::int, adaptive_delay_ms) AS eff
  FROM cur
), decide AS (
  SELECT calc.*,
    CASE WHEN w_reset THEN 0 ELSE window_requests END AS req,
    CASE WHEN w_reset THEN 0 ELSE window_retries END AS ret
  FROM calc
), verdict AS (
  SELECT decide.*,
    CASE
      WHEN circ = 'blocked' THEN 'circuit_open'
      WHEN $5::boolean AND (req = 0 OR ret + 1 > greatest($10::int, floor($7::float8 * req))) THEN 'retry_budget'
      WHEN slot > t + make_interval(secs => $4::int / 1000.0) THEN 'max_wait'
    END AS refused
  FROM decide
), upd AS (
  UPDATE domain_pacing_state d SET
    next_slot_at = v.slot + make_interval(secs => (v.eff + $3::int) / 1000.0),
    min_delay_ms = v.eff,
    circuit_state = CASE WHEN v.circ = 'probe' THEN 'half_open' ELSE d.circuit_state END,
    probe_started_at = CASE WHEN v.circ = 'probe' THEN v.t ELSE d.probe_started_at END,
    window_started_at = CASE WHEN v.w_reset THEN v.t ELSE d.window_started_at END,
    window_requests = CASE WHEN $5::boolean THEN v.req ELSE v.req + 1 END,
    window_retries = CASE WHEN $5::boolean THEN v.ret + 1 ELSE v.ret END,
    updated_at = v.t
  FROM verdict v
  WHERE d.domain = v.domain AND v.refused IS NULL
  RETURNING d.domain
)
SELECT v.refused, v.slot, v.t AS db_now, (v.circ = 'probe') AS probe,
  CASE v.refused
    WHEN 'circuit_open' THEN CASE v.circuit_state
      WHEN 'open' THEN v.circuit_open_until
      ELSE v.probe_started_at + make_interval(secs => $9::int / 1000.0) END
    WHEN 'retry_budget' THEN v.window_started_at + make_interval(secs => $8::int / 1000.0)
    WHEN 'max_wait' THEN v.slot - make_interval(secs => $4::int / 1000.0)
  END AS retry_at
FROM verdict v
`;

/**
 * Résultat d'une requête. $1 domaine, $2 'ok' | 'rate_limited' | 'server_error', $3 Retry-After (ms, null),
 * $4 horloge injectée, $5 seuil du disjoncteur, $6 plafond adaptatif (ms), $7 délai de base du disjoncteur (ms),
 * $8 délai maximal du disjoncteur (ms), $9 succès consécutifs par palier de décroissance, $10 durée calme (ms).
 * - refus : pénalité = max(Retry-After, délai courant) pour tous les workers ; ralentissement adaptatif doublé jusqu'au
 *   plafond ; disjoncteur ouvert au N-ième refus consécutif, rouvert si l'essai du demi-ouvert échoue ;
 * - succès : les refus consécutifs retombent à zéro, le demi-ouvert se referme ; le ralentissement décroît par paliers (÷ 2 après N succès ou une durée calme, jamais sous le délai effectif).
 */
const RECORD_SQL = `
WITH cur AS (
  SELECT d.*, coalesce($4::timestamptz, clock_timestamp()) AS t
  FROM domain_pacing_state d
  WHERE d.domain = $1
  FOR UPDATE
), calc AS (
  SELECT cur.*,
    ($2 <> 'ok') AS bad,
    CASE WHEN $2 = 'ok' THEN 0 ELSE consecutive_failures + 1 END AS failures,
    (
      $2 <> 'ok' AND (
        circuit_state = 'half_open'
        OR (circuit_state = 'closed' AND consecutive_failures + 1 >= $5::int)
      )
    ) AS trip,
    greatest(adaptive_delay_ms, least($6::int, greatest(min_delay_ms, adaptive_delay_ms) * 2)) AS doubled,
    (
      $2 = 'ok' AND adaptive_delay_ms > 0 AND (
        calm_successes + 1 >= $9::int
        OR (adaptive_changed_at IS NOT NULL AND t >= adaptive_changed_at + make_interval(secs => $10::int / 1000.0))
      )
    ) AS decay
  FROM cur
), upd AS (
  UPDATE domain_pacing_state d SET
    consecutive_failures = c.failures,
    adaptive_delay_ms = CASE
      WHEN c.bad THEN c.doubled
      WHEN c.decay THEN CASE WHEN d.adaptive_delay_ms / 2 <= d.min_delay_ms THEN 0 ELSE d.adaptive_delay_ms / 2 END
      ELSE d.adaptive_delay_ms END,
    calm_successes = CASE WHEN c.bad OR c.decay THEN 0 WHEN $2 = 'ok' THEN d.calm_successes + 1 ELSE d.calm_successes END,
    adaptive_changed_at = CASE WHEN c.bad OR c.decay THEN c.t ELSE d.adaptive_changed_at END,
    penalty_until = CASE WHEN c.bad
      THEN greatest(coalesce(d.penalty_until, '-infinity'),
                    c.t + make_interval(secs => greatest(coalesce($3::int, 0), d.min_delay_ms) / 1000.0))
      ELSE d.penalty_until END,
    circuit_state = CASE
      WHEN c.trip THEN 'open'
      WHEN $2 = 'ok' AND d.circuit_state = 'half_open' THEN 'closed'
      ELSE d.circuit_state END,
    circuit_opened_at = CASE
      WHEN c.trip THEN c.t
      WHEN $2 = 'ok' AND d.circuit_state = 'half_open' THEN NULL
      ELSE d.circuit_opened_at END,
    circuit_open_until = CASE
      WHEN c.trip THEN c.t + make_interval(secs => greatest(
        least($8::float8, $7::float8 * power(2, least(d.circuit_trips, 20))), coalesce($3::int, 0)) / 1000.0)
      WHEN $2 = 'ok' AND d.circuit_state = 'half_open' THEN NULL
      ELSE d.circuit_open_until END,
    circuit_trips = CASE
      WHEN c.trip THEN d.circuit_trips + 1
      WHEN $2 = 'ok' AND d.circuit_state = 'half_open' THEN 0
      ELSE d.circuit_trips END,
    probe_started_at = CASE WHEN c.trip OR ($2 = 'ok' AND d.circuit_state = 'half_open') THEN NULL ELSE d.probe_started_at END,
    updated_at = c.t
  FROM calc c
  WHERE d.domain = c.domain
  RETURNING d.circuit_state, d.consecutive_failures, d.penalty_until, d.adaptive_delay_ms, c.trip
)
SELECT * FROM upd
`;

type ReserveRow = { refused: RefusalReason | null; slot: Date; db_now: Date; probe: boolean; retry_at: Date | null };
type RecordRow = {
  circuit_state: CircuitState;
  consecutive_failures: number;
  penalty_until: Date | null;
  adaptive_delay_ms: number;
  trip: boolean;
};

export type PgPacingStoreOptions = {
  policy?: Partial<PacingPolicy>;
  /** Horloge injectée (tests) ; absente, c'est l'horloge de la base qui décide. */
  now?: () => Date;
};

export class PgPacingStore implements PacingStore {
  readonly #db: Queryable;
  readonly #policy: PacingPolicy;
  readonly #now: (() => Date) | undefined;

  constructor(db: Queryable, options: PgPacingStoreOptions = {}) {
    this.#db = db;
    this.#policy = { ...DEFAULT_PACING_POLICY, ...options.policy };
    this.#now = options.now;
  }

  async #ensureRow(domain: string): Promise<void> {
    await this.#db.query('INSERT INTO domain_pacing_state (domain, next_slot_at) VALUES ($1, $2) ON CONFLICT (domain) DO NOTHING', [
      domain,
      new Date(0),
    ]);
  }

  async reserve(request: ReserveRequest): Promise<Reservation> {
    const p = this.#policy;
    const params = [
      request.domain,
      request.minDelayMs,
      request.jitterMs,
      request.maxWaitMs,
      request.isRetry,
      this.#now?.() ?? null,
      p.retryBudgetRatio,
      p.retryWindowMs,
      p.probeTimeoutMs,
      p.retryBudgetFloor,
    ];
    await this.#ensureRow(request.domain);
    const { rows } = await this.#db.query<ReserveRow>(RESERVE_SQL, params);
    const row = rows[0];
    if (row === undefined) throw new Error(`cadence : ligne du domaine ${request.domain} introuvable`);
    if (row.refused !== null) {
      return { granted: false, reason: row.refused, dbNow: row.db_now, retryAt: row.retry_at ?? row.db_now };
    }
    return { granted: true, slot: row.slot, dbNow: row.db_now, probe: row.probe };
  }

  async record(domain: string, outcome: PacingOutcome): Promise<OutcomeResult> {
    const p = this.#policy;
    await this.#ensureRow(domain);
    const { rows } = await this.#db.query<RecordRow>(RECORD_SQL, [
      domain,
      outcome.kind,
      outcome.retryAfterMs ?? null,
      this.#now?.() ?? null,
      p.circuitThreshold,
      p.adaptiveCapMs,
      p.circuitCooldownMs,
      p.circuitMaxCooldownMs,
      p.adaptiveDecaySuccesses,
      p.adaptiveCalmMs,
    ]);
    const row = rows[0];
    if (row === undefined) throw new Error(`cadence : ligne du domaine ${domain} introuvable`);
    return {
      circuit: row.circuit_state,
      opened: row.trip,
      consecutiveFailures: row.consecutive_failures,
      penaltyUntil: row.penalty_until,
      adaptiveDelayMs: row.adaptive_delay_ms,
    };
  }

  /** Réarmement manuel (04 § 7 : décision de l'utilisateur) : disjoncteur fermé, ralentissement et pénalité effacés. */
  async reset(domain: string): Promise<void> {
    await this.#db.query(
      `UPDATE domain_pacing_state SET circuit_state = 'closed', circuit_opened_at = NULL, circuit_open_until = NULL,
         circuit_trips = 0, consecutive_failures = 0, probe_started_at = NULL, adaptive_delay_ms = 0, calm_successes = 0,
         penalty_until = NULL, updated_at = coalesce($2::timestamptz, clock_timestamp()) WHERE domain = $1`,
      [domain, this.#now?.() ?? null],
    );
  }
}
