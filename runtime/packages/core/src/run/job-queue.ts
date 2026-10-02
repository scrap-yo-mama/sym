// SPDX-License-Identifier: AGPL-3.0-only
// Interface de file (T2 R1) : le code métier ne voit que `JobQueue`. L'adaptateur pg-boss 12 (`@runtime/db`) est le
// seul endroit où pg-boss est importé et le seul à toucher le schéma `pgboss` (SQL brut interdit ailleurs).
import type { Execution, FailureClass, Network, RunKind, RunOutcome } from '../model/enums.js';
import type { LogLevel } from '../observability/config.js';
import type { PersonalValueRegistry } from '../privacy/mask.js';
import type { ActionReason, StatusEventInput } from '../status/types.js';

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
  /** `short` : un seul job en attente par clé d'unicité (alertes regroupées). */
  policy?: 'standard' | 'exclusive' | 'singleton' | 'short';
  /** Rétention native des jobs terminés (14 § 9, phase 3) : supprimés par la maintenance de la file après ce délai. */
  deleteAfterSeconds?: number;
};

export type QueuedJob<T> = {
  id: string;
  data: T;
  signal: AbortSignal;
  /** Création du job (horloge de la file) : pour une occurrence planifiée, l'instant où le cron l'a émise. */
  createdOn?: Date;
};

export type JobState = 'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';

export interface JobQueue {
  start(): Promise<void>;
  /** Arrêt de la file (après `offWork`). */
  stop(options?: { timeoutMs?: number }): Promise<void>;
  /**
   * Crée la file si elle manque (idempotent). Une file existante est alignée sur la définition, sauf avec `keepExisting` :
   * le `server` (3.1) s'assure seulement qu'elle existe, sans écraser les réglages du worker (`RUN_BUDGET_SECONDS`).
   */
  createQueue(definition: QueueDefinition, options?: { keepExisting?: boolean }): Promise<void>;
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
  /** null : coût inconnu (prix absent, 08 §1) ; le coût du run devient inconnu, jamais 0. */
  llm_usd?: number | null;
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
      stop_reason?: undefined;
      retryable: boolean;
      error_detail?: string | null;
      items?: number;
      strategy_version?: number | null;
    }
  | {
      /**
       * Run arrêté SANS classe d'échec (04 §6, codes de raison `status_reason`) : défi dans le tunnel
       * (`challenge_in_tunnel`, la main revient à l'humain), extension hors ligne (`tunnel_offline`), proxy requis non
       * configuré. Le worker en déduit l'événement `run_stopped` de la machine à états ; jamais rejoué.
       */
      state: 'failed';
      failure_class: null;
      stop_reason: ActionReason;
      retryable: false;
      error_detail?: string | null;
      items?: number;
      strategy_version?: number | null;
    }
  | {
      /**
       * Tunnel requis et extension hors ligne pendant le run (04 §6, 05) : `waiting_tunnel` → `skipped_tunnel_offline`.
       * Aucune classe d'échec, aucun essai journalisé (aucune commande n'a abouti), le statut de l'API ne change pas.
       */
      state: 'skipped_tunnel_offline';
      stop_reason: 'tunnel_offline';
      error_detail?: string | null;
      strategy_version?: number | null;
    };

export type RunContext = {
  runId: string;
  apiId: string;
  /** Propriétaire du run : toute écriture de données d'utilisateur passe par `withActor` avec lui. */
  ownerId: string;
  strategyVersion: number | null;
  input: unknown;
  /** Nature du run (`runs.kind`, migration 0016) : exécution d'une stratégie (défaut) ou enquête (04 §4). */
  kind?: RunKind;
  /** `runs.locale` : langue de la prose écrite par le LLM (bloc `Language:`, 21 § 4.5). Jamais envoyée à un site cible. */
  proseLocale?: string;
  /** Levé à l'annulation, à la perte du bail (`job_id` changé), à l'expiration du job et à l'arrêt du worker. */
  signal: AbortSignal;
  recordAttempt(attempt: AttemptRecord): Promise<void>;
  /**
   * Coût du run hors couple (E, N) : rôle `investigate`, rapport d'accès et reconnaissance d'une enquête (2.1).
   * Absent : rien n'est imputé (tests).
   */
  chargeCost?(cost: { llm_usd?: number | null; proxy_usd?: number; tokens?: AttemptRecord['tokens'] }): Promise<void>;
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
  /**
   * Écrit des items dans le dataset du run (créé au premier appel, complété aux suivants) : liste d'exclusion appliquée,
   * puis `dedup_key` / `diff` de la planification d'origine (08 § 5) contre les clés déjà vues pour l'API. Avec
   * `diff: new`, seuls les items nouveaux sont écrits. Le worker reporte le dataset écrit dans le résultat du run.
   * Les clés ne sont marquées comme vues qu'au succès du run : un run en échec après écriture n'en marque aucune.
   */
  writeItems(outputSchema: unknown, items: readonly unknown[]): Promise<DatasetWrite>;
  /**
   * Mode tunnel (07 § 6) : bascule `running ↔ waiting_tunnel` pendant que l'extension du propriétaire est hors ligne
   * (un redéploiement de la passerelle laisse le run en `waiting_tunnel`). Absent : aucun changement d'état (tests).
   */
  waitingTunnel?(waiting: boolean): Promise<void>;
  /**
   * Machine à états du statut de l'API du run (04 §6, INV3), appliquée par le worker dans la transaction qui écrit
   * `status_events` (webhooks et alertes compris). Rend le statut atteint, ou le refus de la machine (transition
   * absente : aucun changement). Absent : aucun changement de statut (tests).
   */
  applyStatus?(event: StatusEventInput): Promise<{ readonly ok: boolean; readonly status: string | null; readonly reason: string | null }>;
};

/** Bilan cumulé des écritures du run dans son dataset. */
export type DatasetWrite = {
  dataset_id: string;
  /** Items écrits dans le dataset. */
  written: number;
  /** Items dont la clé de déduplication n'avait jamais été vue pour l'API (`null` : pas de `dedup_key`). */
  new_items: number | null;
  /** Items retirés par la liste d'exclusion des sujets effacés. */
  dropped: number;
  /** Items écartés : déjà vus (`diff: new`) ou doublons de clé dans le même run. */
  skipped: number;
};

export type RunExecutor = (ctx: RunContext) => Promise<RunResult>;
