// SPDX-License-Identifier: AGPL-3.0-only
// Interface de file (T2 R1) : le code métier ne voit que `JobQueue`. L'adaptateur pg-boss 12 (`@runtime/db`) est le
// seul endroit où pg-boss est importé et le seul à toucher le schéma `pgboss` (SQL brut interdit ailleurs).
import type { Execution, FailureClass, Network, RunOutcome } from '../model/enums.js';

/** Files de la V1 (T2 R4). `run` seule est branchée en 1.3 ; `repair`, `scheduled-run`, `maintenance` : 2.x et 1.8. */
export const RUN_QUEUE = 'run';

/** Charge d'un job de run : l'identifiant seul (T2 R2). Le run en base fait foi. */
export type RunJobData = { run_id: string };

/** Connexion d'une transaction ouverte par l'appelant : le job est écrit dans cette transaction (même COMMIT). */
export type QueryClient = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

export type QueueDefinition = {
  name: string;
  /** Doit dépasser le budget d'un run (`expireInSeconds` > budget d'enquête, T2 R4). */
  expireInSeconds: number;
  /** Battement pg-boss du job (≥ 10 s). Distinct de `runs.heartbeat_at`, écrit par le worker. */
  heartbeatSeconds: number;
  /** 0 pour `run` : la reprise est décidée par le balayeur (fenêtre `job_id`), pas par pg-boss. */
  retryLimit: number;
  /** `short` : un seul job en attente par clé d'unicité (alertes regroupées). */
  policy?: 'standard' | 'exclusive' | 'singleton' | 'short';
};

export type QueuedJob<T> = { id: string; data: T; signal: AbortSignal };

export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';

export interface JobQueue {
  start(): Promise<void>;
  /** Arrêt de la file (après `offWork`). */
  stop(options?: { timeoutMs?: number }): Promise<void>;
  createQueue(definition: QueueDefinition): Promise<void>;
  /**
   * Met un job en file. Avec `tx`, l'insertion se fait dans la transaction de l'appelant (run et job : même COMMIT).
   * Renvoie l'identifiant du job.
   */
  enqueue<T extends object>(
    queue: string,
    data: T,
    options?: { tx?: QueryClient; id?: string; /** Le job ne devient disponible qu'après ce délai (s). */ startAfterSeconds?: number },
  ): Promise<string>;
  /**
   * Comme `enqueue` avec une clé d'unicité : tant qu'un job de la même clé attend dans la file (politique `short`), le
   * doublon est écarté sans erreur et `null` est rendu (regroupement des alertes sur une fenêtre).
   */
  enqueueOnce<T extends object>(
    queue: string,
    data: T,
    options: { singletonKey: string; startAfterSeconds?: number; tx?: QueryClient },
  ): Promise<string | null>;
  /**
   * Miroir d'une planification (08 § 5) : `schedules` reste la source de vérité, la file n'en garde qu'une copie
   * reconstruite au démarrage. `key` = `schedules.id` (sans clé, une planification écrase la précédente).
   * `missed: 'once'` rattrape une occurrence manquée pendant un déploiement.
   */
  schedule(queue: string, key: string, cron: string, data: object, options: { timezone: string; missed: 'skip' | 'once' }): Promise<void>;
  unschedule(queue: string, key: string): Promise<void>;
  /** Clés (`schedules.id`) des planifications que la file porte pour cette file. */
  scheduledKeys(queue: string): Promise<string[]>;
  /** Prochaines occurrences d'une expression, calculées sans toucher la base (aide à la saisie, contrôle de fréquence). */
  previewSchedule(cron: string, options: { timezone: string; count: number; from?: Date }): Date[];
  /** Consomme la file : `concurrency` jobs à la fois, un par appel de `handler`. Renvoie l'identifiant de l'abonnement. */
  work<T>(queue: string, options: { concurrency: number; pollingIntervalSeconds?: number }, handler: (job: QueuedJob<T>) => Promise<void>): Promise<string>;
  /** Cesse de prendre des jobs (les jobs en cours continuent). */
  offWork(queue: string): Promise<void>;
  cancel(queue: string, jobId: string, options?: { tx?: QueryClient }): Promise<void>;
  jobState(queue: string, jobId: string, options?: { tx?: QueryClient }): Promise<JobState | null>;
}

/** Essai journalisé (INV2, INV4) : un couple exécution × réseau, son résultat, son coût et sa durée. */
export type AttemptRecord = {
  execution: Execution;
  network: Network;
  est_cost_usd: number | null;
  /** Classe d'échec, ou `ok`. */
  result: FailureClass | 'ok';
  ms: number;
  /** Coût réel de l'essai, ventilé : la somme des essais fait le coût du run (INV4). */
  llm_usd?: number;
  proxy_usd?: number;
  tokens?: { in?: number; cached?: number; out?: number; reasoning?: number; estimated?: boolean };
  model_id?: string | null;
  prompt_version?: string | null;
  engine?: string | null;
};

/** Fin d'un run décidée par l'exécuteur. */
export type RunResult =
  | {
      state: 'succeeded';
      outcome: Exclude<RunOutcome, 'failed'>;
      degraded_reasons?: string[];
      items: number;
      dataset_id?: string | null;
      strategy_version?: number | null;
    }
  | {
      state: 'failed';
      failure_class: FailureClass;
      retryable: boolean;
      error_detail?: string | null;
      items?: number;
      strategy_version?: number | null;
    };

export type RunContext = {
  runId: string;
  apiId: string;
  /** Propriétaire du run : toute écriture de données d'utilisateur passe par `withActor` avec lui. */
  ownerId: string;
  strategyVersion: number | null;
  input: unknown;
  /** Levé à l'annulation, à la perte du bail (`job_id` changé), à l'expiration du job et à l'arrêt du worker. */
  signal: AbortSignal;
  recordAttempt(attempt: AttemptRecord): Promise<void>;
};

export type RunExecutor = (ctx: RunContext) => Promise<RunResult>;
