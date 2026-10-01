// Processus worker réel pour les tests d'intégration (kill -9, SIGTERM) : `main` de production, exécuteur de test.
// EXECUTOR=hang : un essai journalisé, puis attente jusqu'à l'interruption. EXECUTOR=ok : un essai, succès.
// Écrit « claimed <run_id> » sur stdout quand un run est pris : le test attend cet événement (pas de sleep).
import type { RunExecutor } from '@runtime/core';
import { main } from '../main.js';

const mode = process.env['EXECUTOR'] ?? 'hang';

const executor: RunExecutor = async (ctx) => {
  await ctx.recordAttempt({ execution: 'fetch', network: 'direct', est_cost_usd: 0, result: 'ok', ms: 5 });
  process.stdout.write(`claimed ${ctx.runId}\n`);
  if (mode === 'hang') {
    await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
  }
  return { state: 'succeeded', outcome: 'clean', items: 1 };
};

const worker = await main(process.env, { executor });
if (worker) process.stdout.write(`ready ${worker.workerId}\n`);
