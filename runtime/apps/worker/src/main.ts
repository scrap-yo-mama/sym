// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée de `runtime worker` : configuration, démarrage (refus clair si la clé ou le schéma ne vont pas),
// arrêt propre sur SIGTERM/SIGINT (14 § 1). Code de sortie : 0 arrêt propre, 1 échec d'arrêt, 2 refus de démarrer.
import { unknownReservedVariablesWarning, type RunExecutor } from '@runtime/core';
import { loadWorkerConfig } from './config.js';
import { productionExecutorFactory } from './exec/factory.js';
import { assertSandboxSupported } from './sandbox/index.js';
import { isSecureExec, secureExecIgnoredWarning } from './secure-exec.js';
import { startWorker, type Worker } from './worker.js';

export async function main(env: NodeJS.ProcessEnv = process.env, options: { executor?: RunExecutor } = {}): Promise<Worker | null> {
  let worker: Worker;
  // Faute de frappe probable (14 § 2) : signalée, jamais fatale, jamais la valeur. Avant tout le reste, pour qu'un refus ultérieur la laisse visible.
  const unknownWarning = unknownReservedVariablesWarning(env);
  if (unknownWarning) console.error(unknownWarning);
  // Sous node-worker (image), NODE_OPTIONS, NODE_EXTRA_CA_CERTS et les variables d'OpenSSL sont ignorées : signalé.
  const secureWarning = secureExecIgnoredWarning(env, isSecureExec());
  if (secureWarning) console.error(secureWarning);
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
