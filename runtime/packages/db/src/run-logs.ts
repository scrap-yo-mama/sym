// Écriture de `run_logs` (INV4, INV8, 14 § 10) : le filtre de masquage s'applique avant l'insertion, jamais après ;
// le niveau minimal et les plafonds (taille d'une entrée, nombre d'entrées par run) bornent la table.
import { redact, secretValues, type SecretValueRegistry } from '@runtime/core';
import type pg from 'pg';

export type RunLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type RunLogEntry = { runId: string; seq: number; ownerId: string; level: RunLogLevel; event: string; data?: unknown };

const RANK: Record<RunLogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/** Plafonds par défaut : une entrée au plus 8 Kio de `data`, un run au plus 2 000 entrées (valeurs à valider, 14 § 10). */
export const RUN_LOG_LIMITS = { maxDataBytes: 8 * 1024, maxEntries: 2000, maxEventChars: 200 } as const;

export type RunLogLimits = { maxDataBytes: number; maxEntries: number };

type Queryable = Pick<pg.ClientBase, 'query'>;

/** JSON masqué de `data`, ou un marqueur `{ truncated, bytes }` si l'entrée dépasse le plafond (jamais une coupe en plein JSON). */
function boundedData(data: unknown, registry: SecretValueRegistry, maxBytes: number): string | null {
  if (data === undefined) return null;
  const json = JSON.stringify(redact(data, registry));
  if (json === undefined) return null;
  const bytes = Buffer.byteLength(json);
  return bytes <= maxBytes ? json : JSON.stringify({ truncated: true, bytes });
}

export async function appendRunLog(
  db: Queryable,
  entry: RunLogEntry,
  registry: SecretValueRegistry = secretValues,
  limits: Pick<RunLogLimits, 'maxDataBytes'> = RUN_LOG_LIMITS,
): Promise<void> {
  await db.query('INSERT INTO run_logs (run_id, seq, owner_id, level, event, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [
    entry.runId,
    entry.seq,
    entry.ownerId,
    entry.level,
    registry.redactText(entry.event).slice(0, RUN_LOG_LIMITS.maxEventChars),
    boundedData(entry.data, registry, limits.maxDataBytes),
  ]);
}

export type RunLogger = {
  /** Écrit une entrée (masquée) si son niveau atteint `minLevel` ; au-delà du plafond, une seule entrée `logs_truncated`. */
  log(level: RunLogLevel, event: string, data?: unknown): Promise<void>;
  /** Entrées écartées pour cause de plafond. */
  readonly dropped: number;
};

/**
 * Journal d'un run : numérote les entrées à partir de la suite de ce qui existe déjà (reprise après perte d'un worker),
 * filtre par niveau (`LOG_LEVEL`), plafonne et n'échoue jamais l'exécution (une écriture impossible est comptée, pas levée).
 */
export async function createRunLogger(
  db: Queryable,
  run: { runId: string; ownerId: string },
  options: { minLevel?: RunLogLevel; limits?: Partial<RunLogLimits>; registry?: SecretValueRegistry; onError?: (error: unknown) => void } = {},
): Promise<RunLogger> {
  const limits: RunLogLimits = { ...RUN_LOG_LIMITS, ...options.limits };
  const min = RANK[options.minLevel ?? 'info'];
  const { rows } = await db.query<{ seq: number }>('SELECT coalesce(max(seq), 0)::int AS seq FROM run_logs WHERE run_id = $1', [run.runId]);
  let seq = rows[0]?.seq ?? 0;
  let dropped = 0;
  let chain: Promise<void> = Promise.resolve();
  const write = (level: RunLogLevel, event: string, data: unknown) =>
    appendRunLog(db, { ...run, seq, level, event, data }, options.registry, limits).catch((error: unknown) => {
      dropped += 1;
      options.onError?.(error);
    });
  return {
    log(level, event, data) {
      if (RANK[level] < min) return Promise.resolve();
      // Série : `seq` est attribué dans l'ordre d'appel, sans course sur la clé (run_id, seq).
      chain = chain.then(async () => {
        if (seq >= limits.maxEntries) {
          dropped += 1;
          return;
        }
        seq += 1;
        if (seq === limits.maxEntries) {
          dropped += 1;
          await write('warn', 'logs_truncated', { max_entries: limits.maxEntries });
        } else await write(level, event, data);
      });
      return chain;
    },
    get dropped() {
      return dropped;
    },
  };
}
