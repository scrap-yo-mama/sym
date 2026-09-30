import { generateMasterKey } from '@runtime/core';
import { expect, test } from 'vitest';
import { loadWorkerConfig, WorkerConfigError } from './config.js';
import { unavailableExecutor } from './worker.js';

const base = () => ({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db', MASTER_KEY: generateMasterKey() });

test('configuration : défauts de 14 § 2, MASTER_KEY retirée de l’environnement', () => {
  const env: NodeJS.ProcessEnv = base();
  const c = loadWorkerConfig(env);
  expect(c).toMatchObject({
    concurrency: 5,
    dbPoolMax: 5,
    shutdownTimeoutSeconds: 30,
    runHeartbeatSeconds: 10,
    runStaleSeconds: 30,
    sweepIntervalSeconds: 60,
    workerHeartbeatSeconds: 15,
    databaseUrlDirect: undefined,
  });
  expect(env['MASTER_KEY']).toBeUndefined();
});

test('configuration : refus clairs', () => {
  expect(() => loadWorkerConfig({ MASTER_KEY: generateMasterKey() })).toThrow(/DATABASE_URL manquante/);
  expect(() => loadWorkerConfig({ ...base(), WORKER_CONCURRENCY: '8', DB_POOL_MAX: '5' })).toThrow(WorkerConfigError);
  expect(() => loadWorkerConfig({ ...base(), RUN_HEARTBEAT_SECONDS: '10', RUN_STALE_SECONDS: '15' })).toThrow(/2 × RUN_HEARTBEAT_SECONDS/);
  expect(() => loadWorkerConfig({ ...base(), SHUTDOWN_TIMEOUT_SECONDS: 'abc' })).toThrow(/SHUTDOWN_TIMEOUT_SECONDS invalide/);
  expect(() => loadWorkerConfig({ DATABASE_URL: 'postgres://x/y' })).toThrow(/MASTER_KEY/);
});

test('exécuteur par défaut : échec `code_error` explicite tant que 1.6 n’est pas branchée', async () => {
  expect(await unavailableExecutor({} as never)).toEqual({
    state: 'failed',
    failure_class: 'code_error',
    retryable: false,
    error_detail: 'executor_unavailable',
  });
});
