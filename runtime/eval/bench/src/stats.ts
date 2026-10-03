// SPDX-License-Identifier: AGPL-3.0-only
// Statistiques du banc (15 §11) : IC de Wilson à 95 %, pass^k sans biais, médiane, différence appariée avec IC bootstrap à
// graine (mesure d'effet d'un bras, 19 §5). Aucune dépendance : calculs recalculables par un tiers.

const Z95 = 1.959963984540054;

export interface Interval {
  low: number;
  high: number;
  /** Taux observé ; null quand n = 0. */
  rate: number | null;
}

/** Intervalle de score de Wilson pour k succès sur n essais. */
export function wilson(k: number, n: number, z: number = Z95): Interval {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) throw new RangeError(`wilson : k et n entiers, 0 ≤ k ≤ n (k = ${k}, n = ${n})`);
  if (n === 0) return { low: 0, high: 1, rate: null };
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: k === 0 ? 0 : (centre - margin) / denominator, high: k === n ? 1 : (centre + margin) / denominator, rate: p };
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

/** pass^k : probabilité que k essais tirés sans remise parmi n réussissent tous, estimée par C(c,k)/C(n,k). */
export function passHatK(successes: number, n: number, k: number): number {
  if (n < k) throw new RangeError(`pass^${k} : il faut au moins ${k} essais (n = ${n})`);
  if (successes < 0 || successes > n) throw new RangeError('pass^k : 0 ≤ succès ≤ n');
  return binomial(successes, k) / binomial(n, k);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Générateur à graine (mulberry32) : un IC bootstrap se recalcule à l'identique. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Différence appariée moyenne (a − b) et IC bootstrap percentile à 95 %. */
export function pairedBootstrap(a: readonly number[], b: readonly number[], options: { seed?: number; iterations?: number } = {}): { mean: number; low: number; high: number; n: number } {
  if (a.length !== b.length || a.length === 0) throw new RangeError('différences appariées : deux séries de même longueur, non vides');
  const diffs = a.map((x, i) => x - (b[i] as number));
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const next = rng(options.seed ?? 1);
  const iterations = options.iterations ?? 5000;
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(next() * diffs.length)] as number;
    means.push(sum / diffs.length);
  }
  means.sort((x, y) => x - y);
  const at = (q: number): number => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))] as number;
  return { mean, low: at(0.025), high: at(0.975), n: diffs.length };
}
