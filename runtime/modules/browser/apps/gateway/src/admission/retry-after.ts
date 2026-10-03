// SPDX-License-Identifier: AGPL-3.0-only
// `Retry-After` (cdc/sym-browser 04b § 7, 04 § 6) : délai médian récent d'attente en file, borné entre 1 et 60 s, pour les
// refus de file et de sessions simultanées ; secondes jusqu'au mois suivant pour un solde mensuel épuisé.

const WINDOW = 50;
const MIN_SECONDS = 1;
const MAX_SECONDS = 60;

/** Attentes en file des dernières sessions servies (fenêtre glissante de 50). */
export class QueueWaits {
  readonly #waits: number[] = [];

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.#waits.push(ms);
    if (this.#waits.length > WINDOW) this.#waits.splice(0, this.#waits.length - WINDOW);
  }

  retryAfterSeconds(): number {
    if (this.#waits.length === 0) return MIN_SECONDS;
    const sorted = [...this.#waits].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.ceil(median / 1000)));
  }
}

/** Secondes jusqu'au 1er du mois suivant à 00:00 UTC (remise à zéro des minutes et des octets), au moins 1. */
export function secondsUntilNextMonth(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
