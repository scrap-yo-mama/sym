// SPDX-License-Identifier: AGPL-3.0-only
// Journal pino 10 (14 § 10) : JSON, masquage en 3 couches (INV8) partagé par stdout, run_logs, spans et artefacts,
// `run_id` ajouté par AsyncLocalStorage. Un seul constructeur pour `server` et `worker`.
import { pino, type DestinationStream, type Logger } from 'pino';
import { loggerRedaction, secretValues, type SecretValueRegistry } from '../crypto/redact.js';
import type { LogLevel } from './config.js';
import { currentRunId } from './run-context.js';

export type { Logger };

export type CreateLoggerOptions = {
  name: string;
  level?: LogLevel;
  /** Flux de sortie (défaut : stdout). Les tests y branchent un collecteur pour prouver le masquage. */
  destination?: DestinationStream;
  registry?: SecretValueRegistry;
};

export function createLogger(options: CreateLoggerOptions): Logger {
  const registry = options.registry ?? secretValues;
  return pino(
    {
      name: options.name,
      level: options.level ?? 'info',
      ...loggerRedaction(registry),
      mixin: () => {
        const runId = currentRunId();
        return runId === undefined ? {} : { run_id: runId };
      },
    },
    options.destination,
  );
}
