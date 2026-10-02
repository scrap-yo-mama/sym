// SPDX-License-Identifier: AGPL-3.0-only
// Cycle de vie des runs (tâche 1.3, INV4 ; 03 § Services « Flux d'un run » ; 14 § 1 et § 9 ; T2 R2, R4, R5).
//
// Identités :
// - côté web, `createRun`, `recordSkippedRun`, `cancelRun`, `readRun` reçoivent le client d'une transaction `withActor`
//   (rôle `runtime_app`, RLS) : un utilisateur ne crée, n'annule et ne lit que ses runs ;
// - côté worker, `claimRun`, `heartbeatRun`, `recordAttempt`, `finishRun`, `requeueRun`, `sweepOrphans`, le bail de
//   réparation et `worker_heartbeats` sont l'**identité système** (connexion propriétaire des tables, hors RLS) : le
//   worker traite les runs de tous les utilisateurs, ne lit que les colonnes de pilotage et n'expose rien. Toute écriture
//   de données d'utilisateur par un exécuteur passe par `withActor` avec `RunContext.ownerId`.
//
// Jeton de clôture : chaque écriture du worker exige `runs.job_id` = son job. Une remise en file (balayeur, arrêt)
// change `job_id` : un worker présumé mort qui se réveille n'écrit plus rien (RunLeaseLostError).
import { randomUUID } from 'node:crypto';
import {
  ACTIVE_RUN_STATES,
  boundErrorDetail,
  currentTraceparent,
  maxRunRequeues,
  RUN_LOST_DETAIL,
  RUN_QUEUE,
  type AttemptRecord,
  type JobQueue,
  type PersonalValueRegistry,
  type QueryClient,
  type QueueDefinition,
  type Run,
  type RunKind,
  type RunResult,
  type RunState,
  type RunTrigger,
  type SkippedRunState,
} from '@runtime/core';
import type pg from 'pg';
import { readRejectedAggregates } from './rejected.js';
import { assertStorageAvailable, defaultStorageOptions, type StorageOptions } from './retention/storage.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export class RunNotFoundError extends Error {
  override name = 'RunNotFoundError';
}

/** Le run n'appartient plus à ce job (annulé, remis en file par le balayeur ou l'arrêt) : l'exécution doit cesser. */
export class RunLeaseLostError extends Error {
  override name = 'RunLeaseLostError';
}

/** Durées par défaut (à valider en recette, 14 § 14). */
export const RUN_DEFAULTS = {
  /** Budget d'un run (s). `expireInSeconds` de la file le dépasse (T2 R4). */
  budgetSeconds: 900,
  /** Écriture de `runs.heartbeat_at` par le worker. */
  heartbeatSeconds: 10,
  /** Un run actif sans battement depuis ce délai est orphelin (3 battements manqués). */
  staleSeconds: 30,
  /** Période du balayeur (03 § Services). */
  sweepIntervalSeconds: 60,
} as const;

/** Jobs terminés (14 § 9, phase 3) : supprimés par la maintenance de pg-boss 7 jours après leur fin (journaux : 30 jours). */
export const RUN_JOB_RETENTION_SECONDS = 7 * 86_400;

/** File `run` : pas de nouvel essai par pg-boss (la reprise est décidée par le balayeur, fenêtre `job_id`). */
export function runQueueDefinition(budgetSeconds: number = RUN_DEFAULTS.budgetSeconds): QueueDefinition {
  return { name: RUN_QUEUE, expireInSeconds: budgetSeconds + 60, heartbeatSeconds: 30, retryLimit: 0, policy: 'standard', deleteAfterSeconds: RUN_JOB_RETENTION_SECONDS };
}

const ACTIVE = ACTIVE_RUN_STATES as readonly string[];

// ---------------------------------------------------------------------------------------------------------------
// Côté web (sous withActor)
// ---------------------------------------------------------------------------------------------------------------

/** Origine planifiée d'un run (2.5) : planification, instant du déclenchement, job `scheduled-run` (unique : un rejeu ne crée rien). */
export type ScheduleOrigin = { scheduleId: string; scheduledAt: Date; scheduleJobId: string | null };

export type CreateRunInput = {
  apiId: string;
  ownerId: string;
  trigger: RunTrigger;
  input?: unknown;
  traceId?: string | null;
  schedule?: ScheduleOrigin;
  /** Nature du run (migration 0016) : `run` par défaut, `investigation` pour une enquête (2.1). */
  kind?: RunKind;
};

/**
 * Insère le run `queued` **et** son job pg-boss dans la transaction `tx` (T2 R2) : un ROLLBACK n'en laisse aucun des
 * deux, un COMMIT les deux. L'API doit être visible de l'acteur (RLS).
 * Garde disque (14 § 9, D-25) : à 95 % de `STORAGE_PLAN_GB`, `StorageFullError` (`storage_full`) avant toute écriture.
 * `opts.storage` remplace la garde lue dans l'environnement (tests, réglages) ; elle n'est jamais désactivable ici.
 */
export async function createRun(
  tx: Queryable,
  queue: JobQueue,
  input: CreateRunInput,
  opts: { storage?: StorageOptions } = {},
): Promise<{ runId: string; jobId: string }> {
  await assertStorageAvailable(tx, opts.storage ?? defaultStorageOptions(tx));
  const api = await tx.query<{ owner_id: string }>('SELECT owner_id FROM apis WHERE id = $1', [input.apiId]);
  const apiOwner = api.rows[0]?.owner_id;
  if (!apiOwner) throw new RunNotFoundError(`API ${input.apiId} introuvable`);
  const runId = randomUUID();
  const jobId = randomUUID();
  await tx.query(
    `INSERT INTO runs (id, api_id, owner_id, api_owner_id, trigger, input, trace_id, job_id, state, heartbeat_at, schedule_id, scheduled_at, schedule_job_id, kind)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'queued', now(), $9, $10, $11, $12)`,
    [
      runId,
      input.apiId,
      input.ownerId,
      apiOwner,
      input.trigger,
      input.input === undefined ? null : JSON.stringify(input.input),
      input.traceId ?? null,
      jobId,
      input.schedule?.scheduleId ?? null,
      input.schedule?.scheduledAt ?? null,
      input.schedule?.scheduleJobId ?? null,
      input.kind ?? 'run',
    ],
  );
  const trace = currentTraceparent();
  await queue.enqueue(RUN_QUEUE, { run_id: runId, ...(trace ? { _trace: trace } : {}) }, { tx: tx as QueryClient, id: jobId });
  return { runId, jobId };
}

/** Run tracé sans job (planification, 2.5) : `skipped_*` est terminal dès la création. */
export async function recordSkippedRun(
  tx: Queryable,
  input: Omit<CreateRunInput, 'input'> & { state: SkippedRunState; reason?: string },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, error_detail, trace_id, finished_at, duration_ms, schedule_id, scheduled_at, schedule_job_id)
     SELECT a.id, $2, a.owner_id, $3, $4, $5, $6, now(), 0, $7, $8, $9 FROM apis a WHERE a.id = $1
     RETURNING id`,
    [
      input.apiId,
      input.ownerId,
      input.trigger,
      input.state,
      input.reason ?? null,
      input.traceId ?? null,
      input.schedule?.scheduleId ?? null,
      input.schedule?.scheduledAt ?? null,
      input.schedule?.scheduleJobId ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new RunNotFoundError(`API ${input.apiId} introuvable`);
  return id;
}

/**
 * Annule un run actif (même transaction pour le run et le job). Le worker qui l'exécute le constate à son battement
 * suivant (plus de ligne à son `job_id` dans un état actif) et interrompt l'exécution. Renvoie false si déjà terminé.
 */
export async function cancelRun(tx: Queryable, queue: JobQueue, runId: string): Promise<boolean> {
  const { rows } = await tx.query<{ job_id: string | null }>(
    `UPDATE runs SET state = 'cancelled', finished_at = now(),
       duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE (extract(epoch FROM now() - started_at) * 1000)::int END
     WHERE id = $1 AND state = ANY($2::text[]) RETURNING job_id`,
    [runId, ACTIVE],
  );
  if (rows.length === 0) return false;
  const jobId = rows[0]?.job_id;
  if (jobId) await queue.cancel(RUN_QUEUE, jobId, { tx: tx as QueryClient });
  return true;
}

/** Pause refusée : run terminé, déjà en pause, ou API qui écrit (une reprise rejouerait ses écritures, comme le balayeur). */
export type PauseOutcome = 'paused' | 'not_active' | 'already_paused' | 'write_actions';

/**
 * Met en pause un run actif (0017, 06 § 2) : `queued` sans job, `paused_at` posé, job pg-boss annulé, dans la transaction
 * `tx` (sous withActor : l'acteur ne touche que ses runs). Le worker qui le tenait perd son bail au battement suivant ; les
 * essais et les coûts déjà imputés restent (INV4). Le balayeur et `claimRun` ignorent un run en pause.
 */
export async function pauseRun(tx: Queryable, queue: JobQueue, runId: string): Promise<PauseOutcome> {
  const { rows } = await tx.query<{ state: RunState; job_id: string | null; paused_at: Date | null; allow_write_actions: boolean }>(
    'SELECT r.state, r.job_id, r.paused_at, a.allow_write_actions FROM runs r JOIN apis a ON a.id = r.api_id WHERE r.id = $1 FOR UPDATE OF r',
    [runId],
  );
  const run = rows[0];
  if (!run || !ACTIVE.includes(run.state)) return 'not_active';
  if (run.paused_at !== null) return 'already_paused';
  if (run.allow_write_actions) return 'write_actions';
  await tx.query("UPDATE runs SET state = 'queued', paused_at = now(), job_id = NULL, worker_id = NULL WHERE id = $1", [runId]);
  if (run.job_id) await queue.cancel(RUN_QUEUE, run.job_id, { tx: tx as QueryClient });
  return 'paused';
}

/** Reprend un run en pause (action de l'utilisateur) : nouveau job dans la même transaction. false : le run n'était pas en pause. */
export async function resumeRun(tx: Queryable, queue: JobQueue, runId: string): Promise<boolean> {
  const jobId = randomUUID();
  const { rowCount } = await tx.query(
    "UPDATE runs SET paused_at = NULL, job_id = $2, heartbeat_at = now() WHERE id = $1 AND state = 'queued' AND paused_at IS NOT NULL",
    [runId, jobId],
  );
  if (rowCount !== 1) return false;
  const trace = currentTraceparent();
  await queue.enqueue(RUN_QUEUE, { run_id: runId, ...(trace ? { _trace: trace } : {}) }, { tx: tx as QueryClient, id: jobId });
  return true;
}

type RunRow = {
  id: string;
  api_id: string;
  owner_id: string;
  strategy_version: number | null;
  trigger: RunTrigger;
  state: RunState;
  outcome: Run['outcome'];
  degraded_reasons: string[];
  failure_class: Run['failure_class'];
  retryable: boolean | null;
  cost_llm_usd: string | null;
  cost_proxy_usd: string;
  tokens_in: string;
  tokens_cached: string;
  tokens_out: string;
  tokens_reasoning: string;
  usage_estimated: boolean;
  items: number;
  items_rejected: number;
  dataset_id: string | null;
  trace_id: string | null;
};

type AttemptRow = {
  execution: Run['attempts'][number]['execution'];
  network: Run['attempts'][number]['network'];
  est_cost_usd: string | null;
  result_class: string | null;
  cost_usd: string | null;
  ms: number | null;
  model_id: string | null;
  prompt_version: string | null;
  engine: string | null;
};

/** Un montant `numeric(12,6)` en nombre, arrondi au micro-dollar. */
const usd = (v: string | null): number => Math.round(Number(v ?? 0) * 1e6) / 1e6;
/** Montant qui peut être inconnu (coût LLM sans prix, 08 §1) : null reste null, jamais 0. */
const usdOrNull = (v: string | null): number | null => (v === null ? null : usd(v));

/** Run au format du contrat (04b § 1), essais compris. Sous `withActor`, la RLS limite aux runs de l'acteur. */
export async function readRun(db: Queryable, runId: string): Promise<Run | null> {
  const { rows } = await db.query<RunRow>('SELECT * FROM runs WHERE id = $1', [runId]);
  const r = rows[0];
  if (!r) return null;
  const attempts = await db.query<AttemptRow>(
    'SELECT execution, network, est_cost_usd, result_class, cost_usd, ms, model_id, prompt_version, engine FROM run_attempts WHERE run_id = $1 ORDER BY seq',
    [runId],
  );
  const llm = usdOrNull(r.cost_llm_usd);
  const proxy = usd(r.cost_proxy_usd);
  return {
    id: r.id,
    api_id: r.api_id,
    owner_id: r.owner_id,
    strategy_version: r.strategy_version,
    trigger: r.trigger,
    state: r.state,
    outcome: r.outcome,
    degraded_reasons: r.degraded_reasons,
    failure_class: r.failure_class,
    retryable: r.retryable,
    attempts: attempts.rows.map((a) => ({
      execution: a.execution,
      network: a.network,
      est_cost_usd: usd(a.est_cost_usd),
      result: (a.result_class ?? 'ok') as Run['attempts'][number]['result'],
      cost_usd: usdOrNull(a.cost_usd),
      ms: a.ms ?? 0,
      model_id: a.model_id,
      prompt_version: a.prompt_version,
      engine: a.engine,
    })),
    cost: { llm_usd: llm, proxy_usd: proxy, total_usd: llm === null ? null : Math.round((llm + proxy) * 1e6) / 1e6 },
    tokens: {
      in: Number(r.tokens_in),
      cached: Number(r.tokens_cached),
      out: Number(r.tokens_out),
      reasoning: Number(r.tokens_reasoning),
      estimated: r.usage_estimated,
    },
    items: r.items,
    items_rejected: r.items_rejected ?? 0,
    rejected: await readRejectedAggregates(db, r.id),
    dataset_id: r.dataset_id,
    trace_id: r.trace_id,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Côté worker (identité système)
// ---------------------------------------------------------------------------------------------------------------

export type RunClaim = {
  runId: string;
  jobId: string;
  apiId: string;
  ownerId: string;
  strategyVersion: number | null;
  input: unknown;
  allowWriteActions: boolean;
  /** `runs.kind` (0016) : le worker y choisit l'exécuteur (stratégie ou enquête). */
  kind: RunKind;
  /** `runs.locale` (0019) : langue du demandeur au lancement ; prose du LLM seulement, jamais une requête vers un site (21 § 6). */
  locale: string;
};

/**
 * Prend le run du job : `queued → running`, uniquement si `job_id` est bien ce job. Fige la version de stratégie
 * courante de l'API si le run n'en a pas (INV4). `null` : run annulé, déjà repris ou remplacé.
 */
export async function claimRun(db: Queryable, args: { runId: string; jobId: string; workerId: string }): Promise<RunClaim | null> {
  const { rows } = await db.query<{
    api_id: string;
    owner_id: string;
    strategy_version: number | null;
    input: unknown;
    allow_write_actions: boolean;
    kind: RunKind;
    locale: string;
  }>(
    `UPDATE runs r SET state = 'running', worker_id = $3, started_at = coalesce(r.started_at, now()), heartbeat_at = now(),
       strategy_version = coalesce(r.strategy_version, a.current_strategy_version)
     FROM apis a
     WHERE r.id = $1 AND r.job_id = $2 AND r.state = 'queued' AND r.paused_at IS NULL AND a.id = r.api_id
     RETURNING r.api_id, r.owner_id, r.strategy_version, r.input, a.allow_write_actions, r.kind, r.locale`,
    [args.runId, args.jobId, args.workerId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    runId: args.runId,
    jobId: args.jobId,
    apiId: r.api_id,
    ownerId: r.owner_id,
    strategyVersion: r.strategy_version,
    input: r.input,
    allowWriteActions: r.allow_write_actions,
    kind: r.kind,
    locale: r.locale,
  };
}

/** Battement du run (`runs.heartbeat_at`). false : le run n'est plus à ce job (annulé ou repris) → interrompre. */
export async function heartbeatRun(db: Queryable, runId: string, jobId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'UPDATE runs SET heartbeat_at = now() WHERE id = $1 AND job_id = $2 AND state = ANY($3::text[])',
    [runId, jobId, ['running', 'waiting_tunnel']],
  );
  return rowCount === 1;
}

/** Bascule `running ↔ waiting_tunnel` (mode tunnel, 2.6). */
export async function setRunWaitingTunnel(db: Queryable, runId: string, jobId: string, waiting: boolean): Promise<void> {
  const [from, to] = waiting ? ['running', 'waiting_tunnel'] : ['waiting_tunnel', 'running'];
  const { rowCount } = await db.query('UPDATE runs SET state = $4, heartbeat_at = now() WHERE id = $1 AND job_id = $2 AND state = $3', [
    runId,
    jobId,
    from,
    to,
  ]);
  if (rowCount !== 1) throw new RunLeaseLostError(`run ${runId} : bail perdu`);
}

/**
 * Journalise un essai (INV2, INV4) et impute son coût et ses jetons au run, en une instruction : le coût du run est par
 * construction la somme de ses essais. Lève RunLeaseLostError si le run n'est plus à ce job (l'essai est alors journalisé
 * et imputé quand même, sans battement). Un coût LLM inconnu
 * (`llm_usd: null`, prix absent) rend l'essai et le run inconnus (NULL, jamais 0 ; 08 §1, INV4) : `NULL + x` reste NULL.
 */
export async function recordAttempt(db: Queryable, runId: string, jobId: string, a: AttemptRecord): Promise<number> {
  const llm = a.llm_usd === undefined ? 0 : a.llm_usd;
  const proxy = a.proxy_usd ?? 0;
  if ((llm !== null && llm < 0) || proxy < 0) throw new RangeError('coût négatif');
  const t = a.tokens ?? {};
  const params = [
    runId,
    jobId,
    llm,
    proxy,
    t.in ?? 0,
    t.cached ?? 0,
    t.out ?? 0,
    t.reasoning ?? 0,
    t.estimated ?? false,
    a.execution,
    a.network,
    a.result,
    a.est_cost_usd,
    Math.round(a.ms),
    a.model_id ?? null,
    a.prompt_version ?? null,
    ['running', 'waiting_tunnel'],
    a.engine ?? null,
  ];
  const sql = (leased: boolean) =>
    `WITH r AS (
       UPDATE runs SET cost_llm_usd = cost_llm_usd + $3, cost_proxy_usd = cost_proxy_usd + $4,
         tokens_in = tokens_in + $5, tokens_cached = tokens_cached + $6, tokens_out = tokens_out + $7,
         tokens_reasoning = tokens_reasoning + $8, usage_estimated = usage_estimated OR $9${leased ? ', heartbeat_at = now()' : ''}
       WHERE id = $1 AND ${leased ? '' : 'NOT '}(job_id IS NOT DISTINCT FROM $2 AND state = ANY($17::text[]))
       RETURNING id, owner_id, project_id)
     INSERT INTO run_attempts (run_id, seq, owner_id, project_id, execution, network, result_class, est_cost_usd, cost_usd, ms,
       model_id, prompt_version, engine)
     SELECT r.id, coalesce((SELECT max(seq) FROM run_attempts WHERE run_id = r.id), 0) + 1, r.owner_id, r.project_id,
       $10, $11, $12, $13, $3::numeric + $4::numeric, $14, $15, $16, $18
     FROM r RETURNING seq`;
  const { rows } = await db.query<{ seq: number }>(sql(true), params);
  if (rows[0] === undefined) {
    // Bail perdu (pause, annulation, balayeur) : l'essai a eu lieu et son coût est réel ; il est journalisé et imputé
    // quand même (INV2, INV4 : une pause répétée ne ferait pas fuir le budget), sans battement, puis l'erreur est levée.
    await db.query(sql(false), params);
  }
  const seq = rows[0]?.seq;
  if (seq === undefined) throw new RunLeaseLostError(`run ${runId} : bail perdu`);
  return seq;
}

/**
 * Impute au run un coût qui n'est pas celui d'un couple (E, N) : appel du rôle `investigate`, rapport d'accès et
 * reconnaissance d'une enquête (tâche 2.1). Même règle que `recordAttempt` : un coût LLM inconnu rend le coût du run
 * inconnu (NULL, jamais 0). Lève RunLeaseLostError si le run n'est plus à ce job.
 */
export async function chargeRunCost(
  db: Queryable,
  runId: string,
  jobId: string,
  c: { llm_usd?: number | null; proxy_usd?: number; tokens?: AttemptRecord['tokens'] },
): Promise<void> {
  const llm = c.llm_usd === undefined ? 0 : c.llm_usd;
  const proxy = c.proxy_usd ?? 0;
  if ((llm !== null && llm < 0) || proxy < 0) throw new RangeError('coût négatif');
  const t = c.tokens ?? {};
  const sql = (leased: boolean) =>
    `UPDATE runs SET cost_llm_usd = cost_llm_usd + $3, cost_proxy_usd = cost_proxy_usd + $4,
       tokens_in = tokens_in + $5, tokens_cached = tokens_cached + $6, tokens_out = tokens_out + $7,
       tokens_reasoning = tokens_reasoning + $8, usage_estimated = usage_estimated OR $9${leased ? ', heartbeat_at = now()' : ''}
     WHERE id = $1 AND ${leased ? '' : 'NOT '}(job_id IS NOT DISTINCT FROM $2 AND state = ANY($10::text[]))`;
  const params = [runId, jobId, llm, proxy, t.in ?? 0, t.cached ?? 0, t.out ?? 0, t.reasoning ?? 0, t.estimated ?? false, ['running', 'waiting_tunnel']];
  const { rowCount } = await db.query(sql(true), params);
  if (rowCount !== 1) {
    // Bail perdu : le coût engagé (appel LLM en vol au moment d'une pause ou d'une annulation) est imputé quand même (INV4).
    await db.query(sql(false), params);
    throw new RunLeaseLostError(`run ${runId} : bail perdu`);
  }
}

/**
 * Clôt le run selon l'exécuteur. false : le run n'est plus à ce job (rien n'est écrit). `error_detail` est masqué
 * (secrets, e-mails, téléphones et valeurs du registre de ce run, `RunContext.personal`) puis tronqué.
 */
export async function finishRun(
  db: Queryable,
  runId: string,
  jobId: string,
  result: RunResult,
  opts: { personal?: PersonalValueRegistry } = {},
): Promise<boolean> {
  // Tunnel hors ligne (04 §6) : le run ne quitte `waiting_tunnel` que pour `skipped_tunnel_offline`, sans issue ni classe.
  if (result.state === 'skipped_tunnel_offline') {
    const { rowCount } = await db.query(
      `UPDATE runs SET state = 'skipped_tunnel_offline', outcome = NULL, failure_class = NULL, retryable = NULL, error_detail = $3,
         strategy_version = coalesce($4, strategy_version), finished_at = now(), heartbeat_at = now(),
         duration_ms = (extract(epoch FROM now() - coalesce(started_at, created_at)) * 1000)::int
       WHERE id = $1 AND job_id = $2 AND state = 'waiting_tunnel'`,
      [runId, jobId, boundErrorDetail(result.error_detail ?? result.stop_reason, opts.personal), result.strategy_version ?? null],
    );
    return rowCount === 1;
  }
  const failed = result.state === 'failed';
  const { rowCount } = await db.query(
    `UPDATE runs SET state = $3, outcome = $4, degraded_reasons = $5, failure_class = $6, retryable = $7, error_detail = $8,
       items = $9, dataset_id = $10, strategy_version = coalesce($11, strategy_version), items_rejected = $13, finished_at = now(),
       heartbeat_at = now(), duration_ms = (extract(epoch FROM now() - coalesce(started_at, created_at)) * 1000)::int
     WHERE id = $1 AND job_id = $2 AND state = ANY($12::text[])`,
    [
      runId,
      jobId,
      result.state,
      failed ? 'failed' : result.outcome,
      failed ? [] : (result.degraded_reasons ?? []),
      failed ? result.failure_class : null,
      failed ? result.retryable : null,
      // INV8 : `error_detail` est un puits comme les autres, masqué (secrets, données personnelles) avant l'écriture quel que soit l'appelant.
      failed ? boundErrorDetail(result.error_detail, opts.personal) : null,
      result.items ?? 0,
      failed ? null : (result.dataset_id ?? null),
      result.strategy_version ?? null,
      ['running', 'waiting_tunnel'],
      result.items_rejected ?? 0,
    ],
  );
  return rowCount === 1;
}

type OrphanRow = { id: string; state: RunState; job_id: string | null; requeue_count: number; allow_write_actions: boolean };

/**
 * Reprise d'un run actif dans la transaction `tx` : remise en file (nouveau `job_id`, nouveau job, même COMMIT) si le
 * plafond le permet, sinon `failed` (`transient`, `detail`). `count` : la perte compte dans `requeue_count` (balayeur) ;
 * un arrêt propre (SIGTERM) ne compte pas, mais n'est jamais rejoué pour une API qui écrit.
 */
async function reclaim(tx: Queryable, queue: JobQueue, run: OrphanRow, detail: string, count: boolean): Promise<'requeued' | 'failed'> {
  const allowed = count ? run.requeue_count < maxRunRequeues(run) : !run.allow_write_actions;
  if (allowed) {
    const jobId = randomUUID();
    await tx.query(
      `UPDATE runs SET state = 'queued', job_id = $2, worker_id = NULL, heartbeat_at = now(), requeue_count = requeue_count + $3
       WHERE id = $1`,
      [run.id, jobId, count ? 1 : 0],
    );
    await queue.enqueue(RUN_QUEUE, { run_id: run.id }, { tx: tx as QueryClient, id: jobId });
    return 'requeued';
  }
  await tx.query(
    `UPDATE runs SET state = 'failed', outcome = 'failed', failure_class = 'transient', retryable = $2, error_detail = $3,
       finished_at = now(), duration_ms = (extract(epoch FROM now() - coalesce(started_at, created_at)) * 1000)::int
     WHERE id = $1`,
    [run.id, !run.allow_write_actions, detail],
  );
  return 'failed';
}

async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    await client.query('ROLLBACK').then(
      () => client.release(),
      (e: Error) => client.release(e),
    );
    throw error;
  }
}

/**
 * Remise en file par le worker qui s'arrête (SIGTERM, délai dépassé), fenêtrée par `job_id`. Une API qui écrit n'est pas
 * rejouée : `failed` (`transient`, `detail`). `null` : le run n'était plus à ce job.
 */
export async function requeueRun(
  pool: pg.Pool,
  queue: JobQueue,
  args: { runId: string; jobId: string; detail: string },
): Promise<'requeued' | 'failed' | null> {
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<OrphanRow>(
      `SELECT r.id, r.state, r.job_id, r.requeue_count, a.allow_write_actions FROM runs r JOIN apis a ON a.id = r.api_id
       WHERE r.id = $1 AND r.job_id = $2 AND r.state = ANY($3::text[]) FOR UPDATE OF r`,
      [args.runId, args.jobId, ['running', 'waiting_tunnel']],
    );
    const run = rows[0];
    return run ? reclaim(tx, queue, run, args.detail, false) : null;
  });
}

export type SweepResult = { requeued: string[]; failed: string[] };

/**
 * Balayeur (03 § Services, toutes les 60 s ; T2 R2) : reprend les runs orphelins.
 * - `running` / `waiting_tunnel` sans battement depuis `staleSeconds` (worker tué, `kill -9`) ;
 * - `queued` depuis `staleSeconds` dont le job n'est plus vivant (terminé, échoué, annulé ou absent).
 * Sûr à plusieurs instances : `FOR UPDATE SKIP LOCKED`, une transaction par passage.
 */
export async function sweepOrphans(
  pool: pg.Pool,
  queue: JobQueue,
  options: { staleSeconds?: number; limit?: number } = {},
): Promise<SweepResult> {
  const stale = options.staleSeconds ?? RUN_DEFAULTS.staleSeconds;
  const limit = options.limit ?? 100;
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<OrphanRow>(
      `SELECT r.id, r.state, r.job_id, r.requeue_count, a.allow_write_actions FROM runs r JOIN apis a ON a.id = r.api_id
       WHERE r.state = ANY($1::text[]) AND r.paused_at IS NULL AND coalesce(r.heartbeat_at, r.created_at) < now() - make_interval(secs => $2)
       ORDER BY r.state = 'queued', coalesce(r.heartbeat_at, r.created_at) LIMIT $3 FOR UPDATE OF r SKIP LOCKED`,
      [ACTIVE, stale, limit],
    );
    const result: SweepResult = { requeued: [], failed: [] };
    for (const run of rows) {
      if (run.state === 'queued' && run.job_id) {
        const state = await queue.jobState(RUN_QUEUE, run.job_id, { tx: tx as QueryClient });
        // Job vivant : en attente de place, ou pris et pas encore réclamé (pg-boss l'échouera s'il perd son battement).
        if (state === 'created' || state === 'retry' || state === 'active') continue;
      }
      const outcome = await reclaim(tx, queue, run, RUN_LOST_DETAIL, true);
      result[outcome].push(run.id);
    }
    return result;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Bail de réparation (T2 R5) : en table, expire seul, jamais de verrou de session.
// ---------------------------------------------------------------------------------------------------------------

/** Prend (ou renouvelle, pour le même titulaire) le bail de réparation d'une API. false : tenu par un autre. */
export async function acquireRepairLease(db: Queryable, apiId: string, owner: string, ttlSeconds = 90): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE apis SET repair_lease_owner = $2, repair_lease_until = now() + make_interval(secs => $3)
     WHERE id = $1 AND (repair_lease_owner IS NULL OR repair_lease_owner = $2 OR repair_lease_until < now())`,
    [apiId, owner, ttlSeconds],
  );
  return rowCount === 1;
}

/** Renouvelle le bail tenu par `owner`. false : perdu (expiré puis pris par un autre) → cesser la réparation. */
export async function renewRepairLease(db: Queryable, apiId: string, owner: string, ttlSeconds = 90): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE apis SET repair_lease_until = now() + make_interval(secs => $3)
     WHERE id = $1 AND repair_lease_owner = $2 AND repair_lease_until >= now()`,
    [apiId, owner, ttlSeconds],
  );
  return rowCount === 1;
}

export async function releaseRepairLease(db: Queryable, apiId: string, owner: string): Promise<void> {
  await db.query('UPDATE apis SET repair_lease_owner = NULL, repair_lease_until = NULL WHERE id = $1 AND repair_lease_owner = $2', [apiId, owner]);
}

// ---------------------------------------------------------------------------------------------------------------
// worker_heartbeats (14 § 3 et § 9) : une ligne par worker, mise à jour toutes les 15 s.
// ---------------------------------------------------------------------------------------------------------------

export type WorkerBeat = { workerId: string; version: string; draining?: boolean; browserContexts?: number; rssMb?: number | null };

export async function beatWorker(db: Queryable, beat: WorkerBeat): Promise<void> {
  await db.query(
    `INSERT INTO worker_heartbeats (worker_id, version, draining, browser_contexts, rss_mb)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now(), version = EXCLUDED.version, draining = EXCLUDED.draining,
       browser_contexts = EXCLUDED.browser_contexts, rss_mb = EXCLUDED.rss_mb`,
    [beat.workerId, beat.version, beat.draining ?? false, beat.browserContexts ?? 0, beat.rssMb ?? null],
  );
}

export async function removeWorkerBeat(db: Queryable, workerId: string): Promise<void> {
  await db.query('DELETE FROM worker_heartbeats WHERE worker_id = $1', [workerId]);
}
