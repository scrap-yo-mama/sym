// SPDX-License-Identifier: AGPL-3.0-only

/** Budgets d'instance (08b § 3, PA-02) : plafond de dépense par utilisateur et par jour, plafond du coût d'un run. */
export type CostCaps = {
  /** `USER_BUDGET_DAILY_USD` : dépense du jour (LLM + proxy, tous les runs) au-delà de laquelle un utilisateur ne lance plus rien. */
  userBudgetDailyUsd: number;
  /** `MAX_COST_USD_PER_RUN` : plafond du `max_cost_usd` qu'un membre peut fixer sur une API. */
  maxCostUsdPerRun: number;
};

export const COST_CAPS_DEFAULTS: CostCaps = { userBudgetDailyUsd: 50, maxCostUsdPerRun: 10 };

export class CostCapsConfigError extends Error {
  override name = 'CostCapsConfigError';
}

function amount(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new CostCapsConfigError(`${name} invalide : montant en dollars supérieur à 0 attendu (jamais illimité).`);
  return value;
}

/** Lit les deux plafonds ; une valeur absente prend le défaut, une valeur nulle, négative ou illisible refuse le démarrage. */
export function costCapsFromEnv(env: Readonly<Record<string, string | undefined>>): CostCaps {
  return {
    userBudgetDailyUsd: amount(env, 'USER_BUDGET_DAILY_USD', COST_CAPS_DEFAULTS.userBudgetDailyUsd),
    maxCostUsdPerRun: amount(env, 'MAX_COST_USD_PER_RUN', COST_CAPS_DEFAULTS.maxCostUsdPerRun),
  };
}
