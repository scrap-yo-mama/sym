// SPDX-License-Identifier: AGPL-3.0-only
// Budget de connexions PostgreSQL (14 § 4) : total = Σ web (pool + 1 LISTEN) + Σ worker (pool + pg-boss + 1 LISTEN) + 3,
// à comparer à max_connections : ≤ 0,8 ok, au-delà avertissement, au-delà de 1,0 refus (seuils « à valider », 14 § 14).

/**
 * Connexions de pg-boss par worker. Le CDC donne l'exemple du profil S sur Heroku Postgres Essential-0 : 18 connexions
 * avec un pool de 5 (6 pour le web, 9 pour le worker, 3 en réserve), soit 3 connexions pour pg-boss.
 */
export const PG_BOSS_CONNECTIONS = 3;
/** Réserve : migrations, `runtime` en ligne de commande, supervision. */
export const RESERVED_CONNECTIONS = 3;
export const BUDGET_WARN_RATIO = 0.8;
export const BUDGET_ERROR_RATIO = 1.0;

export type ConnectionBudgetInput = {
  poolMax: number;
  webInstances: number;
  workerInstances: number;
  maxConnections: number;
};

export type ConnectionBudget = {
  total: number;
  web: number;
  workers: number;
  reserved: number;
  maxConnections: number;
  ratio: number;
  level: 'ok' | 'warn' | 'error';
};

export function connectionBudget(input: ConnectionBudgetInput): ConnectionBudget {
  const web = input.webInstances * (input.poolMax + 1);
  const workers = input.workerInstances * (input.poolMax + PG_BOSS_CONNECTIONS + 1);
  const total = web + workers + RESERVED_CONNECTIONS;
  const ratio = total / input.maxConnections;
  const level = ratio > BUDGET_ERROR_RATIO ? 'error' : ratio > BUDGET_WARN_RATIO ? 'warn' : 'ok';
  return { total, web, workers, reserved: RESERVED_CONNECTIONS, maxConnections: input.maxConnections, ratio, level };
}
