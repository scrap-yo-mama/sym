// SPDX-License-Identifier: AGPL-3.0-only
// Garde disque (14 § 9) : avec un forfait `STORAGE_PLAN_GB`, alerte à 80 %, refus des nouveaux runs à 95 % avec
// l'erreur `storage_full`. Seuils réglables ; l'occupation est mesurée sur la base (`pg_database_size`), ou injectée.
// La garde est appliquée par `createRun` lui-même (D-25) : aucune route, aucun outil MCP ni planification ne la contourne.
import type pg from 'pg';

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
/** Une mesure de `pg_database_size` sert au plus ce délai pour la garde de `createRun` (coût par run borné). */
export const STORAGE_MEASURE_TTL_MS = 60_000;

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

/** `STORAGE_PLAN_GB` (Go, nombre > 0) ; absent ou vide : pas de garde. */
export function storagePlanFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env['STORAGE_PLAN_GB'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error('STORAGE_PLAN_GB invalide : nombre de Go strictement positif attendu.');
  return n;
}

let envPlan: { planGb: number | undefined } | undefined;
let lastMeasure: { at: number; bytes: number } | undefined;

/**
 * Garde par défaut de `createRun` : `STORAGE_PLAN_GB` lu une seule fois par processus ; mesure réelle mise en cache
 * `STORAGE_MEASURE_TTL_MS`. Sans forfait, aucune mesure n'est faite.
 */
export function defaultStorageOptions(db: Queryable, now: () => number = Date.now): StorageOptions {
  envPlan ??= { planGb: storagePlanFromEnv() };
  if (!envPlan.planGb) return {};
  return {
    planGb: envPlan.planGb,
    measure: async () => {
      if (lastMeasure && now() - lastMeasure.at < STORAGE_MEASURE_TTL_MS) return lastMeasure.bytes;
      const bytes = await databaseSizeBytes(db);
      lastMeasure = { at: now(), bytes };
      return bytes;
    },
  };
}
