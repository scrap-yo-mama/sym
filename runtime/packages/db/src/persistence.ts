// SPDX-License-Identifier: AGPL-3.0-only
// Mode « SYM ne lâche pas » (tâche 2.16, D-49, 04 §6, migration 0019) : une API en `erreur` est ré-enquêtée seule à 1 h,
// 6 h, 24 h puis chaque jour, par les transitions existantes 16 puis 1 ou 21 (4 ou 3 sur un refus) ; aucune transition
// nouvelle. Les décisions sont celles, pures, de `@runtime/core` (persistence) ; ce module les applique en base :
// - `setPersistenceMode` : bascule comme le propriétaire (RLS), console seulement pour activer, chaque bascule auditée ;
// - `onPersistenceTransitions` (depuis `notifyStatusChange`, même COMMIT que la transition) : ouvre le cycle à l'entrée en
//   `erreur` par la 13 (classe de la 16 seulement), le ferme sur un retour à `sain` ou un passage en `bloquee` /
//   `action_requise` hors tentative ;
// - `runPersistenceAttempt` (job `persistence-attempt`, unique par API) : relit tout en base, reporte sans compter
//   (disjoncteur, `Retry-After`, bail de réparation, créneau du domaine), sinon applique la 16 et met en file une
//   ré-enquête sur le schéma VALIDÉ (contrat inchangé, INV1), sous le bail de réparation ;
// - `settlePersistenceAttempt` (depuis `finishRunAndNotify`, même COMMIT que la clôture du run) : issue de la tentative,
//   webhook `api.persistence_attempt`, créneau suivant ou fin du mode ; un refus arrête aussi le mode des autres API du
//   même domaine enregistrable. SYM ne relance jamais un « non ».
// L'horloge est injectée (`now`) : les créneaux suivent l'horloge simulée des tests.
import {
  BLOCKING_CLASSES,
  decidePersistenceActivation,
  INVESTIGATION_ACTION_CLASSES,
  effectivePersistenceBudgetUsd,
  isFailureClass,
  PERSISTENCE_DEFAULTS,
  persistenceAttemptOutcome,
  persistenceAttemptPayload,
  persistenceCapReached,
  persistenceDeferral,
  persistenceDelayMs,
  persistenceEntry,
  registrableDomain,
  type FailureClass,
  type JobQueue,
  type PersistenceActivationDecision,
  type PersistenceAttemptWebhookOutcome,
  type PersistenceEnded,
  type PersistencePolicy,
  type QueryClient,
  type QueueDefinition,
} from '@runtime/core';
import type pg from 'pg';
import { appendAudit } from './audit.js';
import { notifyStatusChange, toStatusTransitions } from './notify.js';
import { withActor } from './rls.js';
import { createRun } from './runs.js';
import { applyStatusTransitionInTx } from './status.js';
import { emitWebhookEvent } from './webhooks.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export const PERSISTENCE_QUEUE = 'persistence-attempt';

/** Réveil d'une API : au plus un job en attente par API (politique `short`, clé `persistence:<api>`). */
export function persistenceQueueDefinition(): QueueDefinition {
  return { name: PERSISTENCE_QUEUE, expireInSeconds: 120, heartbeatSeconds: 30, retryLimit: 3, policy: 'short' };
}

export type PersistenceJob = { api_id: string };

/**
 * Mémoire négative (2.12) : les refus connus d'un domaine. Le mode l'exige en service ; elle est relue avant chaque
 * tentative (`prior_refusal`). Tant que 2.12 n'est pas fusionnée, le port par défaut est indisponible : l'activation est
 * refusée (`negative_memory_unavailable`) et aucun cycle ne tente.
 */
export type NegativeMemory = {
  readonly available: boolean;
  priorRefusal(db: Queryable, domain: string): Promise<boolean>;
};
export const NEGATIVE_MEMORY_UNAVAILABLE: NegativeMemory = { available: false, priorRefusal: async () => false };

export type PersistenceContext = {
  queue: JobQueue;
  now?: () => Date;
  /** Créneaux et plafonds (`PERSISTENCE_*`, 14 §2) : lus par le worker au démarrage. */
  policy?: PersistencePolicy;
  random?: () => number;
  negativeMemory?: NegativeMemory;
};

type Resolved = { queue: JobQueue; now: Date; policy: PersistencePolicy; random: () => number; memory: NegativeMemory };
const resolve = (ctx: PersistenceContext): Resolved => ({
  queue: ctx.queue,
  now: (ctx.now ?? (() => new Date()))(),
  policy: ctx.policy ?? PERSISTENCE_DEFAULTS,
  random: ctx.random ?? Math.random,
  memory: ctx.negativeMemory ?? NEGATIVE_MEMORY_UNAVAILABLE,
});

const jobKey = (apiId: string) => `persistence:${apiId}`;
/** Titulaire du bail de réparation pendant une tentative : jamais une tentative et une réparation ensemble. */
const leaseOwner = (apiId: string) => `persistence:${apiId}`;
const usd = (value: string | number | null | undefined): number => Math.round(Number(value ?? 0) * 1e6) / 1e6;

type ApiFacts = {
  id: string;
  owner_id: string;
  slug: string;
  status: string;
  persistence_mode: boolean;
  persistence_budget_usd: string | null;
  budget_daily_usd: string;
  current_strategy_version: number | null;
  output_schema: unknown;
  investigation: { request?: { url?: string; timeout_s?: number } & Record<string, unknown> } & Record<string, unknown> | null;
  repair_lease_owner: string | null;
  lease_held: boolean;
};

async function loadApi(db: Queryable, apiId: string, lock: boolean): Promise<ApiFacts | null> {
  const { rows } = await db.query<ApiFacts>(
    `SELECT id, owner_id, slug, status, persistence_mode, persistence_budget_usd::text, budget_daily_usd::text, current_strategy_version,
       output_schema, investigation, repair_lease_owner, (repair_lease_owner IS NOT NULL AND repair_lease_until >= now()) AS lease_held
     FROM apis WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [apiId],
  );
  return rows[0] ?? null;
}

/** Domaine enregistrable de l'API (page de la demande d'enquête), clé du créneau et de la cadence. `null` : aucune demande. */
function domainOf(api: ApiFacts): string | null {
  const url = api.investigation?.request?.url;
  if (typeof url !== 'string') return null;
  try {
    return registrableDomain(url);
  } catch {
    return null;
  }
}

type CycleRow = {
  api_id: string;
  domain: string;
  entered_error_at: Date;
  failure_class: string | null;
  attempt: number;
  next_at: Date | null;
  run_id: string | null;
  spent_usd: string;
  ended: PersistenceEnded | null;
};

async function loadCycle(db: Queryable, where: 'api_id' | 'run_id', id: string): Promise<CycleRow | null> {
  const { rows } = await db.query<CycleRow>(
    `SELECT api_id, domain, entered_error_at, failure_class, attempt, next_at, run_id, spent_usd::text, ended FROM api_persistence WHERE ${where} = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

async function wake(db: Queryable, r: Resolved, apiId: string, at: Date): Promise<void> {
  const seconds = Math.max(0, Math.ceil((at.getTime() - r.now.getTime()) / 1000));
  await r.queue.enqueueOnce(PERSISTENCE_QUEUE, { api_id: apiId } satisfies PersistenceJob, { singletonKey: jobKey(apiId), startAfterSeconds: seconds, tx: db as QueryClient });
}

async function announce(
  db: Queryable,
  r: Resolved,
  api: Pick<ApiFacts, 'id' | 'owner_id' | 'slug'>,
  input: { runId: string | null; attempt: number; outcome: PersistenceAttemptWebhookOutcome; reason: string | null; nextAt: Date | null; spentUsd: number; ended: PersistenceEnded | null },
): Promise<void> {
  await emitWebhookEvent(db, r.queue, {
    event: 'api.persistence_attempt',
    payload: persistenceAttemptPayload(r.now, {
      api: api.slug,
      api_id: api.id,
      run_id: input.runId,
      attempt: input.attempt,
      outcome: input.outcome,
      reason: input.reason,
      next_at: input.nextAt,
      spent_usd: input.spentUsd,
      ended: input.ended,
    }),
    ownerIds: [api.owner_id],
    now: r.now,
  });
}

/** Fin du mode : plus de créneau, plus de tentative en cours ; le bouton Ré-enquêter reste. */
async function endCycle(db: Queryable, r: Resolved, api: Pick<ApiFacts, 'id' | 'owner_id' | 'slug'>, cycle: CycleRow, ended: PersistenceEnded, reason: string, spentUsd: number, webhookReason: string = reason): Promise<void> {
  await db.query(
    `UPDATE api_persistence SET ended = $2, ended_reason = $3, last_outcome = $4, next_at = NULL, run_id = NULL, spent_usd = $5, updated_at = $6 WHERE api_id = $1`,
    [api.id, ended, ended === 'exhausted' ? 'persistence_exhausted' : reason, webhookReason, spentUsd, r.now],
  );
  await announce(db, r, api, { runId: cycle.run_id, attempt: cycle.attempt, outcome: ended, reason: webhookReason, nextAt: null, spentUsd, ended });
}

// ---------------------------------------------------------------------------------------------------------------
// Entrée en `erreur`
// ---------------------------------------------------------------------------------------------------------------

type EntryFacts = { failureClass: FailureClass | null; detail: string | null; at: Date };

/**
 * Classe qui a mis l'API en `erreur` : entrée par la 13 (réparation abandonnée) → classe de la 10 ou de la 11 qui l'a
 * précédée, et le code de journal de son run (`geo_restriction`, `not_compilable`). Toute autre entrée : inconnue.
 */
async function entryFacts(db: Queryable, apiId: string): Promise<EntryFacts | null> {
  const { rows } = await db.query<{ id: string; from_status: string | null; at: Date }>(
    "SELECT id, from_status, at FROM status_events WHERE api_id = $1 AND to_status = 'erreur' ORDER BY id DESC LIMIT 1",
    [apiId],
  );
  const into = rows[0];
  if (into === undefined || into.from_status !== 'reparation') return null;
  const cause = await db.query<{ reason: string | null; failure_class: string | null; error_detail: string | null }>(
    `SELECT e.reason, r.failure_class, r.error_detail FROM status_events e LEFT JOIN runs r ON r.id = e.run_id
     WHERE e.api_id = $1 AND e.to_status = 'reparation' AND e.id < $2 ORDER BY e.id DESC LIMIT 1`,
    [apiId, into.id],
  );
  const c = cause.rows[0];
  const cls = c?.reason ?? c?.failure_class ?? null;
  return { failureClass: isFailureClass(cls) ? cls : null, detail: c?.error_detail ?? null, at: into.at };
}

/**
 * Ouvre le cycle d'une API en `erreur` dont le mode est actif : premier créneau (1 h) et réveil, ou fin immédiate
 * (`ineligible`) si la classe d'entrée n'est pas une classe de la 16 (géo-restriction, `not_compilable`, `not_found`…).
 */
async function openCycle(db: Queryable, r: Resolved, apiId: string): Promise<void> {
  const api = await loadApi(db, apiId, false);
  if (api === null || !api.persistence_mode || api.status !== 'erreur' || api.current_strategy_version === null) return;
  const current = await loadCycle(db, 'api_id', apiId);
  if (current !== null && current.ended === null) return;
  const facts = await entryFacts(db, apiId);
  const domain = domainOf(api);
  const entry =
    domain === null ? ({ eligible: false, reason: 'no_investigation_request' } as const)
    : facts === null ? ({ eligible: false, reason: 'entry_class_unknown' } as const)
    : persistenceEntry({ failureClass: facts.failureClass, detail: facts.detail });
  const enteredAt = facts?.at ?? r.now;
  const nextAt = entry.eligible ? new Date(Math.max(r.now.getTime(), enteredAt.getTime() + persistenceDelayMs(r.policy, 0, r.random))) : null;
  await db.query(
    `INSERT INTO api_persistence (api_id, domain, entered_error_at, failure_class, attempt, next_at, run_id, spent_usd, last_outcome, ended, ended_reason, updated_at)
     VALUES ($1, $2, $3, $4, 0, $5, NULL, 0, NULL, $6, $7, $8)
     ON CONFLICT (api_id) DO UPDATE SET domain = EXCLUDED.domain, entered_error_at = EXCLUDED.entered_error_at, failure_class = EXCLUDED.failure_class,
       attempt = 0, next_at = EXCLUDED.next_at, run_id = NULL, spent_usd = 0, last_outcome = NULL, ended = EXCLUDED.ended,
       ended_reason = EXCLUDED.ended_reason, updated_at = EXCLUDED.updated_at`,
    [apiId, domain ?? '', enteredAt, facts?.failureClass ?? null, nextAt, entry.eligible ? null : 'ineligible', entry.eligible ? null : entry.reason, r.now],
  );
  if (nextAt !== null) {
    await wake(db, r, apiId, nextAt);
    return;
  }
  await announce(db, r, api, { runId: null, attempt: 0, outcome: 'ineligible', reason: entry.eligible ? null : entry.reason, nextAt: null, spentUsd: 0, ended: 'ineligible' });
}

/**
 * Transitions annoncées (`notifyStatusChange`, même transaction) : la 13 ouvre le cycle ; hors tentative, un retour à
 * `sain` ou `warning` le clôt et un passage en `bloquee` ou `action_requise` arrête le mode. L'issue d'une tentative en
 * cours (16 puis 1, 21, 4 ou 3) est réglée à la clôture de son run (`settlePersistenceAttempt`).
 */
export async function onPersistenceTransitions(db: Queryable, ctx: PersistenceContext, apiId: string, transitions: readonly { from: string | null; to: string; reason: string | null }[]): Promise<void> {
  if (transitions.length === 0) return;
  const r = resolve(ctx);
  for (const t of transitions) {
    if (t.to === 'erreur' && t.from === 'reparation') {
      await openCycle(db, r, apiId);
      continue;
    }
    if (t.to === 'erreur' || t.to === 'enquete' || t.to === 'reparation') continue;
    const cycle = await loadCycle(db, 'api_id', apiId);
    if (cycle === null || cycle.ended !== null || cycle.run_id !== null) continue;
    if (t.to === 'sain' || t.to === 'warning') {
      await db.query('DELETE FROM api_persistence WHERE api_id = $1', [apiId]);
    } else {
      const api = await loadApi(db, apiId, false);
      if (api !== null) await endCycle(db, r, api, cycle, 'refused', t.reason ?? t.to, usd(cycle.spent_usd));
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bascule (console seulement pour activer)
// ---------------------------------------------------------------------------------------------------------------

export class PersistenceApiNotFoundError extends Error {
  override name = 'PersistenceApiNotFoundError';
}

export type PersistenceToggle = {
  apiId: string;
  /** `ui` : session console (acte humain explicite) ; `apikey` et `mcp` ne peuvent que désactiver. */
  actor: { userId: string; via: 'ui' | 'apikey' | 'mcp'; ref?: string | null; role?: 'member' | 'admin' | 'owner' };
  enable?: boolean;
  /** Plafond propre ; `null` = `PERSISTENCE_BUDGET_USD_DEFAULT`. Absent : inchangé. */
  budgetUsd?: number | null;
};

/**
 * `PATCH /api/apis/{slug}` (`persistence_mode`, `persistence_budget_usd`) : comme le propriétaire (RLS, INV12). Activer
 * (ou changer le plafond d'un mode actif) exige une session console (`403 human_confirmation_required`), une version
 * courante, la mémoire négative en service et un plafond effectif > 0 (`409 persistence_not_eligible`) ; désactiver est
 * permis à toute clé du scope. Chaque bascule, refusée ou non, est inscrite dans `audit_events` avec son acteur. Activé
 * sur une API déjà en `erreur`, le cycle s'ouvre aussitôt (durée et dépense comptées depuis l'entrée en `erreur`).
 */
export async function setPersistenceMode(pool: pg.Pool, ctx: PersistenceContext, input: PersistenceToggle): Promise<PersistenceActivationDecision> {
  const r = resolve(ctx);
  const { actor } = input;
  return withActor(pool, { userId: actor.userId, role: actor.role ?? 'member' }, async (tx) => {
    const { rows } = await tx.query<{ persistence_mode: boolean; persistence_budget_usd: string | null; current_strategy_version: number | null; status: string }>(
      'SELECT persistence_mode, persistence_budget_usd::text, current_strategy_version, status FROM apis WHERE id = $1 AND owner_id = $2 FOR UPDATE',
      [input.apiId, actor.userId],
    );
    const api = rows[0];
    if (api === undefined) throw new PersistenceApiNotFoundError('API introuvable pour ce propriétaire');
    const enable = input.enable ?? api.persistence_mode;
    const budget = input.budgetUsd === undefined ? (api.persistence_budget_usd === null ? null : Number(api.persistence_budget_usd)) : input.budgetUsd;
    const costly = enable && (input.enable === true || input.budgetUsd !== undefined);
    let decision: PersistenceActivationDecision = decidePersistenceActivation({
      enable: costly,
      actor: actor.via === 'ui' ? 'console' : actor.via,
      hasCurrentVersion: api.current_strategy_version !== null,
      negativeMemoryAvailable: r.memory.available,
      effectiveBudgetUsd: effectivePersistenceBudgetUsd(r.policy, budget),
    });
    // Un plafond propre nul ou négatif ne s'enregistre jamais, même avec le mode coupé.
    if (decision.ok && budget !== null && !(budget > 0)) decision = { ok: false, status: 409, code: 'persistence_not_eligible', reason: 'budget_not_positive' };
    const audit = (outcome: 'success' | 'denied') =>
      appendAudit(tx, {
        actorUserId: actor.userId,
        actorVia: actor.via,
        actorRef: actor.ref ?? null,
        action: enable ? 'api.persistence_enable' : 'api.persistence_disable',
        targetType: 'api',
        targetId: input.apiId,
        outcome,
        meta: decision.ok ? { budget_usd: budget } : { code: decision.code, ...('reason' in decision ? { reason: decision.reason } : {}) },
      });
    if (!decision.ok) {
      await audit('denied');
      return decision;
    }
    await tx.query('UPDATE apis SET persistence_mode = $2, persistence_budget_usd = $3, updated_at = now() WHERE id = $1', [input.apiId, enable, budget]);
    if (enable && !api.persistence_mode && api.status === 'erreur') await openCycle(tx, r, input.apiId);
    if (!enable && api.persistence_mode) {
      // Plus aucun créneau ; une tentative déjà partie finit normalement (transitions ordinaires), sans relance.
      await tx.query('DELETE FROM api_persistence WHERE api_id = $1', [input.apiId]);
    }
    await audit('success');
    return decision;
  });
}

export type ApiPersistenceState = {
  enabled: boolean;
  /** Plafond effectif (jamais illimité). */
  budget_usd: number;
  attempt: number;
  next_at: string | null;
  spent_usd: number;
  in_progress: boolean;
  entered_error_at: string | null;
  ended: PersistenceEnded | null;
  ended_reason: string | null;
};

/**
 * État `Api.persistence` (fiche API : prochain essai, dépense) dans la transaction de l'appelant, lu comme le propriétaire
 * (RLS : `api_persistence` n'est lisible que de lui). `null` : API introuvable pour lui.
 */
export async function persistenceStateOf(db: Queryable, input: { apiId: string; userId: string }, policy: PersistencePolicy = PERSISTENCE_DEFAULTS): Promise<ApiPersistenceState | null> {
  const { rows } = await db.query<{
    persistence_mode: boolean;
    persistence_budget_usd: string | null;
    attempt: number | null;
    next_at: Date | null;
    spent_usd: string | null;
    run_id: string | null;
    entered_error_at: Date | null;
    ended: PersistenceEnded | null;
    ended_reason: string | null;
  }>(
    `SELECT a.persistence_mode, a.persistence_budget_usd::text, p.attempt, p.next_at, p.spent_usd::text, p.run_id, p.entered_error_at, p.ended, p.ended_reason
     FROM apis a LEFT JOIN api_persistence p ON p.api_id = a.id WHERE a.id = $1 AND a.owner_id = $2`,
    [input.apiId, input.userId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    enabled: row.persistence_mode,
    budget_usd: effectivePersistenceBudgetUsd(policy, row.persistence_budget_usd === null ? null : Number(row.persistence_budget_usd)),
    attempt: row.attempt ?? 0,
    next_at: row.next_at?.toISOString() ?? null,
    spent_usd: usd(row.spent_usd),
    in_progress: row.run_id !== null,
    entered_error_at: row.entered_error_at?.toISOString() ?? null,
    ended: row.ended,
    ended_reason: row.ended_reason,
  };
}

/** `persistenceStateOf` dans sa propre transaction, comme le propriétaire. */
export async function readPersistenceState(pool: pg.Pool, input: { apiId: string; userId: string }, policy: PersistencePolicy = PERSISTENCE_DEFAULTS): Promise<ApiPersistenceState | null> {
  return withActor(pool, { userId: input.userId, role: 'member' }, (tx) => persistenceStateOf(tx, input, policy));
}

// ---------------------------------------------------------------------------------------------------------------
// Tentative
// ---------------------------------------------------------------------------------------------------------------

const ACTIVE_RUN_STATES: readonly string[] = ['queued', 'running', 'waiting_tunnel'];

export type PersistenceTick =
  | { kind: 'idle'; reason: string }
  | { kind: 'not_due'; nextAt: Date }
  | { kind: 'deferred'; reason: 'circuit_open' | 'retry_after' | 'repair_lease' | 'domain_slot'; until: Date }
  | { kind: 'ended'; ended: PersistenceEnded; reason: string }
  | { kind: 'launched'; runId: string; attempt: number };

async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Dépense de l'API sur le jour (UTC) de l'horloge : runs de toute nature, tentatives comprises. */
async function dailySpentUsd(db: Queryable, apiId: string, now: Date): Promise<number> {
  const { rows } = await db.query<{ spent: string }>(
    `SELECT coalesce(sum(cost_llm_usd + cost_proxy_usd), 0)::text AS spent FROM runs
     WHERE api_id = $1 AND created_at >= date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND created_at <= $2`,
    [apiId, now],
  );
  return usd(rows[0]?.spent);
}

/**
 * Une passe du job `persistence-attempt` pour une API (identité système). Idempotent : tout est relu en base sous verrou ;
 * un second passage pendant une tentative ne lance rien. Ordre : cycle et statut (`erreur` seulement, jamais `bloquee`
 * ni `action_requise`), échéance, plafonds, mémoire négative, reports sans compter, puis la tentative.
 */
export async function runPersistenceAttempt(pool: pg.Pool, ctx: PersistenceContext, apiId: string): Promise<PersistenceTick> {
  const r = resolve(ctx);
  return inTransaction(pool, async (tx) => {
    const cycle = await loadCycle(tx, 'api_id', apiId);
    if (cycle === null) return { kind: 'idle', reason: 'no_cycle' };
    if (cycle.ended !== null) return { kind: 'idle', reason: `ended_${cycle.ended}` };
    if (cycle.run_id !== null) {
      // Tentative finie sans clôture annoncée (run annulé, repris puis abandonné) : réglée ici, jamais figée « en cours ».
      const run = (await tx.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [cycle.run_id])).rows[0];
      if (run !== undefined && ACTIVE_RUN_STATES.includes(run.state)) return { kind: 'idle', reason: 'attempt_in_progress' };
      await settlePersistenceAttempt(tx, ctx, cycle.run_id);
      return { kind: 'idle', reason: 'attempt_settled' };
    }
    const api = await loadApi(tx, apiId, true);
    if (api === null || !api.persistence_mode) return { kind: 'idle', reason: 'mode_disabled' };
    if (api.status !== 'erreur') return { kind: 'idle', reason: `status_${api.status}` };
    // Propriétaire désactivé ou supprimé (SQL, CLI, admin) : plus rien en son nom — ni trafic, ni dépense (13 § 6).
    const owner = (await tx.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [api.owner_id])).rows[0];
    if (owner?.status !== 'active') {
      await endCycle(tx, r, api, cycle, 'ineligible', 'owner_inactive', usd(cycle.spent_usd));
      return { kind: 'ended', ended: 'ineligible', reason: 'owner_inactive' };
    }
    const nextAt = cycle.next_at ?? new Date(cycle.entered_error_at.getTime() + persistenceDelayMs(r.policy, cycle.attempt, r.random));
    if (r.now.getTime() < nextAt.getTime()) {
      await wake(tx, r, apiId, nextAt);
      return { kind: 'not_due', nextAt };
    }
    const spent = usd(cycle.spent_usd);
    const modeBudgetUsd = effectivePersistenceBudgetUsd(r.policy, api.persistence_budget_usd === null ? null : Number(api.persistence_budget_usd));
    const dailySpent = await dailySpentUsd(tx, apiId, r.now);
    const cap = persistenceCapReached({
      now: r.now,
      enteredErrorAt: cycle.entered_error_at,
      spentUsd: spent,
      budgetUsd: modeBudgetUsd,
      dailySpentUsd: dailySpent,
      budgetDailyUsd: Number(api.budget_daily_usd),
      maxDays: r.policy.maxDays,
    });
    if (cap !== null) {
      await endCycle(tx, r, api, cycle, 'exhausted', 'persistence_exhausted', spent, cap);
      return { kind: 'ended', ended: 'exhausted', reason: cap };
    }
    if (!r.memory.available) {
      await endCycle(tx, r, api, cycle, 'ineligible', 'negative_memory_unavailable', spent);
      return { kind: 'ended', ended: 'ineligible', reason: 'negative_memory_unavailable' };
    }
    if (await r.memory.priorRefusal(tx, cycle.domain)) {
      await endCycle(tx, r, api, cycle, 'refused', 'prior_refusal', spent);
      return { kind: 'ended', ended: 'refused', reason: 'prior_refusal' };
    }
    if (!isFailureClass(cycle.failure_class)) {
      await endCycle(tx, r, api, cycle, 'ineligible', 'entry_class_unknown', spent);
      return { kind: 'ended', ended: 'ineligible', reason: 'entry_class_unknown' };
    }

    // Reports sans compter : cadence du domaine (disjoncteur, Retry-After), bail de réparation, créneau du domaine.
    // Verrou transactionnel par domaine : deux workers ne prennent jamais le même créneau.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('persistence-domain:' || $1))", [cycle.domain]);
    const pacing = (await tx.query<{ circuit_state: 'closed' | 'open' | 'half_open'; circuit_open_until: Date | null; penalty_until: Date | null }>(
      'SELECT circuit_state, circuit_open_until, penalty_until FROM domain_pacing_state WHERE domain = $1',
      [cycle.domain],
    )).rows[0];
    const slot = (await tx.query<{ api_id: string | null; run_id: string | null; slot_until: Date }>('SELECT api_id, run_id, slot_until FROM persistence_domain_slots WHERE domain = $1', [cycle.domain])).rows[0];
    const slotTaken = slot !== undefined && slot.api_id !== apiId && (slot.run_id !== null || slot.slot_until.getTime() > r.now.getTime());
    const deferral = persistenceDeferral({
      now: r.now,
      policy: r.policy,
      circuit: pacing?.circuit_state ?? null,
      circuitOpenUntil: pacing?.circuit_open_until ?? null,
      penaltyUntil: pacing?.penalty_until ?? null,
      leaseHeldByOther: api.lease_held && api.repair_lease_owner !== leaseOwner(apiId),
      // Créneau pris : jusqu'à sa fin, ou un peu plus tard si la tentative qui le tient n'est pas finie.
      domainBusyUntil: slotTaken ? new Date(Math.max(slot.slot_until.getTime(), slot.run_id !== null ? r.now.getTime() + r.policy.busyRetryMs : 0)) : null,
    });
    if (deferral !== null) {
      await tx.query('UPDATE api_persistence SET next_at = $2, last_outcome = $3, updated_at = $4 WHERE api_id = $1', [apiId, deferral.until, `deferred_${deferral.reason}`, r.now]);
      await wake(tx, r, apiId, deferral.until);
      return { kind: 'deferred', reason: deferral.reason, until: deferral.until };
    }

    // La tentative : bail de réparation (durée de l'enquête + marge), créneau du domaine, transition 16, ré-enquête.
    const state = api.investigation;
    const timeout = Number(state?.request?.timeout_s ?? 600);
    const lease = await tx.query(
      `UPDATE apis SET repair_lease_owner = $2, repair_lease_until = now() + make_interval(secs => $3)
       WHERE id = $1 AND (repair_lease_owner IS NULL OR repair_lease_owner = $2 OR repair_lease_until < now())`,
      [apiId, leaseOwner(apiId), timeout + 600],
    );
    if (lease.rowCount !== 1) {
      const until = new Date(r.now.getTime() + r.policy.busyRetryMs);
      await tx.query('UPDATE api_persistence SET next_at = $2, updated_at = $3 WHERE api_id = $1', [apiId, until, r.now]);
      await wake(tx, r, apiId, until);
      return { kind: 'deferred', reason: 'repair_lease', until };
    }
    const step = await applyStatusTransitionInTx(tx, {
      apiId,
      event: { type: 'persistence_attempt', failureClass: cycle.failure_class },
      clock: { now: () => r.now },
      afterTransition: async (client, events) => {
        await notifyStatusChange(client, r.queue, { apiId, runId: null, transitions: toStatusTransitions(events) }, { now: () => r.now, persistence: ctx });
      },
    });
    if (!step.ok) throw new Error(`tentative de persistance refusée par la machine à états : ${step.rejected}`);
    // Ré-enquête sur le schéma VALIDÉ : le contrat ne change jamais par une tentative (INV1). La demande enregistrée
    // (`request`, dont `auto_validate`) reste celle du propriétaire : une ré-enquête ultérieure la réutilise, jamais avec
    // une validation automatique qu'il n'a pas choisie (19 § 6) ; avec `validated_schema` posé, l'exécuteur ne propose
    // aucun schéma. Plafond STRICT de la tentative (`budget_cap_usd`, lu par l'exécuteur) : la demande, le reste du
    // plafond du mode et le reste du budget du jour, jamais au-delà ; une nouvelle enquête repart sans lui.
    const budgetCapUsd = usd(Math.max(0, Math.min(Number(state?.request?.['budget_usd'] ?? Number.POSITIVE_INFINITY), modeBudgetUsd - spent, Number(api.budget_daily_usd) - dailySpent)));
    const next = { ...(state ?? {}), validated_schema: api.output_schema, spent_usd: 0, elapsed_ms: 0, budget_cap_usd: budgetCapUsd };
    await tx.query("UPDATE apis SET investigation = $2::jsonb, investigation_phase = 'testing', updated_at = now() WHERE id = $1", [apiId, JSON.stringify(next)]);
    const { runId } = await createRun(tx, r.queue, { apiId, ownerId: api.owner_id, trigger: 'schedule', kind: 'investigation' });
    await tx.query(
      `INSERT INTO persistence_domain_slots (domain, api_id, run_id, slot_until) VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain) DO UPDATE SET api_id = EXCLUDED.api_id, run_id = EXCLUDED.run_id, slot_until = EXCLUDED.slot_until`,
      [cycle.domain, apiId, runId, new Date(r.now.getTime() + r.policy.domainSlotMs)],
    );
    await tx.query('UPDATE api_persistence SET attempt = attempt + 1, run_id = $2, last_attempt_at = $3, next_at = NULL, last_outcome = NULL, updated_at = $3 WHERE api_id = $1', [apiId, runId, r.now]);
    return { kind: 'launched', runId, attempt: cycle.attempt + 1 };
  });
}

/**
 * Issue d'une tentative, à la clôture de son run (même transaction) : `recovered` (transition 1 déjà appliquée par
 * l'enquête), `retry` (21 : créneau suivant, après `Retry-After`), fin du mode (`refused` après 4, 3 ou 21 sur un 451 ;
 * `ineligible` ; `exhausted` si un plafond est atteint). Bail et créneau du domaine rendus ; webhook
 * `api.persistence_attempt`. Une enquête qui n'a pas appliqué son statut (run tombé hors de l'exécuteur) repasse par la 21.
 */
export async function settlePersistenceAttempt(db: pg.PoolClient, ctx: PersistenceContext, runId: string): Promise<void> {
  const cycle = await loadCycle(db, 'run_id', runId);
  if (cycle === null) return;
  const r = resolve(ctx);
  const apiId = cycle.api_id;
  const { rows } = await db.query<{ state: string; failure_class: string | null; error_detail: string | null; cost: string }>(
    'SELECT state, failure_class, error_detail, (cost_llm_usd + cost_proxy_usd)::text AS cost FROM runs WHERE id = $1',
    [runId],
  );
  const run = rows[0];
  if (run === undefined) return;
  const spent = usd(usd(cycle.spent_usd) + usd(run.cost));
  await db.query('UPDATE apis SET repair_lease_owner = NULL, repair_lease_until = NULL WHERE id = $1 AND repair_lease_owner = $2', [apiId, leaseOwner(apiId)]);
  await db.query('UPDATE persistence_domain_slots SET run_id = NULL WHERE domain = $1 AND run_id = $2', [cycle.domain, runId]);
  let api = await loadApi(db, apiId, true);
  if (api === null) return;
  let outcome = persistenceAttemptOutcome({ state: run.state, failureClass: isFailureClass(run.failure_class) ? run.failure_class : null, detail: run.error_detail });
  if (outcome.kind === 'recovered' && api.status !== 'sain' && api.status !== 'warning') outcome = { kind: 'ended', ended: 'ineligible', reason: 'not_recovered' };
  // Enquête restée en `enquete` (échec hors de l'exécuteur) : un refus suit la 4 ou la 3, tout autre échec la 21 vers
  // `erreur`, jamais la 2. Un arrêt sans classe (proxy, tunnel) est appliqué par le worker (`run_stopped`).
  // Un run annulé n'a pas d'issue d'enquête : il revient aussi en `erreur` par la 21.
  const failureClass = isFailureClass(run.failure_class) ? run.failure_class : null;
  if (api.status === 'enquete' && outcome.kind !== 'recovered' && (failureClass !== null || run.state === 'cancelled')) {
    const refusal = failureClass !== null && ((BLOCKING_CLASSES as readonly string[]).includes(failureClass) || (INVESTIGATION_ACTION_CLASSES as readonly string[]).includes(failureClass));
    await applyStatusTransitionInTx(db, {
      apiId,
      runId,
      event: refusal && failureClass !== null ? { type: 'run_failed', failureClass } : { type: 'investigation_failed', cause: 'budget_exhausted' },
      clock: { now: () => r.now },
      afterTransition: async (client, events) => {
        await notifyStatusChange(client, r.queue, { apiId, runId, transitions: toStatusTransitions(events) }, { now: () => r.now });
      },
    });
    api = (await loadApi(db, apiId, true)) ?? api;
  }
  const settled = { ...cycle, run_id: runId };

  if (outcome.kind === 'recovered') {
    await db.query('DELETE FROM api_persistence WHERE api_id = $1', [apiId]);
    await announce(db, r, api, { runId, attempt: cycle.attempt, outcome: 'recovered', reason: null, nextAt: null, spentUsd: spent, ended: null });
    return;
  }
  if (outcome.kind === 'ended') {
    await endCycle(db, r, api, settled, outcome.ended, outcome.reason, spent);
    // Un « non » vaut pour le domaine : les autres API du domaine enregistrable arrêtent aussi leur mode.
    if (outcome.ended === 'refused') await refuseDomain(db, r, cycle.domain, apiId);
    return;
  }
  const cap = persistenceCapReached({
    now: r.now,
    enteredErrorAt: cycle.entered_error_at,
    spentUsd: spent,
    budgetUsd: effectivePersistenceBudgetUsd(r.policy, api.persistence_budget_usd === null ? null : Number(api.persistence_budget_usd)),
    dailySpentUsd: 0,
    budgetDailyUsd: Number.POSITIVE_INFINITY,
    maxDays: r.policy.maxDays,
  });
  if (cap !== null) {
    await endCycle(db, r, api, settled, 'exhausted', 'persistence_exhausted', spent, cap);
    return;
  }
  // Créneau suivant, jamais avant la fin d'une pénalité `Retry-After` du domaine (429).
  const penalty = (await db.query<{ penalty_until: Date | null }>('SELECT penalty_until FROM domain_pacing_state WHERE domain = $1', [cycle.domain])).rows[0]?.penalty_until ?? null;
  const scheduled = r.now.getTime() + persistenceDelayMs(r.policy, cycle.attempt, r.random);
  const nextAt = new Date(Math.max(scheduled, penalty?.getTime() ?? 0));
  await db.query('UPDATE api_persistence SET run_id = NULL, next_at = $2, spent_usd = $3, last_outcome = $4, updated_at = $5 WHERE api_id = $1', [apiId, nextAt, spent, outcome.reason, r.now]);
  await wake(db, r, apiId, nextAt);
  await announce(db, r, api, { runId, attempt: cycle.attempt, outcome: 'retry', reason: outcome.reason, nextAt, spentUsd: spent, ended: null });
}

async function refuseDomain(db: Queryable, r: Resolved, domain: string, except: string): Promise<void> {
  const { rows } = await db.query<{ api_id: string }>('SELECT api_id FROM api_persistence WHERE domain = $1 AND api_id <> $2 AND ended IS NULL ORDER BY api_id FOR UPDATE', [domain, except]);
  for (const { api_id } of rows) {
    const cycle = await loadCycle(db, 'api_id', api_id);
    const api = await loadApi(db, api_id, false);
    // Une tentative en cours sur une autre API du domaine finit d'elle-même (son issue lit le même refus).
    if (cycle === null || api === null || cycle.run_id !== null) continue;
    await endCycle(db, r, api, cycle, 'refused', 'prior_refusal', usd(cycle.spent_usd));
  }
}

/**
 * Filet du réveil : toute API dont le créneau est échu, ou dont la tentative est finie sans avoir été réglée (run annulé),
 * reçoit un job ; un job perdu ne fige jamais un cycle.
 */
export async function sweepDuePersistence(pool: pg.Pool, ctx: PersistenceContext): Promise<number> {
  const r = resolve(ctx);
  const { rows } = await pool.query<{ api_id: string }>(
    `SELECT p.api_id FROM api_persistence p LEFT JOIN runs x ON x.id = p.run_id
     WHERE p.ended IS NULL AND ((p.run_id IS NULL AND p.next_at <= $1) OR (p.run_id IS NOT NULL AND x.state <> ALL($2::text[])))
     ORDER BY p.next_at NULLS FIRST LIMIT 500`,
    [r.now, ACTIVE_RUN_STATES],
  );
  for (const row of rows) await wake(pool, r, row.api_id, r.now);
  return rows.length;
}
