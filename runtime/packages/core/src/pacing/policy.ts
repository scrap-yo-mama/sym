// SPDX-License-Identifier: AGPL-3.0-only
// Règles pures de la cadence (04 § 7, 17 § cadence, O6 § 06). Aucune I/O.

export type PacingPolicy = {
  /** Délai minimal entre deux requêtes vers un domaine (défaut CDC, 04 § 8.1 : 1500 ms, « à valider »). */
  readonly minDelayMs: number;
  /** Attente maximale d'un créneau ; au-delà, la réservation est refusée et le job différé (défaut du schéma : 60 s). */
  readonly maxWaitMs: number;
  /** Gigue ajoutée au délai, de 0 à `jitterRatio` × délai effectif : elle allonge, ne raccourcit jamais. */
  readonly jitterRatio: number;
  /** Refus consécutifs (429, 5xx) qui ouvrent le disjoncteur (« N à valider », 04 § 7). */
  readonly circuitThreshold: number;
  /** Délai avant le demi-ouvert ; double à chaque réouverture sans succès, jusqu'à `circuitMaxCooldownMs`. */
  readonly circuitCooldownMs: number;
  readonly circuitMaxCooldownMs: number;
  /** Durée au-delà de laquelle une requête d'essai sans verdict est considérée perdue (worker tué). */
  readonly probeTimeoutMs: number;
  /** Plafond du ralentissement adaptatif (le délai double à chaque refus, à sens unique). */
  readonly adaptiveCapMs: number;
  /** Décroissance : après N succès consécutifs, ou après `adaptiveCalmMs` sans refus, le ralentissement est divisé par 2
   * (ramené à 0 quand il passe sous le délai effectif : jamais sous `min_delay_ms` ni `Crawl-delay`). */
  readonly adaptiveDecaySuccesses: number;
  readonly adaptiveCalmMs: number;
  /** Part des réessais dans les requêtes du domaine sur la fenêtre (04 § 7 : 10 %). */
  readonly retryBudgetRatio: number;
  /** Réessais toujours permis sur une fenêtre ayant au moins une requête, même si 10 % arrondit à zéro. */
  readonly retryBudgetFloor: number;
  readonly retryWindowMs: number;
  /** Plafond d'un `Retry-After` obéi (un site ne peut pas geler un domaine pour des jours). */
  readonly maxRetryAfterMs: number;
};

export const DEFAULT_PACING_POLICY: PacingPolicy = Object.freeze({
  minDelayMs: 1500,
  maxWaitMs: 60_000,
  jitterRatio: 0.2,
  circuitThreshold: 5,
  circuitCooldownMs: 60_000,
  circuitMaxCooldownMs: 3_600_000,
  probeTimeoutMs: 60_000,
  adaptiveCapMs: 30_000,
  adaptiveDecaySuccesses: 10,
  adaptiveCalmMs: 900_000,
  retryBudgetRatio: 0.1,
  retryBudgetFloor: 1,
  retryWindowMs: 3_600_000,
  maxRetryAfterMs: 3_600_000,
});

/**
 * Délai effectif : le plus grand du réglage de l'API et du `Crawl-delay` de robots.txt (plancher non normatif mais
 * respecté, 17). Le module d'accès (1.11) fournit `crawlDelayMs`.
 */
export function effectiveMinDelayMs(apiMinDelayMs: number, crawlDelayMs?: number | null): number {
  const values = [apiMinDelayMs, crawlDelayMs ?? 0];
  for (const v of values) if (!Number.isFinite(v) || v < 0) throw new RangeError(`cadence : délai invalide (${String(v)})`);
  return Math.ceil(Math.max(...values));
}

/** Gigue entière en ms, de 0 à ratio × délai. `random` doit renvoyer une valeur dans [0, 1). */
export function jitterMs(effectiveDelayMs: number, ratio: number, random: () => number): number {
  if (ratio <= 0) return 0;
  return Math.floor(Math.min(Math.max(random(), 0), 0.999999) * ratio * effectiveDelayMs);
}

/**
 * `Retry-After` (RFC 9110 § 10.2.3) : secondes entières ou date HTTP. Renvoie des ms, plafonnées par `maxMs`,
 * ou `undefined` si la valeur est absente ou illisible (elle est alors ignorée).
 */
export function parseRetryAfterMs(value: string | null | undefined, now: Date, maxMs: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (/^\d{1,9}$/.test(v)) return Math.min(Number(v) * 1000, maxMs);
  if (v === '') return undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now.getTime();
  return Math.min(Math.max(delta, 0), maxMs);
}

/** `refused` (tâche 1.7) : refus d'accès (403, défi, protection) ; compte pour le disjoncteur comme un 429 (04 §7). */
export type PacingOutcomeKind = 'ok' | 'rate_limited' | 'server_error' | 'refused';

/** Verdict de cadence d'un code HTTP : 429 → `rate_limited`, 5xx → `server_error`, le reste n'est pas un refus. */
export function outcomeKindOfStatus(status: number): PacingOutcomeKind {
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'server_error';
  return 'ok';
}

/**
 * Verdict de cadence d'une réponse CLASSÉE (tâche 1.7) : un refus d'accès (`forbidden`, `blocked_by_protection`, y compris
 * un défi servi en 200) ouvre le disjoncteur comme un 429 (04 §7 : « ouvert après N refus ou 429 consécutifs »). Sans
 * classe connue, un 403 est un refus. Un 401 (connexion requise) ou un 404 n'est pas un refus de cadence.
 * Le disjoncteur suspend les runs du domaine ; il ne change jamais de réseau.
 */
export function outcomeKindOfResponse(status: number, failureClass?: string | null): PacingOutcomeKind {
  if (failureClass === 'blocked_by_protection' || failureClass === 'forbidden') return 'refused';
  if (failureClass === undefined && status === 403) return 'refused';
  return outcomeKindOfStatus(status);
}
