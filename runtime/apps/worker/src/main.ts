// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée de `runtime worker` : configuration, démarrage (refus clair si la clé ou le schéma ne vont pas),
// arrêt propre sur SIGTERM/SIGINT (14 § 1). Code de sortie : 0 arrêt propre, 1 échec d'arrêt, 2 refus de démarrer.
import type { RunExecutor } from '@runtime/core';
import { loadWorkerConfig } from './config.js';
import { productionExecutorFactory } from './exec/factory.js';
import { assertSandboxSupported } from './sandbox/index.js';
import { startWorker, type Worker } from './worker.js';

export async function main(env: NodeJS.ProcessEnv = process.env, options: { executor?: RunExecutor } = {}): Promise<Worker | null> {
  let worker: Worker;
  try {
    // Test de démarrage (08 §3) : refus si isolated-vm est sous la borne GHSA-864f-rcv7-6rh4 ou sans binaire pour ce Node.
    assertSandboxSupported();
    // Sans exécuteur imposé (tests), E1-E3 de production (tâche 1.6).
    const executor = options.executor === undefined ? { executorFactory: productionExecutorFactory(env) } : { executor: options.executor };
    worker = await startWorker({ config: loadWorkerConfig(env), ...executor });
  } catch (error) {
    console.error(`Refus de démarrer le worker : ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return null;
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      worker.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
  return worker;
}
