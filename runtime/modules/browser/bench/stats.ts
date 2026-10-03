// SPDX-License-Identifier: AGPL-3.0-only
// Statistiques du banc de capacité (tâche 0.6) : médiane et p95 au rang le plus proche (nearest-rank).

export type Summary = { n: number; min: number; median: number; p95: number; max: number };

function sorted(values: readonly number[]): number[] {
  if (values.length === 0) throw new Error('série vide');
  return [...values].sort((a, b) => a - b);
}

export function median(values: readonly number[]): number {
  const s = sorted(values);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Percentile `p` (0 à 100) au rang le plus proche : la valeur de rang ceil(p/100 × n). */
export function percentile(values: readonly number[], p: number): number {
  const s = sorted(values);
  const rank = Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length)));
  return s[rank - 1] as number;
}

export function summarize(values: readonly number[]): Summary {
  const s = sorted(values);
  return { n: s.length, min: s[0] as number, median: median(s), p95: percentile(s, 95), max: s[s.length - 1] as number };
}
