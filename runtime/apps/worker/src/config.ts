// SPDX-License-Identifier: AGPL-3.0-only
// Configuration de `worker` (14 § 2-4) : lue une fois au démarrage ; MASTER_KEY retirée de l'environnement.
import {
  loadKeyring,
  loadObservabilityConfig,
  scrubOtelEnvironment,
  subjectPhoneRegion,
  type Keyring,
  type ObservabilityConfig,
} from '@runtime/core';
import { RUN_DEFAULTS, retentionPolicyFromEnv, type RetentionPolicy } from '@runtime/db';
import { resolveBrowserConcurrency } from './browser/cgroup.js';

export class WorkerConfigError extends Error {
  override name = 'WorkerConfigError';
}

export type WorkerConfig = {
  databaseUrl: string;
  /** DATABASE_URL_DIRECT : connexion de session (pg-boss, verrou des secrets), vérifiée par resolveConnections au démarrage. */
  databaseUrlDirect: string | undefined;
  keyring: Keyring;
  version: string;
  /** Jobs en parallèle (≤ DB_POOL_MAX, 14 § 4). */
  concurrency: number;
  dbPoolMax: number;
  shutdownTimeoutSeconds: number;
  runBudgetSeconds: number;
  runHeartbeatSeconds: number;
  runStaleSeconds: number;
  sweepIntervalSeconds: number;
  workerHeartbeatSeconds: number;
  queuePollingSeconds: number;
  /** Journal, OTel (coupé par défaut) : 14 § 2. */
  observability: ObservabilityConfig;
  /** Runs navigateur simultanés (`BROWSER_CONCURRENCY`, sinon déduit du cgroup, 14 §11). */
  browserConcurrency: number;
  browserConcurrencySource: 'env' | 'cgroup' | 'host';
  /** `DISABLE_BROWSER` : aucun Chromium, E2 et E3 refusés (14 §2). */
  disableBrowser: boolean;
  /** Rétention (14 § 9) : durées lues une fois au démarrage (`RETENTION_*`, `RUN_LOG_RETENTION_DAYS`…). */
  retention: RetentionPolicy;
  /** Période de la passe de rétention planifiée (marquage horaire, purge quotidienne ; défaut 300 s). */
  retentionTickSeconds: number;
};

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0.1): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new WorkerConfigError(`${name} invalide : nombre ≥ ${min} attendu.`);
  return value;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new WorkerConfigError('DATABASE_URL manquante.');
  const dbPoolMax = positive(env, 'DB_POOL_MAX', 5, 1);
  const concurrency = positive(env, 'WORKER_CONCURRENCY', 5, 1);
  if (concurrency > dbPoolMax) throw new WorkerConfigError('WORKER_CONCURRENCY doit rester ≤ DB_POOL_MAX (14 § 4).');
  const runHeartbeatSeconds = positive(env, 'RUN_HEARTBEAT_SECONDS', RUN_DEFAULTS.heartbeatSeconds);
  const runStaleSeconds = positive(env, 'RUN_STALE_SECONDS', RUN_DEFAULTS.staleSeconds);
  if (runStaleSeconds < 2 * runHeartbeatSeconds) {
    throw new WorkerConfigError('RUN_STALE_SECONDS doit valoir au moins 2 × RUN_HEARTBEAT_SECONDS.');
  }
  const observability = loadObservabilityConfig(env);
  scrubOtelEnvironment(env);
  const browser = resolveBrowserConcurrency(env);
  const disable = env['DISABLE_BROWSER'] ?? 'false';
  if (!['true', 'false', '1', '0', ''].includes(disable)) throw new WorkerConfigError('DISABLE_BROWSER invalide : true ou false attendu.');
  let retention: RetentionPolicy;
  try {
    retention = retentionPolicyFromEnv(env);
    subjectPhoneRegion(env); // PHONE_DEFAULT_REGION : téléphones des sujets en E.164 (D-25), validée au démarrage
  } catch (error) {
    throw new WorkerConfigError((error as Error).message);
  }
  const keyring = loadKeyring(env);
  return {
    databaseUrl,
    databaseUrlDirect: env['DATABASE_URL_DIRECT'] || undefined,
    keyring,
    version: env['RUNTIME_VERSION'] || '0.0.0',
    concurrency: Math.floor(concurrency),
    dbPoolMax: Math.floor(dbPoolMax),
    shutdownTimeoutSeconds: positive(env, 'SHUTDOWN_TIMEOUT_SECONDS', 30),
    runBudgetSeconds: positive(env, 'RUN_BUDGET_SECONDS', RUN_DEFAULTS.budgetSeconds, 1),
    runHeartbeatSeconds,
    runStaleSeconds,
    sweepIntervalSeconds: positive(env, 'SWEEP_INTERVAL_SECONDS', RUN_DEFAULTS.sweepIntervalSeconds),
    workerHeartbeatSeconds: positive(env, 'WORKER_HEARTBEAT_SECONDS', 15),
    queuePollingSeconds: positive(env, 'QUEUE_POLLING_SECONDS', 2, 0.5),
    observability,
    browserConcurrency: browser.value,
    browserConcurrencySource: browser.source,
    disableBrowser: disable === 'true' || disable === '1',
    retention,
    retentionTickSeconds: positive(env, 'RETENTION_TICK_SECONDS', 300),
  };
}
