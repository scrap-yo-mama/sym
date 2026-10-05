// SPDX-License-Identifier: AGPL-3.0-only
// Estimation de coût avant un affinage ou un test (tâche 3.14, 19 §6, r3 R9) : calculée par le CODE, jamais par le modèle.
// `basis: history` : runs passés de l'API (coût réel, médiane et plus haut) ; sinon le coût estimé de la stratégie.
// Le plafond annoncé (`cap_usd`) est le plus bas de `max_cost_usd` de l'API et du budget d'itération ; le coût réel d'un
// run ne le dépasse jamais (le plafond par run de l'exécuteur le tient) : `assert_estimate_within_cap`.

export const CONFIRM_ABOVE_USD_DEFAULT = 0.1;

/** Plafond annoncé quand l'API n'a aucun plafond par run (D-123, `max_cost_usd` NULL) et aucun budget d'itération : le plafond d'instance par défaut (`MAX_COST_USD_PER_RUN`). */
export const NO_RUN_CAP_ESTIMATE_USD = 10;

export type Estimate = {
  readonly low_usd: number;
  readonly high_usd: number;
  readonly basis: 'history' | 'strategy' | 'none';
  readonly confidence: 'low' | 'medium' | 'high';
  /** Coût d'un rejeu du brouillon moins celui de la version en service (0 si inconnu). */
  readonly replay_cost_delta_usd: number;
  readonly cap_usd: number;
  /** `high_usd` dépasse `confirmAboveUsd` : l'appel exige une confirmation (`accept_cost`). */
  readonly needs_confirmation: boolean;
  /** `high_usd` dépasse le plafond : refus `cost_above_cap`, jamais contournable. */
  readonly above_cap: boolean;
};

export type EstimateInput = {
  /** Coûts réels (USD) des runs passés de l'API, du plus récent au plus ancien. */
  readonly history: readonly number[];
  /** `est_cost_usd` de la stratégie rejouée (null : inconnu). */
  readonly strategyEstUsd: number | null;
  /** Coût estimé de la version en service, pour le delta (null : inconnu). */
  readonly currentEstUsd?: number | null;
  /** Plafond par run de l'API ; null : aucun (D-123), le budget d'itération ou le plafond d'instance par défaut tient lieu de borne. */
  readonly maxCostUsd: number | null;
  readonly iterationBudgetUsd: number | null;
  readonly confirmAboveUsd?: number;
  /** Coût propre de l'affinage (recompilation par modèle), ajouté aux deux bornes. */
  readonly extraUsd?: number;
};

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const median = (v: readonly number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
};

export function estimateCost(input: EstimateInput): Estimate {
  const runCap = input.maxCostUsd ?? input.iterationBudgetUsd ?? NO_RUN_CAP_ESTIMATE_USD;
  const cap = round6(input.iterationBudgetUsd === null ? runCap : Math.min(runCap, input.iterationBudgetUsd));
  const extra = input.extraUsd ?? 0;
  const history = input.history.filter((c) => Number.isFinite(c) && c >= 0).slice(0, 20);
  let low: number;
  let high: number;
  let basis: Estimate['basis'];
  let confidence: Estimate['confidence'];
  if (history.length > 0) {
    basis = 'history';
    low = Math.min(...history);
    high = Math.max(...history);
    confidence = history.length >= 5 ? 'high' : history.length >= 2 ? 'medium' : 'low';
    // Une médiane au-dessus d'un plus bas observé : la borne basse reste le plus bas réel (jamais inventé).
    low = Math.min(low, median(history));
  } else if (input.strategyEstUsd !== null) {
    basis = 'strategy';
    low = input.strategyEstUsd * 0.5;
    high = input.strategyEstUsd * 1.5;
    confidence = 'low';
  } else {
    basis = 'none';
    low = 0;
    high = 0;
    confidence = 'low';
  }
  low = round6(low + extra);
  high = round6(high + extra);
  const confirmAbove = input.confirmAboveUsd ?? CONFIRM_ABOVE_USD_DEFAULT;
  const delta = input.strategyEstUsd !== null && (input.currentEstUsd ?? null) !== null ? round6(input.strategyEstUsd - (input.currentEstUsd as number)) : 0;
  return { low_usd: low, high_usd: high, basis, confidence, replay_cost_delta_usd: delta, cap_usd: cap, needs_confirmation: high > confirmAbove, above_cap: high > cap };
}
