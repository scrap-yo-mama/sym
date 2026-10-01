// Seuils de 04 §6 (plusieurs « à valider ») et prédicats purs des signaux de run dégradé.
import type { DegradedSignal } from './types.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const STATUS_THRESHOLDS = {
  /** K : runs propres consécutifs pour repasser de `warning` à `sain` (9). */
  cleanStreakK: 3,
  /** Plancher de D = max(7 j, 3 × période de planification). */
  quietPeriodFloorMs: 7 * DAY_MS,
  quietPeriodPeriodMultiplier: 3,
  /** `optional_fields_missing` : chute d'au moins 20 points du taux de remplissage habituel. */
  optionalFillDropPoints: 20,
  /** `volume_anomaly` : moins de 50 % de la médiane, après au moins 5 runs à même empreinte d'entrée. */
  volumeRatio: 0.5,
  volumeMinHistory: 5,
  /** `slow` : durée > 3 × médiane ET écart absolu > 30 s, sur 2 runs consécutifs. */
  slowRatio: 3,
  slowMinGapMs: 30_000,
  slowConsecutiveRuns: 2,
  /** `cost_anomaly` : coût > 3 × coût médian. */
  costRatio: 3,
  /** Backoff de `erreur` (16) : 1 h, 6 h, 24 h, puis arrêt. */
  backoffDelaysMs: [HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS],
  backoffJitterRatio: 0.2,
} as const;

/** D = max(7 j, 3 × période de planification). Sans planification : 7 j. */
export function quietPeriodMs(schedulePeriodMs: number | null | undefined): number {
  const t = STATUS_THRESHOLDS;
  return Math.max(t.quietPeriodFloorMs, t.quietPeriodPeriodMultiplier * (schedulePeriodMs ?? 0));
}

/** Taux de remplissage en pourcentage (0 à 100) ; chute d'au moins 20 points. */
export function optionalFieldsMissing(usualFillPct: number, currentFillPct: number): boolean {
  return usualFillPct - currentFillPct >= STATUS_THRESHOLDS.optionalFillDropPoints;
}

/** Médiane calculée hors runs anormaux et hors runs « marqués comme attendus » par l'appelant. */
export function volumeAnomaly(items: number, baselineMedian: number, historyRuns: number): boolean {
  const t = STATUS_THRESHOLDS;
  return historyRuns >= t.volumeMinHistory && items < t.volumeRatio * baselineMedian;
}

/** `durationsMs` : les runs les plus récents en dernier ; il faut `slowConsecutiveRuns` runs lents de suite. */
export function slowRun(durationsMs: readonly number[], medianMs: number): boolean {
  const t = STATUS_THRESHOLDS;
  const recent = durationsMs.slice(-t.slowConsecutiveRuns);
  return (
    recent.length === t.slowConsecutiveRuns &&
    recent.every((d) => d > t.slowRatio * medianMs && d - medianMs > t.slowMinGapMs)
  );
}

export function costAnomaly(costUsd: number, medianCostUsd: number): boolean {
  return costUsd > STATUS_THRESHOLDS.costRatio * medianCostUsd;
}

/** `slow` seul ne remet pas `clean_streak` à 0 (à valider). */
export function resetsCleanStreak(signals: readonly DegradedSignal[]): boolean {
  return signals.some((s) => s !== 'slow');
}

/** Délai avant la tentative `attempt` (à partir de 0), jitter ±20 % ; `null` = arrêt du backoff. */
export function backoffDelayMs(attempt: number, random: () => number): number | null {
  const t = STATUS_THRESHOLDS;
  const base = Number.isInteger(attempt) && attempt >= 0 ? t.backoffDelaysMs[attempt] : undefined;
  if (base === undefined) return null;
  return Math.round(base * (1 + t.backoffJitterRatio * (2 * random() - 1)));
}
