// SPDX-License-Identifier: AGPL-3.0-only
// Constantes de capacité d'un nœud (cdc/sym-browser 04b §3), fixées par la tâche 0.6 : rapport docs/mesures-capacite.md,
// résultats bruts datés dans bench/results/. Le test tests/bench.unit.test.ts relie chaque constante aux mesures versionnées
// (marge d'au moins 2 sur le p95 mesuré) : changer une valeur exige de relancer le banc (bench/run.sh) et de réviser le rapport.

const MIB = 1024 * 1024;

export const CAPACITY = {
  /** Réservé au nœud hors Chromium : Node + playwright-core + serveur HTTP mesurés à 123 Mio (RSS) ; le reste couvre tini, le client PostgreSQL, les tampons et le noyau. */
  BASE_BYTES: 512 * MIB,
  /** Budget d'un slot = une session `dedicated` (un Chromium) : 2,3 fois le p95 mesuré sur une page applicative lourde (328 Mio de mémoire anonyme). */
  SLOT_BYTES: 768 * MIB,
  /** Un slot se découpe en 4 unités entières : la réservation SQL (`slots_free - poids`) reste en entiers. */
  SLOT_UNITS: 4,
  /** Poids d'une session `dedicated` : un slot entier. */
  DEDICATED_UNITS: 4,
  /** Poids d'une session `shared` : 3/4 de slot (un contexte coûte 0,57 à 0,88 d'un Chromium dédié selon la page ; 576 Mio = 2,0 fois le p95 de 288 Mio d'un contexte lourd). */
  SHARED_UNITS: 3,
  /** Contextes `shared` simultanés par Chromium chaud : coût linéaire et latence stable mesurés jusqu'à 6 (page lourde) et 8 (page typique). */
  CONTEXTS_PER_BROWSER: 6,
} as const;

export type SessionType = 'shared' | 'dedicated';

/** Slots d'un nœud : `max(1, floor((limite − base) / budget par slot))` (04b §3). */
export function computeSlots(limitBytes: number): number {
  return Math.max(1, Math.floor((limitBytes - CAPACITY.BASE_BYTES) / CAPACITY.SLOT_BYTES));
}

/** Unités de slot d'un nœud, valeur publiée à chaque battement (`slotsTotal`). */
export function computeSlotUnits(limitBytes: number): number {
  return computeSlots(limitBytes) * CAPACITY.SLOT_UNITS;
}

/** Unités réservées par une session. */
export function sessionUnits(type: SessionType): number {
  return type === 'dedicated' ? CAPACITY.DEDICATED_UNITS : CAPACITY.SHARED_UNITS;
}
