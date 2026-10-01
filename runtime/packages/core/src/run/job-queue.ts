// SPDX-License-Identifier: AGPL-3.0-only
// Interface de file (T2 R1) : le code métier ne voit que `JobQueue`. L'adaptateur pg-boss 12 (`@runtime/db`) est le
// seul endroit où pg-boss est importé et le seul à toucher le schéma `pgboss` (SQL brut interdit ailleurs).
import type { Execution, FailureClass, Network, RunOutcome } from '../model/enums.js';
import type { LogLevel } from '../observability/config.js';
import type { PersonalValueRegistry } from '../privacy/mask.js';

/** Files de la V1 (T2 R4). `run` seule est branchée en 1.3 ; `repair`, `scheduled-run`, `maintenance` : 2.x et 1.8. */
export const RUN_QUEUE = 'run';

/** Charge d'un job de run : l'identifiant seul (T2 R2) et, si OTel est activé, le contexte de trace. Le run en base fait foi. */
export type RunJobData = {
  run_id: string;
  /** Contexte W3C (`traceparent`) du span qui a mis le job en file ; présent seulement si OTel est activé (14 § 10). */
  _trace?: string;
};

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
  policy?: 'standard' | 'exclusive' | 'singleton';
  /** Rétention native des jobs terminés (14 § 9, phase 3) : supprimés par la maintenance de la file après ce délai. */
  deleteAfterSeconds?: number;
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
  enqueue<T extends object>(queue: string, data: T, options?: { tx?: QueryClient; id?: string }): Promise<string>;
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
  /**
   * Journal du run (`run_logs`) : masqué avant l'écriture (INV8), filtré par `LOG_LEVEL`, plafonné (14 § 10). Ne lève jamais :
   * un journal qui ne s'écrit pas ne fait pas échouer l'exécution.
   */
  log(level: LogLevel, event: string, data?: unknown): Promise<void>;
  /**
   * Registre de masquage de **ce** run (17 § 6) : l'exécuteur y inscrit les valeurs `x-personal` des items extraits
   * (`addFromItem`) ; le worker l'applique à `error_detail` (et `appendRunLog` l'exige), puis le vide en fin de run.
   */
  personal: PersonalValueRegistry;
  /**
   * Liste d'exclusion des sujets effacés (17 § 6, `erase_subject`), chargée à la prise du run avec la clé des sujets de
   * l'instance : à appliquer aux items **avant collecte et avant écriture** du dataset (tâches 1.6/1.7).
   */
  excludeSubjects<T>(outputSchema: unknown, items: readonly T[]): { kept: T[]; dropped: number };
};

export type RunExecutor = (ctx: RunContext) => Promise<RunResult>;
