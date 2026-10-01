// SPDX-License-Identifier: AGPL-3.0-only
// Planification (tâche 2.5, 08 § 5, T2 R3) :
// - `schedules` est la source de vérité ; pg-boss n'en est que le miroir (`key = schedules.id`), reconstruit au démarrage
//   (`reconcileSchedules`) : lignes actives → `schedule()`, clés absentes ou désactivées → `unschedule()` ;
// - un passage cron produit UN job `scheduled-run` par occurrence (verrou en base + créneau d'unicité de pg-boss) : deux
//   workers ne déclenchent jamais deux fois ; `missed: 'once'` rattrape une occurrence manquée pendant un déploiement ;
// - `handleScheduledRun` relit la ligne (aucune règle copiée dans le job), évalue les règles et crée le run, ou trace un
//   run `skipped_*` avec son motif. Un rejeu du même job ne crée rien (`runs.schedule_job_id` unique).
// Identité : système (connexion propriétaire des tables). Le run créé appartient au propriétaire de la planification.
import {
  evaluateScheduleRules,
  MIN_SCHEDULE_PERIOD_MS,
  parseScheduleRules,
  resolveScheduleInput,
  SCHEDULE_MISSED,
  SCHEDULE_OVERLAPS,
  SCHEDULED_RUN_QUEUE,
  quietPeriodMs,
  type ApiStatus,
  type JobQueue,
  type QueueDefinition,
  type QueryClient,
  type ScheduleMissed,
  type ScheduleOverlap,
  type ScheduledRunJobData,
  type ScheduleRules,
} from '@runtime/core';
import type pg from 'pg';
import { createRun, recordSkippedRun, type ScheduleOrigin } from './runs.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** File déjà alimentée par le cron : standard (jamais `short`, qui n'admet qu'un job en attente par clé et ici il n'y en a pas). */
export function scheduledRunQueueDefinition(): QueueDefinition {
  return { name: SCHEDULED_RUN_QUEUE, expireInSeconds: 120, heartbeatSeconds: 30, retryLimit: 3, policy: 'standard' };
}

/** Occurrence remise à plus tard (`overlap: queue`) : au plus un report en attente par planification (politique `short` + clé). */
export const SCHEDULED_RUN_DEFERRED_QUEUE = 'scheduled-run-deferred';
export function scheduledRunDeferredQueueDefinition(): QueueDefinition {
  return { name: SCHEDULED_RUN_DEFERRED_QUEUE, expireInSeconds: 120, heartbeatSeconds: 30, retryLimit: 3, policy: 'short' };
}

export const DEFER_SECONDS = 30;
/** Au-delà (1 h de reports), l'occurrence est abandonnée : `skipped_overlap`. */
export const MAX_DEFERRALS = 120;
/** Un tunnel est « en ligne » si son dernier signe de vie date de moins de 60 s (ping de 20 s, 3 pings). */
export const TUNNEL_ONLINE_SECONDS = 60;

export type ScheduleRow = {
  id: string;
  api_id: string;
  owner_id: string;
  cron: string;
  timezone: string;
  input: unknown;
  rules: unknown;
  overlap: ScheduleOverlap;
  on_missed: ScheduleMissed;
  enabled: boolean;
};

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------

export type ScheduleSpec = {
  cron: string;
  timezone?: string;
  input?: unknown;
  rules?: unknown;
  overlap?: ScheduleOverlap;
  onMissed?: ScheduleMissed;
  enabled?: boolean;
};

export type ValidSchedule = {
  cron: string;
  timezone: string;
  input: unknown;
  rules: ScheduleRules;
  overlap: ScheduleOverlap;
  onMissed: ScheduleMissed;
  enabled: boolean;
  /** Prochaines occurrences (aide à la saisie, calculées sans toucher la base). */
  next: Date[];
};

/**
 * Valide une planification avant écriture : cron à 5 champs (fréquence minimale 1 min : pas de secondes, pas de RRULE),
 * fuseau IANA, règles (vocabulaire fermé, `bloquee` non retirable), `overlap`, `missed`. `missed` par défaut : `once` si les
 * occurrences sont espacées d'au moins 1 h (un rattrapage vaut mieux qu'un trou silencieux), `skip` sinon (pas de rafale).
 */
export function validateSchedule(queue: Pick<JobQueue, 'previewSchedule'>, spec: ScheduleSpec, from: Date = new Date()): { ok: true; schedule: ValidSchedule } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const cron = spec.cron.trim().replace(/\s+/g, ' ');
  const timezone = spec.timezone ?? 'UTC';
  let next: Date[] = [];
  if (cron.split(' ').length !== 5) {
    errors.push('cron : 5 champs attendus (minute heure jour mois jour-de-semaine) ; fréquence minimale 1 minute, pas de secondes ni de RRULE');
  } else {
    try {
      next = queue.previewSchedule(cron, { timezone, count: 5, from });
      if (next.length === 0) errors.push('cron : aucune occurrence à venir');
    } catch (error) {
      errors.push(`cron ou fuseau invalide : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const parsed = parseScheduleRules(spec.rules);
  if (!parsed.ok) errors.push(...parsed.errors);
  const overlap = spec.overlap ?? 'skip';
  if (!(SCHEDULE_OVERLAPS as readonly string[]).includes(overlap)) errors.push(`overlap : ${SCHEDULE_OVERLAPS.join(' | ')} attendu`);
  if (spec.onMissed !== undefined && !(SCHEDULE_MISSED as readonly string[]).includes(spec.onMissed)) errors.push(`missed : ${SCHEDULE_MISSED.join(' | ')} attendu`);
  if (errors.length > 0 || !parsed.ok) return { ok: false, errors };
  const gaps = next.slice(1).map((d, i) => d.getTime() - (next[i] as Date).getTime());
  const minGap = gaps.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...gaps);
  if (minGap < MIN_SCHEDULE_PERIOD_MS) return { ok: false, errors: ['cron : fréquence minimale 1 minute'] };
  return {
    ok: true,
    schedule: {
      cron,
      timezone,
      input: spec.input ?? {},
      rules: parsed.rules,
      overlap,
      onMissed: spec.onMissed ?? (minGap >= 3_600_000 ? 'once' : 'skip'),
      enabled: spec.enabled ?? true,
      next,
    },
  };
}

/** Période de la planification (ms) : plus petit écart entre ses prochaines occurrences. Nourrit D = max(7 j, 3 × période). */
export function schedulePeriodMs(queue: Pick<JobQueue, 'previewSchedule'>, rows: readonly Pick<ScheduleRow, 'cron' | 'timezone' | 'enabled'>[], from: Date = new Date()): number | null {
  let best: number | null = null;
  for (const row of rows) {
    if (!row.enabled) continue;
    const next = queue.previewSchedule(row.cron, { timezone: row.timezone, count: 6, from });
    for (let i = 1; i < next.length; i++) {
      const gap = (next[i] as Date).getTime() - (next[i - 1] as Date).getTime();
      if (best === null || gap < best) best = gap;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Miroir pg-boss
// ---------------------------------------------------------------------------------------------------------------

/** Aligne le miroir d'UNE planification sur sa ligne (après COMMIT de la ligne). */
export async function mirrorSchedule(queue: JobQueue, row: Pick<ScheduleRow, 'id' | 'cron' | 'timezone' | 'on_missed' | 'enabled'>): Promise<void> {
  if (!row.enabled) {
    await queue.unschedule(SCHEDULED_RUN_QUEUE, row.id);
    return;
  }
  const data: ScheduledRunJobData = { schedule_id: row.id };
  await queue.schedule(SCHEDULED_RUN_QUEUE, row.id, row.cron, data, { timezone: row.timezone, missed: row.on_missed });
}

export async function removeScheduleMirror(queue: JobQueue, scheduleId: string): Promise<void> {
  await queue.unschedule(SCHEDULED_RUN_QUEUE, scheduleId);
}

export type ReconcileResult = { scheduled: string[]; unscheduled: string[]; invalid: { id: string; reason: string }[] };

/**
 * Reconstruction complète du miroir (démarrage du worker) : lignes actives → `schedule()`, clés orphelines ou désactivées →
 * `unschedule()`. Une ligne dont le cron ne s'évalue pas n'arrête pas les autres : elle est rendue dans `invalid`.
 * Les propriétaires désactivés (13 § 12 : « planifications suspendues ») ne sont pas planifiés.
 */
export async function reconcileSchedules(db: Queryable, queue: JobQueue): Promise<ReconcileResult> {
  const { rows } = await db.query<ScheduleRow>(
    `SELECT s.id, s.api_id, s.owner_id, s.cron, s.timezone, s.input, s.rules, s.overlap, s.on_missed, s.enabled
     FROM schedules s JOIN users u ON u.id = s.owner_id
     WHERE s.enabled AND u.status = 'active'`,
  );
  const wanted = new Set<string>();
  const result: ReconcileResult = { scheduled: [], unscheduled: [], invalid: [] };
  for (const row of rows) {
    try {
      await mirrorSchedule(queue, row);
      wanted.add(row.id);
      result.scheduled.push(row.id);
    } catch (error) {
      result.invalid.push({ id: row.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const key of await queue.scheduledKeys(SCHEDULED_RUN_QUEUE)) {
    if (wanted.has(key)) continue;
    // Relu juste avant de retirer : une planification créée (et reflétée) depuis la lecture ci-dessus ne doit pas être perdue.
    const alive = await db.query('SELECT 1 FROM schedules s JOIN users u ON u.id = s.owner_id WHERE s.id::text = $1 AND s.enabled AND u.status = \'active\'', [key]);
    if (alive.rowCount) continue;
    await queue.unschedule(SCHEDULED_RUN_QUEUE, key);
    result.unscheduled.push(key);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Déclenchement
// ---------------------------------------------------------------------------------------------------------------

export type ScheduledRunOutcome =
  | { outcome: 'run'; runId: string }
  | { outcome: 'skipped'; runId: string; state: string; reason: string }
  | { outcome: 'deferred'; deferred: number }
  | { outcome: 'ignored'; reason: 'schedule_missing' | 'disabled' | 'owner_inactive' | 'api_not_accessible' }
  | { outcome: 'duplicate' };

type TriggerContext = {
  schedule_enabled: boolean;
  owner_status: string;
  api_status: ApiStatus;
  api_requires: { tunnel?: boolean } | null;
  api_owner_id: string;
  api_visibility: 'private' | 'instance';
  api_requires_session: boolean;
};

export type HandleScheduledRunInput = {
  /** Connexion système (propriétaire des tables), hors RLS. */
  pool: pg.Pool;
  queue: JobQueue;
  /** Horloge : réelle en production, simulée en test. */
  now: () => Date;
  jobId: string;
  data: ScheduledRunJobData;
  /**
   * Création du job par le cron (`createdOn` de pg-boss, horloge de la file) : sert à retrouver l'occurrence quand le job
   * est traité en retard (file chargée, rattrapage `missed: once` après un déploiement). Défaut : `now()`.
   */
  occurredAt?: Date;
};

/**
 * Traite un déclenchement : relit la planification, sérialise par planification (`FOR UPDATE`), évalue les règles, puis crée
 * le run (et son job) ou trace un run `skipped_*`. Le tout dans une transaction : pas de run sans job, pas de job sans run.
 */
export async function handleScheduledRun(input: HandleScheduledRunInput): Promise<ScheduledRunOutcome> {
  const client = await input.pool.connect();
  try {
    await client.query('BEGIN');
    const outcome = await handleInTransaction(client, input);
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function handleInTransaction(client: pg.PoolClient, input: HandleScheduledRunInput): Promise<ScheduledRunOutcome> {
  const { queue, jobId, data } = input;
  const now = input.now();
  const locked = await client.query<ScheduleRow & TriggerContext>(
    `SELECT s.id, s.api_id, s.owner_id, s.cron, s.timezone, s.input, s.rules, s.overlap, s.on_missed, s.enabled AS schedule_enabled,
            u.status AS owner_status, a.status AS api_status, a.requires AS api_requires, a.owner_id AS api_owner_id,
            a.visibility AS api_visibility, a.requires_session AS api_requires_session
     FROM schedules s JOIN users u ON u.id = s.owner_id JOIN apis a ON a.id = s.api_id
     WHERE s.id = $1 FOR UPDATE OF s`,
    [data.schedule_id],
  );
  const row = locked.rows[0];
  if (!row) {
    // Miroir orphelin (ligne supprimée) : on le retire, la table reste la source de vérité.
    await queue.unschedule(SCHEDULED_RUN_QUEUE, data.schedule_id).catch(() => undefined);
    return { outcome: 'ignored', reason: 'schedule_missing' };
  }
  // Rejeu du même job (reprise après échec) : le run existe déjà.
  const seen = await client.query('SELECT 1 FROM runs WHERE schedule_job_id = $1', [jobId]);
  if (seen.rowCount) return { outcome: 'duplicate' };
  if (!row.schedule_enabled) return { outcome: 'ignored', reason: 'disabled' };
  if (row.owner_status !== 'active') return { outcome: 'ignored', reason: 'owner_inactive' };
  // INV5 / INV12 : un déclenchement n'élargit jamais l'accès. Le propriétaire de la planification doit pouvoir lancer l'API à cet
  // instant (la sienne, ou une API d'instance sans session) ; si l'API est devenue privée ou à session, rien ne part.
  if (row.api_owner_id !== row.owner_id && (row.api_visibility !== 'instance' || row.api_requires_session)) {
    return { outcome: 'ignored', reason: 'api_not_accessible' };
  }

  // Occurrence servie par ce job : `scheduled_at`, variables datées, quota du jour et fenêtre la prennent pour référence.
  const occurrence = await occurrenceOf(client, queue, row, data, input.occurredAt ?? now);

  // Règles relues en base. Une ligne écrite hors du service et invalide retombe sur le défaut (bloquee toujours sautée).
  const parsed = parseScheduleRules(row.rules);
  const rules = parsed.ok ? parsed.rules : (parseScheduleRules({}) as { ok: true; rules: ScheduleRules }).rules;

  // Tunnel du propriétaire de la planification, qui sera celui du run (INV5 : l'instance ne route vers une extension que
  // les runs de l'utilisateur du jeton) ; jamais celui du propriétaire de l'API, dont l'activité ne doit pas fuiter (INV12).
  const needsTunnel = rules.only_if_tunnel_online || row.api_requires?.tunnel === true;
  const tunnelOnline = needsTunnel
    ? ((
        await client.query(
          `SELECT 1 FROM tunnels WHERE owner_id = $1 AND revoked_at IS NULL AND expires_at > $2::timestamptz
             AND last_seen_at > $2::timestamptz - make_interval(secs => $3) LIMIT 1`,
          [row.owner_id, now, TUNNEL_ONLINE_SECONDS],
        )
      ).rowCount ?? 0) > 0
    : false;
  const runsToday =
    rules.max_runs_per_day === null
      ? 0
      : Number(
          (
            await client.query<{ n: string }>(
              `SELECT count(*) AS n FROM runs
               WHERE schedule_id = $1 AND state NOT LIKE 'skipped\\_%'
                 AND scheduled_at >= (date_trunc('day', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3)
                 AND scheduled_at < ((date_trunc('day', $2::timestamptz AT TIME ZONE $3) + interval '1 day') AT TIME ZONE $3)`,
              [row.id, occurrence, row.timezone],
            )
          ).rows[0]?.n ?? 0,
        );
  const activeRun =
    ((await client.query("SELECT 1 FROM runs WHERE schedule_id = $1 AND state IN ('queued', 'running', 'waiting_tunnel') LIMIT 1", [row.id])).rowCount ?? 0) > 0;

  const decision = evaluateScheduleRules(rules, {
    // Fenêtre et quota jugés sur l'occurrence, pas sur l'heure du traitement.
    now: occurrence,
    timezone: row.timezone,
    enabled: row.schedule_enabled,
    overlap: row.overlap,
    apiStatus: row.api_status,
    tunnelOnline,
    apiRequiresTunnel: row.api_requires?.tunnel === true,
    runsToday,
    activeRun,
  });

  const origin: ScheduleOrigin = { scheduleId: row.id, scheduledAt: occurrence, scheduleJobId: jobId };
  switch (decision.action) {
    case 'ignore':
      return { outcome: 'ignored', reason: 'disabled' };
    case 'skip': {
      const runId = await recordSkippedRun(client, { apiId: row.api_id, ownerId: row.owner_id, trigger: 'schedule', state: decision.state, reason: decision.reason, schedule: origin });
      return { outcome: 'skipped', runId, state: decision.state, reason: decision.reason };
    }
    case 'defer': {
      const rank = (data.deferred ?? 0) + 1;
      const queued =
        rank <= MAX_DEFERRALS
          ? await queue.enqueueOnce(
              SCHEDULED_RUN_DEFERRED_QUEUE,
              { schedule_id: row.id, deferred: rank, occurrence_at: occurrence.toISOString() } satisfies ScheduledRunJobData,
              { singletonKey: row.id, startAfterSeconds: DEFER_SECONDS, tx: client as QueryClient },
            )
          : null;
      if (queued !== null) return { outcome: 'deferred', deferred: rank };
      // Un report attend déjà (ou on a trop attendu) : une seule occurrence en attente par planification.
      const reason = rank > MAX_DEFERRALS ? 'deferred_too_long' : 'overlap_queue_full';
      const runId = await recordSkippedRun(client, { apiId: row.api_id, ownerId: row.owner_id, trigger: 'schedule', state: 'skipped_overlap', reason, schedule: origin });
      return { outcome: 'skipped', runId, state: 'skipped_overlap', reason };
    }
    case 'run': {
      const { runId } = await createRun(client, queue, {
        apiId: row.api_id,
        ownerId: row.owner_id,
        trigger: 'schedule',
        input: resolveScheduleInput(row.input, occurrence, row.timezone),
        schedule: origin,
      });
      return { outcome: 'run', runId };
    }
  }
}

/**
 * Occurrence d'un déclenchement. Un report porte la sienne (`occurrence_at`). Sinon : la dernière occurrence du cron au plus
 * tard à la création du job ; si un autre run de la planification l'a déjà prise, celle d'avant (le rattrapage
 * `missed: once` et l'occurrence courante sont émis dans le même passage du cron, à la même heure de création). Sans
 * occurrence calculable (cron illisible) : l'heure de référence.
 */
async function occurrenceOf(client: Queryable, queue: Pick<JobQueue, 'previewSchedule'>, row: Pick<ScheduleRow, 'id' | 'cron' | 'timezone'>, data: ScheduledRunJobData, ref: Date): Promise<Date> {
  if (typeof data.occurrence_at === 'string') {
    const carried = new Date(data.occurrence_at);
    if (!Number.isNaN(carried.getTime())) return carried;
  }
  let recent: Date[];
  try {
    recent = latestOccurrences(queue, row.cron, row.timezone, ref, 2);
  } catch {
    return ref;
  }
  const latest = recent.at(-1);
  if (latest === undefined) return ref;
  const { rows } = await client.query<{ at: Date }>('SELECT scheduled_at AS at FROM runs WHERE schedule_id = $1 AND scheduled_at = ANY($2::timestamptz[])', [row.id, recent]);
  const taken = new Set(rows.map((r) => r.at.getTime()));
  for (const candidate of [...recent].reverse()) if (!taken.has(candidate.getTime())) return candidate;
  return latest;
}

/** Les `count` dernières occurrences d'un cron au plus tard à `ref` (fenêtre élargie par doublement, au plus ~400 j). */
function latestOccurrences(queue: Pick<JobQueue, 'previewSchedule'>, cron: string, timezone: string, ref: Date, count: number): Date[] {
  const refMs = ref.getTime();
  const BATCH = 50;
  let found: Date[] = [];
  for (let span = 2 * 60_000; span <= 400 * 86_400_000; span *= 2) {
    found = [];
    let from = new Date(refMs - span);
    for (;;) {
      const batch = queue.previewSchedule(cron, { timezone, count: BATCH, from });
      const within = batch.filter((d) => d.getTime() <= refMs);
      found.push(...within);
      const lastOf = batch.at(-1);
      if (within.length < batch.length || batch.length < BATCH || lastOf === undefined || lastOf.getTime() <= from.getTime()) break;
      from = lastOf;
    }
    if (found.length >= count) return found.slice(-count);
  }
  return found.slice(-count);
}

/** Durée D d'un `warning` pour cette API, d'après ses planifications actives : max(7 j, 3 × période). */
export async function warningDelayMs(db: Queryable, queue: Pick<JobQueue, 'previewSchedule'>, apiId: string, from: Date = new Date()): Promise<number> {
  const { rows } = await db.query<Pick<ScheduleRow, 'cron' | 'timezone' | 'enabled'>>('SELECT cron, timezone, enabled FROM schedules WHERE api_id = $1', [apiId]);
  return quietPeriodMs(schedulePeriodMs(queue, rows, from));
}
