// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur de production du worker (tâche 1.6) : garde SSRF de l'environnement (ALLOWED_PRIVATE_HOSTS,
// ALLOWED_EGRESS_PORTS), cadence par domaine en base (1.9), dépôt de secrets (identifiants des proxys BYO), pool
// Chromium de `BROWSER_CONCURRENCY` slots derrière un proxy de lancement FERMÉ (aucun trafic hors contexte de run),
// recyclage au seuil mémoire du cgroup (mémoire de travail, page cache inactif exclu, au-delà de 90 % de la limite).
// Bac à sable des scripts E3 (1.5) : utilisateur dédié lu dans l'environnement (SANDBOX_UID, SANDBOX_GID,
// SANDBOX_LAUNCHER) ; en production, la frontière de l'OS est éprouvée au démarrage (`probeIsolation`) et le worker
// refuse de démarrer si l'enfant pourrait lire l'environnement du worker (D-30).
import { DomainPacer } from '@runtime/core';
import { SsrfGuard, ssrfPolicyFromEnv, startEgressProxy, type EgressProxy } from '@runtime/core/net';
import { PgPacingStore, secretStore } from '@runtime/db';
import { cgroupMemoryLimitBytes, cgroupMemoryWorkingSetBytes } from '../browser/cgroup.js';
import { BrowserPool, playwrightLauncher } from '../browser/pool.js';
import { ProcessSandboxEngine, sandboxOptionsFromEnv } from '../sandbox/index.js';
import type { ExecutorFactory } from '../worker.js';
import { loadInlineScript } from './script-executor.js';
import { createStrategyExecutor } from './strategy-executor.js';

class SandboxIsolationError extends Error {
  override name = 'SandboxIsolationError';
}

/** Part de la limite mémoire du cgroup au-delà de laquelle un Chromium est recyclé à la fin de son run. */
const BROWSER_MEMORY_RECYCLE_RATIO = 0.9;

export function productionExecutorFactory(env: Readonly<Record<string, string | undefined>> = process.env): ExecutorFactory {
  return async ({ pool, config, checked, logger }) => {
    const guard = new SsrfGuard({ policy: ssrfPolicyFromEnv(env) });
    const pacer = new DomainPacer(new PgPacingStore(pool));
    const secrets = secretStore(pool, config.keyring, checked);
    const production = env['NODE_ENV'] === 'production';
    const engine = new ProcessSandboxEngine({ ...sandboxOptionsFromEnv(env), production });
    if (production) {
      const probe = await engine.probeIsolation();
      if (probe.parentEnviron === 'readable') {
        throw new SandboxIsolationError("bac à sable : l'enfant lit l'environnement du worker (utilisateur dédié requis, D-30)");
      }
      logger.info({ sandboxUid: probe.uid, noNewPrivs: probe.noNewPrivs }, 'bac à sable : isolation éprouvée');
    }
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
        ...(limit === undefined ? {} : { memoryHigh: () => (cgroupMemoryWorkingSetBytes() ?? 0) > limit * BROWSER_MEMORY_RECYCLE_RATIO }),
        onEvent: (event) => logger.info(event, 'navigateur'),
      });
      logger.info({ browserConcurrency: config.browserConcurrency, source: config.browserConcurrencySource }, 'pool Chromium prêt (lancement à la demande)');
    }
    const pool_ = browsers;
    return {
      executor: createStrategyExecutor({ pool, guard, pacer, browsers, secrets, logger, script: { engine, loadScript: loadInlineScript } }),
      browserContexts: () => pool_?.active() ?? 0,
      close: async () => {
        await pool_?.close();
        await launchProxy?.close();
      },
    };
  };
}
