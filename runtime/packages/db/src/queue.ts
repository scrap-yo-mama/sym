// SPDX-License-Identifier: AGPL-3.0-only
// Adaptateur pg-boss 12 de `JobQueue` (tâche 1.3, T2 R1). SEUL fichier qui importe pg-boss : aucun SQL brut sur le
// schéma `pgboss` ailleurs. pg-boss crée et migre lui-même son schéma, sur la connexion de session
// (DATABASE_URL_DIRECT, 14 § 4) ; son pool compte dans le budget de connexions (`max`, défaut 2).
import type { JobQueue, JobState, QueryClient, QueueDefinition, QueuedJob } from '@runtime/core';
import { PgBoss, type Db as PgBossDb } from 'pg-boss';
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
      // Planification : tâche 2.5 (`schedules` source de vérité). Rien à planifier en 1.3.
      schedule: false,
    });
    this.#boss.on('error', (error: Error) => options.onError?.(error));
  }

  async start(): Promise<void> {
    await this.#boss.start();
  }

  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    await this.#boss.stop({ graceful: true, close: true, timeout: options.timeoutMs ?? 5000 });
  }

  async createQueue(definition: QueueDefinition): Promise<void> {
    const options = {
      policy: definition.policy ?? 'standard',
      expireInSeconds: definition.expireInSeconds,
      heartbeatSeconds: definition.heartbeatSeconds,
      retryLimit: definition.retryLimit,
    };
    // Idempotent ; une file existante garde sa politique, le reste est aligné sur la définition courante.
    await this.#boss.createQueue(definition.name, options);
    await this.#boss.updateQueue(definition.name, {
      expireInSeconds: options.expireInSeconds,
      retryLimit: options.retryLimit,
    });
  }

  async enqueue<T extends object>(queue: string, data: T, options: { tx?: QueryClient; id?: string } = {}): Promise<string> {
    const id = await this.#boss.send(queue, data, {
      ...(options.id ? { id: options.id } : {}),
      ...(options.tx ? { db: inTransaction(options.tx) } : {}),
    });
    if (!id) throw new Error(`file ${queue} : job refusé par pg-boss (doublon d'identifiant ou de clé singleton)`);
    return id;
  }

  async work<T>(
    queue: string,
    options: { concurrency: number; pollingIntervalSeconds?: number },
    handler: (job: QueuedJob<T>) => Promise<void>,
  ): Promise<string> {
    return this.#boss.work<T>(
      queue,
      { batchSize: 1, localConcurrency: options.concurrency, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 },
      async (jobs) => {
        for (const job of jobs) await handler({ id: job.id, data: job.data, signal: job.signal });
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
