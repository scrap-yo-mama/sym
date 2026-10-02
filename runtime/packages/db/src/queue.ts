// SPDX-License-Identifier: AGPL-3.0-only
// Adaptateur pg-boss 12 de `JobQueue` (tâche 1.3, T2 R1). SEUL fichier qui importe pg-boss : aucun SQL brut sur le
// schéma `pgboss` ailleurs. pg-boss crée et migre lui-même son schéma, sur la connexion de session
// (DATABASE_URL_DIRECT, 14 § 4) ; son pool compte dans le budget de connexions (`max`, défaut 2).
import type { JobQueue, JobState, QueryClient, QueueDefinition, QueuedJob } from '@runtime/core';
import { PgBoss, type Clock, type Db as PgBossDb } from 'pg-boss';
import { APP_ROLE } from './rls.js';

export type PgBossQueueOptions = {
  /** URL de session (LISTEN, verrous) : jamais un pooler en mode transaction. */
  connectionString: string;
  /** Taille du pool de pg-boss (budget de connexions, 14 § 4). */
  max?: number;
  /** Supervision (expiration, battements manqués, maintenance) : active par défaut ; pg-boss la coordonne entre instances. */
  supervise?: boolean;
  application_name?: string;
  onError?: (error: Error) => void;
  /**
   * Planification (08 § 5) : active la lecture du cron et l'envoi des occurrences dans la file cible. Un seul processus
   * tient chaque passage (verrou en base) ; deux workers ne produisent jamais deux jobs pour la même occurrence.
   */
  schedule?: boolean;
  /** Horloge injectable (tests : `TestClock` de pg-boss, qui pilote aussi l'heure côté Postgres). */
  clock?: Clock;
  cronMonitorIntervalSeconds?: number;
  cronWorkerIntervalSeconds?: number;
};

/**
 * Exécute les requêtes de pg-boss dans la transaction de l'appelant. Sous `withActor` (rôle `runtime_app`, sans droit
 * sur `pgboss`), le job est écrit sous l'identité système le temps de l'appel (`SET LOCAL ROLE NONE`), puis le rôle
 * est rétabli : même transaction, même COMMIT. La charge d'un job ne contient que des identifiants (`{ run_id }`).
 */
function inTransaction(tx: QueryClient): PgBossDb {
  return {
    async executeSql(text: string, values?: unknown[]) {
      const { rows } = (await tx.query('SELECT current_user = $1 AS app', [APP_ROLE])) as { rows: { app: boolean }[] };
      const switched = rows[0]?.app === true;
      if (switched) await tx.query('SET LOCAL ROLE NONE');
      try {
        return (await tx.query(text, values)) as { rows: unknown[] } as { rows: never[] };
      } finally {
        if (switched) await tx.query(`SET LOCAL ROLE ${APP_ROLE}`);
      }
    },
  };
}

export class PgBossJobQueue implements JobQueue {
  readonly #boss: PgBoss;

  constructor(options: PgBossQueueOptions) {
    this.#boss = new PgBoss({
      connectionString: options.connectionString,
      max: options.max ?? 2,
      application_name: options.application_name ?? 'runtime-queue',
      supervise: options.supervise ?? true,
      // Planification (2.5) : `schedules` est la source de vérité, pg-boss n'en est que le miroir (reconstruit au démarrage).
      schedule: options.schedule ?? false,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.cronMonitorIntervalSeconds ? { cronMonitorIntervalSeconds: options.cronMonitorIntervalSeconds } : {}),
      ...(options.cronWorkerIntervalSeconds ? { cronWorkerIntervalSeconds: options.cronWorkerIntervalSeconds } : {}),
    });
    this.#boss.on('error', (error: Error) => options.onError?.(error));
  }

  async start(): Promise<void> {
    await this.#boss.start();
  }

  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    await this.#boss.stop({ graceful: true, close: true, timeout: options.timeoutMs ?? 5000 });
  }

  async createQueue(definition: QueueDefinition, createOptions: { keepExisting?: boolean } = {}): Promise<void> {
    const options = {
      policy: definition.policy ?? 'standard',
      expireInSeconds: definition.expireInSeconds,
      heartbeatSeconds: definition.heartbeatSeconds,
      retryLimit: definition.retryLimit,
      ...(definition.deleteAfterSeconds !== undefined ? { deleteAfterSeconds: definition.deleteAfterSeconds } : {}),
    };
    // Idempotent ; une file existante garde sa politique, le reste est aligné sur la définition courante.
    await this.#boss.createQueue(definition.name, options);
    if (createOptions.keepExisting) return;
    await this.#boss.updateQueue(definition.name, {
      expireInSeconds: options.expireInSeconds,
      retryLimit: options.retryLimit,
      ...(options.deleteAfterSeconds !== undefined ? { deleteAfterSeconds: options.deleteAfterSeconds } : {}),
    });
  }

  async enqueue<T extends object>(
    queue: string,
    data: T,
    options: { tx?: QueryClient; id?: string; startAfterSeconds?: number } = {},
  ): Promise<string> {
    const id = await this.#boss.send(queue, data, {
      ...(options.id ? { id: options.id } : {}),
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
      ...(options.tx ? { db: inTransaction(options.tx) } : {}),
    });
    if (!id) throw new Error(`file ${queue} : job refusé par pg-boss (doublon d'identifiant ou de clé singleton)`);
    return id;
  }

  async enqueueOnce<T extends object>(
    queue: string,
    data: T,
    options: { singletonKey: string; startAfterSeconds?: number; tx?: QueryClient },
  ): Promise<string | null> {
    return this.#boss.send(queue, data, {
      singletonKey: options.singletonKey,
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
      ...(options.tx ? { db: inTransaction(options.tx) } : {}),
    });
  }

  async schedule(queue: string, key: string, cron: string, data: object, options: { timezone: string; missed: 'skip' | 'once' }): Promise<void> {
    await this.#boss.schedule(queue, cron, data, { key, tz: options.timezone, missed: options.missed });
  }

  async unschedule(queue: string, key: string): Promise<void> {
    await this.#boss.unschedule(queue, key);
  }

  async scheduledKeys(queue: string): Promise<string[]> {
    return (await this.#boss.getSchedules(queue)).map((s) => s.key);
  }

  previewSchedule(cron: string, options: { timezone: string; count: number; from?: Date }): Date[] {
    return this.#boss.previewSchedule(cron, { tz: options.timezone, count: options.count, ...(options.from ? { from: options.from } : {}) });
  }

  async work<T>(
    queue: string,
    options: { concurrency: number; pollingIntervalSeconds?: number },
    handler: (job: QueuedJob<T>) => Promise<void>,
  ): Promise<string> {
    return this.#boss.work<T>(
      queue,
      // `includeMetadata` : `createdOn` (horloge de la file) donne l'instant d'émission d'une occurrence planifiée.
      { batchSize: 1, localConcurrency: options.concurrency, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2, includeMetadata: true },
      async (jobs) => {
        for (const job of jobs) await handler({ id: job.id, data: job.data, signal: job.signal, createdOn: (job as { createdOn?: Date }).createdOn });
      },
    );
  }

  async offWork(queue: string): Promise<void> {
    await this.#boss.offWork(queue, { wait: false });
  }

  async cancel(queue: string, jobId: string, options: { tx?: QueryClient } = {}): Promise<void> {
    await this.#boss.cancel(queue, jobId, options.tx ? { db: inTransaction(options.tx) } : {});
  }

  async jobState(queue: string, jobId: string, options: { tx?: QueryClient } = {}): Promise<JobState | null> {
    const found = await this.#boss.findJobs(queue, { id: jobId, ...(options.tx ? { db: inTransaction(options.tx) } : {}) });
    return found[0]?.state ?? null;
  }
}

/**
 * Effacement d'un sujet (1.8) : nombre de jobs pg-boss dont la charge correspond au motif (lecture seule). Les charges ne
 * portent que des identifiants (`{ run_id }`) ; ce comptage le vérifie. 0 si le schéma pg-boss n'existe pas encore.
 */
export async function countQueuePayloadMatches(db: { query: QueryClient['query'] }, pattern: string): Promise<number> {
  const exists = (await db.query("SELECT to_regclass('pgboss.job') IS NOT NULL AS ok")) as { rows: { ok: boolean }[] };
  if (!exists.rows[0]?.ok) return 0;
  const { rows } = (await db.query('SELECT count(*)::int AS n FROM pgboss.job WHERE data::text ~* $1', [pattern])) as { rows: { n: number }[] };
  return rows[0]?.n ?? 0;
}
