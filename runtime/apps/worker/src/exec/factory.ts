// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur de production du worker (tâche 1.6) : garde SSRF de l'environnement (ALLOWED_PRIVATE_HOSTS,
// ALLOWED_EGRESS_PORTS), cadence par domaine en base (1.9), dépôt de secrets (identifiants des proxys BYO), pool
// Chromium de `BROWSER_CONCURRENCY` slots derrière un proxy de lancement FERMÉ (aucun trafic hors contexte de run),
// recyclage au seuil mémoire du cgroup (90 % de la limite).
import { DomainPacer } from '@runtime/core';
import { SsrfGuard, ssrfPolicyFromEnv, startEgressProxy, type EgressProxy } from '@runtime/core/net';
import { PgPacingStore, secretStore } from '@runtime/db';
import { cgroupMemoryCurrentBytes, cgroupMemoryLimitBytes } from '../browser/cgroup.js';
import { BrowserPool, playwrightLauncher } from '../browser/pool.js';
import type { ExecutorFactory } from '../worker.js';
import { createStrategyExecutor } from './strategy-executor.js';

/** Part de la limite mémoire du cgroup au-delà de laquelle un Chromium est recyclé à la fin de son run. */
const BROWSER_MEMORY_RECYCLE_RATIO = 0.9;

export function productionExecutorFactory(env: Readonly<Record<string, string | undefined>> = process.env): ExecutorFactory {
  return async ({ pool, config, checked, logger }) => {
    const guard = new SsrfGuard({ policy: ssrfPolicyFromEnv(env) });
    const pacer = new DomainPacer(new PgPacingStore(pool));
    const secrets = secretStore(pool, config.keyring, checked);
    let browsers: BrowserPool | null = null;
    let launchProxy: EgressProxy | undefined;
    if (!config.disableBrowser) {
      launchProxy = await startEgressProxy({
        guard,
        refuseAll: true,
        onRequest: (target) => logger.warn({ host: target.host, port: target.port }, 'Chromium : trafic hors contexte de run refusé'),
      });
      const limit = cgroupMemoryLimitBytes();
      browsers = new BrowserPool({
        size: config.browserConcurrency,
        launch: playwrightLauncher(launchProxy.url, env),
        ...(limit === undefined ? {} : { memoryHigh: () => (cgroupMemoryCurrentBytes() ?? 0) > limit * BROWSER_MEMORY_RECYCLE_RATIO }),
        onEvent: (event) => logger.info(event, 'navigateur'),
      });
      logger.info({ browserConcurrency: config.browserConcurrency, source: config.browserConcurrencySource }, 'pool Chromium prêt (lancement à la demande)');
    }
    const pool_ = browsers;
    return {
      executor: createStrategyExecutor({ pool, guard, pacer, browsers, secrets }),
      browserContexts: () => pool_?.active() ?? 0,
      close: async () => {
        await pool_?.close();
        await launchProxy?.close();
      },
    };
  };
}
