// Garde disque (14 § 9) : avec un forfait `STORAGE_PLAN_GB`, alerte à 80 %, refus des nouveaux runs à 95 % avec
// l'erreur `storage_full`. Seuils réglables ; l'occupation est mesurée sur la base (`pg_database_size`), ou injectée.
import type pg from 'pg';
import { createRun, type CreateRunInput } from '../runs.js';
import type { JobQueue } from '@runtime/core';

type Queryable = Pick<pg.ClientBase, 'query'>;

export type StorageState = 'ok' | 'warning' | 'full';
export type StorageOptions = {
  /** Forfait de stockage en Go (`STORAGE_PLAN_GB`). Absent ou 0 : pas de garde. */
  planGb?: number | undefined;
  /** Pourcentage d'alerte (défaut 80). */
  warnPercent?: number;
  /** Pourcentage de refus (défaut 95). */
  fullPercent?: number;
  /** Mesure injectable (tests) : octets utilisés. Défaut : `pg_database_size(current_database())`. */
  measure?: () => Promise<number>;
};
export type StorageStatus = { state: StorageState; usedBytes: number; limitBytes: number | null; percent: number | null };

export const DEFAULT_STORAGE_THRESHOLDS = { warnPercent: 80, fullPercent: 95 } as const;
const GB = 1024 ** 3;

/** Erreur stable `storage_full` : le run n'est pas créé, aucune ligne n'est écrite. */
export class StorageFullError extends Error {
  readonly code = 'storage_full';
  readonly status: StorageStatus;
  constructor(status: StorageStatus) {
    super(`storage_full : ${status.percent?.toFixed(1)} % du forfait utilisé ; purgez ou augmentez STORAGE_PLAN_GB.`);
    this.name = 'StorageFullError';
    this.status = status;
  }
}

export async function databaseSizeBytes(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size');
  return Number(rows[0]?.size ?? 0);
}

export async function getStorageStatus(db: Queryable, opts: StorageOptions = {}): Promise<StorageStatus> {
  const warn = opts.warnPercent ?? DEFAULT_STORAGE_THRESHOLDS.warnPercent;
  const full = opts.fullPercent ?? DEFAULT_STORAGE_THRESHOLDS.fullPercent;
  if (!(warn > 0 && warn < full && full <= 100)) throw new Error('seuils de stockage invalides : 0 < alerte < refus <= 100');
  const usedBytes = await (opts.measure ? opts.measure() : databaseSizeBytes(db));
  if (!opts.planGb || opts.planGb <= 0) return { state: 'ok', usedBytes, limitBytes: null, percent: null };
  const limitBytes = opts.planGb * GB;
  const percent = (usedBytes / limitBytes) * 100;
  return { state: percent >= full ? 'full' : percent >= warn ? 'warning' : 'ok', usedBytes, limitBytes, percent };
}

/** Lève `StorageFullError` à partir du seuil de refus. Renvoie l'état sinon (l'appelant affiche l'alerte). */
export async function assertStorageAvailable(db: Queryable, opts: StorageOptions = {}): Promise<StorageStatus> {
  const status = await getStorageStatus(db, opts);
  if (status.state === 'full') throw new StorageFullError(status);
  return status;
}

/** `createRun` précédé de la garde disque : à 95 % du forfait, le run est refusé (`storage_full`) et rien n'est écrit. */
export async function createRunIfStorageAllows(
  tx: Queryable,
  queue: JobQueue,
  input: CreateRunInput,
  opts: StorageOptions = {},
): Promise<{ runId: string; jobId: string }> {
  await assertStorageAvailable(tx, opts);
  return createRun(tx, queue, input);
}
