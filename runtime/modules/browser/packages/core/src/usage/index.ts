// SPDX-License-Identifier: AGPL-3.0-only
// Comptage (cdc/sym-browser 04d § 4.1, tâche 2.6, BINV5) : forme d'une clôture d'usage mesurée par le nœud et règle de
// facturation. Le nœud est la seule source des mesures ; la base garde `billed_seconds = ceil(browser_ms / 1000)` (0.2).

/**
 * Clôture d'une session telle que le nœud l'a mesurée : durée sur son horloge monotone, de `running` à la destruction ;
 * octets entrants et sortants de son egress, toutes époques cumulées. Aussi la forme d'un instantané en cours de session.
 * `startedAt` : horloge murale du nœud au passage `running` (ms depuis l'époque Unix) ; fin = `startedAt + browserMs`.
 */
export type UsageClosure = {
  sessionId: string;
  nodeId: string;
  startedAt: number;
  browserMs: number;
  bytesIn: number;
  bytesOut: number;
};

/** `node` : mesuré et clôturé par le nœud ; `reconstructed` : clos par la passerelle sur la dernière mesure reçue. */
export type UsageSource = 'node' | 'reconstructed';

/**
 * Écriture d'une clôture seule (rejeu de usage.wal, état final refusé) : `inserted` ; `replaced` (valeur reconstruite
 * remplacée par la mesure) ; `unchanged` (déjà mesurée : une mesure n'est jamais écrasée) ; `not_found` (session inconnue).
 */
export type RecordUsageOutcome = 'inserted' | 'replaced' | 'unchanged' | 'not_found';

/** Secondes facturées d'une session : `ceil(browserMs / 1000)` (04d § 4.1). */
export function billedSeconds(browserMs: number): number {
  if (!Number.isSafeInteger(browserMs) || browserMs < 0) throw new RangeError(`browserMs : entier positif ou nul attendu (reçu ${browserMs})`);
  return Math.ceil(browserMs / 1000);
}
