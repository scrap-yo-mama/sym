// SPDX-License-Identifier: AGPL-3.0-only
// `run_id` porté par AsyncLocalStorage (14 § 10) : le journal pino l'ajoute à chaque ligne sans que l'appelant le passe.
import { AsyncLocalStorage } from 'node:async_hooks';

type RunContext = { runId: string };

const storage = new AsyncLocalStorage<RunContext>();

/** Exécute `fn` avec `runId` comme contexte de journalisation (propagé aux appels asynchrones). */
export function withRunContext<T>(runId: string, fn: () => T): T {
  return storage.run({ runId }, fn);
}

export function currentRunId(): string | undefined {
  return storage.getStore()?.runId;
}
