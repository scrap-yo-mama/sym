// SPDX-License-Identifier: AGPL-3.0-only
// Dépôt du statut d'API (INV3) : applique une transition de la machine pure et écrit `status_events` dans la même
// transaction que la mise à jour de `apis`. Un événement sans transition ne touche pas `status_events`.
import {
  applyStatusEvent,
  toStatusEventRow,
  withStale,
  type ApiStatusState,
  type Clock,
  type StaleInput,
  type Status,
  type StatusEventInput,
  type StatusEventRow,
  type TransitionRecord,
} from '@runtime/core';
import type pg from 'pg';

export type ApplyStatusInput = {
  apiId: string;
  /** Run à l'origine de l'événement, porté par chaque ligne `status_events`. */
  runId?: string | null;
  event: StatusEventInput;
  clock: Clock;
  schedulePeriodMs?: number | null;
  /**
   * Appelé dans la transaction, après l'écriture de `apis` et de `status_events`, quand au moins une transition a eu lieu :
   * les webhooks et alertes (`notifyStatusChange`, 2.5) sont écrits au même COMMIT que les transitions qu'ils annoncent.
   */
  afterTransition?: (client: pg.PoolClient, events: StatusEventRow[]) => Promise<void>;
  /**
   * Appelé dans la transaction, la ligne `apis` verrouillée (FOR UPDATE) et la transition ACCEPTÉE par la machine, avant
   * toute écriture du statut : l'écriture qui motive l'événement (ex. version rétablie par un retour) est validée au même
   * COMMIT que sa transition, jamais sans elle (INV3). Une exception annule tout.
   */
  beforeWrite?: (client: pg.PoolClient) => Promise<void>;
  /**
   * Appelé dans la transaction après l'écriture du statut et de `status_events`, avant les notifications, quand la
   * transition a été ACCEPTÉE : l'écriture qui exige le NOUVEAU statut (ex. enquête lancée par une ré-enquête, 16 à 20,
   * qui veut `enquete`) part au même COMMIT que sa transition. Une exception annule tout (statut compris).
   */
  afterWrite?: (client: pg.PoolClient) => Promise<void>;
};

export type ApplyStatusResult =
  | { ok: true; state: ApiStatusState; transitions: TransitionRecord[]; events: StatusEventRow[] }
  | { ok: false; state: ApiStatusState; rejected: string };

type ApiRow = {
  id: string;
  owner_id: string;
  project_id: string;
  status: Status;
  status_reason: string | null;
  clean_streak: number;
  last_signal_at: Date | null;
  stale: boolean;
};

/** `previous_status` (transition 21) : statut d'où l'API est entrée en `enquete`, seulement depuis `sain` ou `warning`. */
async function previousStatus(client: pg.ClientBase, apiId: string): Promise<Status | null> {
  const { rows } = await client.query<{ from_status: Status | null }>(
    "SELECT from_status FROM status_events WHERE api_id = $1 AND to_status = 'enquete' ORDER BY id DESC LIMIT 1",
    [apiId],
  );
  const from = rows[0]?.from_status;
  return from === 'sain' || from === 'warning' ? from : null;
}

async function loadState(client: pg.ClientBase, apiId: string): Promise<{ row: ApiRow; state: ApiStatusState }> {
  const { rows } = await client.query<ApiRow>(
    'SELECT id, owner_id, project_id, status, status_reason, clean_streak, last_signal_at, stale FROM apis WHERE id = $1 FOR UPDATE',
    [apiId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`API introuvable : ${apiId}`);
  return {
    row,
    state: {
      status: row.status,
      reason: row.status_reason,
      cleanStreak: row.clean_streak,
      lastSignalAt: row.last_signal_at === null ? null : row.last_signal_at.getTime(),
      previousStatus: row.status === 'enquete' ? await previousStatus(client, apiId) : null,
      stale: row.stale,
    },
  };
}

async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function applyStatusTransition(pool: pg.Pool, input: ApplyStatusInput): Promise<ApplyStatusResult> {
  return inTransaction(pool, async (client) => {
    const { row, state } = await loadState(client, input.apiId);
    const step = applyStatusEvent(state, input.event, { clock: input.clock, schedulePeriodMs: input.schedulePeriodMs ?? null });
    if (!step.ok) return { ok: false, state: step.state, rejected: step.rejected };
    await input.beforeWrite?.(client);

    await client.query(
      'UPDATE apis SET status = $2, status_reason = $3, clean_streak = $4, last_signal_at = $5, updated_at = now() WHERE id = $1',
      [
        row.id,
        step.state.status,
        step.state.reason,
        step.state.cleanStreak,
        step.state.lastSignalAt === null ? null : new Date(step.state.lastSignalAt),
      ],
    );
    const events = step.transitions.map((t) => toStatusEventRow(t, input.runId ?? null));
    for (const e of events) {
      await client.query(
        'INSERT INTO status_events (api_id, owner_id, project_id, from_status, to_status, reason, run_id, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [row.id, row.owner_id, row.project_id, e.from_status, e.to_status, e.reason, e.run_id, e.at],
      );
    }
    await input.afterWrite?.(client);
    if (events.length > 0) await input.afterTransition?.(client, events);
    return { ok: true, state: step.state, transitions: step.transitions, events };
  });
}

/** Met à jour le drapeau `stale` seul : jamais de transition, jamais de ligne `status_events`. */
export async function refreshStale(
  pool: pg.Pool,
  apiId: string,
  input: StaleInput,
  clock: Clock,
  schedulePeriodMs: number | null = null,
): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    const { state } = await loadState(client, apiId);
    const next = withStale(state, input, { clock, schedulePeriodMs });
    if (next.stale !== state.stale) await client.query('UPDATE apis SET stale = $2 WHERE id = $1', [apiId, next.stale]);
    return next.stale;
  });
}
