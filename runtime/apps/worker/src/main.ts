// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée de `runtime worker` : configuration, démarrage (refus clair si la clé ou le schéma ne vont pas),
// arrêt propre sur SIGTERM/SIGINT (14 § 1). Code de sortie : 0 arrêt propre, 1 échec d'arrêt, 2 refus de démarrer.
import type { RunExecutor } from '@runtime/core';
import { loadWorkerConfig } from './config.js';
import { startWorker, type Worker } from './worker.js';

export async function main(env: NodeJS.ProcessEnv = process.env, options: { executor?: RunExecutor } = {}): Promise<Worker | null> {
  let worker: Worker;
  try {
    worker = await startWorker({ config: loadWorkerConfig(env), ...options });
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
