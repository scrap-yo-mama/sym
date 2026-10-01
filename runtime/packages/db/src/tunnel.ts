// SPDX-License-Identifier: AGPL-3.0-only
// Tunnel WSS (tâche 2.7, 07 § 5-6, 03 « Mode tunnel ») : la table `tunnel_jobs` est la source de vérité, NOTIFY ne porte
// que l'identifiant (réveil) sur le canal DE L'INSTANCE qui tient la connexion (`tunnels.gateway_instance`), jamais sur un
// canal commun ; un sondage de secours rattrape une coupure de LISTEN. Identité système (propriétaire des tables) :
// passerelle (server) et worker. Garde INV5 à chaque étape : un job ne part que vers la connexion du propriétaire de son
// run (contrôlé ici, à l'émission, et par le déclencheur `tunnel_jobs_owner_bound` de la migration 0012).
import { randomUUID } from 'node:crypto';
import type { TunnelCommand, TunnelError } from '@runtime/core/tunnel';
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Canal des réponses : le worker qui attend un job est réveillé par son identifiant (la table fait foi). */
export const TUNNEL_DONE_CHANNEL = 'tunnel_job_done';
const INSTANCE = /^[a-z0-9_]{1,40}$/;

/** Canal d'une instance de passerelle (`tunnel_cmd_<instance>`). */
export function gatewayChannel(instance: string): string {
  if (!INSTANCE.test(instance)) throw new RangeError(`identifiant d'instance de passerelle invalide : ${instance}`);
  return `tunnel_cmd_${instance}`;
}

/** Identifiant d'instance normalisé (`GATEWAY_INSTANCE`, ou nom d'hôte + pid + aléa). */
export function normalizeGatewayInstance(raw: string): string {
  const id = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!INSTANCE.test(id)) throw new RangeError(`GATEWAY_INSTANCE invalide : ${raw}`);
  return id;
}

/**
 * Messages NOTIFY d'une passerelle : `j:<job>` (commande à émettre), `k:<ancien tunnel>:<nouveau tunnel>:<époque>` (une
 * connexion plus récente du même utilisateur a gagné : fermer l'ancienne en 4409), `r:<tunnel>` (révoqué : 4401).
 */
export type GatewaySignal =
  | { kind: 'job'; jobId: string }
  | { kind: 'kick'; tunnelId: string; newTunnelId: string; epoch: number }
  | { kind: 'revoked'; tunnelId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseGatewaySignal(payload: string | undefined): GatewaySignal | null {
  if (payload === undefined) return null;
  const [kind, id, second, epoch] = payload.split(':');
  if (id === undefined || !UUID.test(id)) return null;
  if (kind === 'j') return { kind: 'job', jobId: id };
  if (kind === 'r') return { kind: 'revoked', tunnelId: id };
  if (kind === 'k' && second !== undefined && UUID.test(second) && epoch !== undefined && /^\d{1,15}$/.test(epoch)) {
    return { kind: 'kick', tunnelId: id, newTunnelId: second, epoch: Number(epoch) };
  }
  return null;
}

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

/** Jobs d'une connexion perdue : rejoués s'ils sont des lectures pures, sinon en échec (`tunnel_disconnected`). */
async function releaseDispatched(tx: Queryable, where: string, params: unknown[]): Promise<void> {
  const { rows } = await tx.query<{ job_id: string; state: string }>(
    `UPDATE tunnel_jobs SET
       state = CASE WHEN replayable THEN 'pending' ELSE 'failed' END,
       error = CASE WHEN replayable THEN NULL ELSE 'tunnel_disconnected' END,
       finished_at = CASE WHEN replayable THEN NULL ELSE now() END,
       tunnel_id = CASE WHEN replayable THEN NULL ELSE tunnel_id END,
       gateway_instance = NULL, updated_at = now()
     WHERE state = 'dispatched' AND ${where}
     RETURNING job_id, state`,
    params,
  );
  for (const row of rows) if (row.state === 'failed') await tx.query('SELECT pg_notify($1, $2)', [TUNNEL_DONE_CHANNEL, row.job_id]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Passerelle
// ---------------------------------------------------------------------------------------------------------------------

export type AttachedConnection = { epoch: number; kicked: { tunnelId: string; instance: string }[] };

/**
 * Une WSS s'ouvre pour `tunnelId` sur `instance` (07 § 6) : la connexion la plus récente gagne. Toute autre connexion du
 * même utilisateur (autre appareil, autre instance, ou ancienne connexion du même appareil) est détachée et son instance
 * notifiée (`k:` → fermeture 4409) ; ses jobs en cours sont rejoués (lecture) ou mis en échec, jamais perdus.
 */
export async function attachTunnelConnection(pool: pg.Pool, input: { tunnelId: string; ownerId: string; instance: string }): Promise<AttachedConnection | null> {
  return inTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('tunnel_owner:' || $1, 0))", [input.ownerId]);
    const previous = await tx.query<{ id: string; gateway_instance: string }>(
      'SELECT id, gateway_instance FROM tunnels WHERE owner_id = $1 AND gateway_instance IS NOT NULL FOR UPDATE',
      [input.ownerId],
    );
    if (previous.rows.length > 0) {
      await tx.query('UPDATE tunnels SET gateway_instance = NULL, connected_at = NULL WHERE owner_id = $1 AND gateway_instance IS NOT NULL', [input.ownerId]);
    }
    const { rows } = await tx.query<{ conn_epoch: string }>(
      `UPDATE tunnels SET gateway_instance = $3, connected_at = now(), conn_epoch = conn_epoch + 1, last_seen_at = now()
       WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL AND expires_at > now()
       RETURNING conn_epoch`,
      [input.tunnelId, input.ownerId, input.instance],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const epoch = Number(row.conn_epoch);
    // Jobs encore « dispatched » de ce propriétaire : ils appartenaient à une connexion désormais remplacée.
    await releaseDispatched(tx, 'owner_id = $1', [input.ownerId]);
    for (const p of previous.rows) {
      await tx.query('SELECT pg_notify($1, $2)', [gatewayChannel(p.gateway_instance), `k:${p.id}:${input.tunnelId}:${epoch}`]);
    }
    return { epoch, kicked: previous.rows.map((p) => ({ tunnelId: p.id, instance: p.gateway_instance })) };
  });
}

/** La WSS de (`tunnelId`, `epoch`) est fermée : la ligne n'est détachée que si elle désigne encore cette connexion. */
export async function detachTunnelConnection(pool: pg.Pool, input: { tunnelId: string; instance: string; epoch: number }): Promise<void> {
  await inTransaction(pool, async (tx) => {
    await tx.query(
      'UPDATE tunnels SET gateway_instance = NULL, connected_at = NULL WHERE id = $1 AND gateway_instance = $2 AND conn_epoch = $3',
      [input.tunnelId, input.instance, input.epoch],
    );
    await releaseDispatched(tx, 'tunnel_id = $1 AND gateway_instance = $2', [input.tunnelId, input.instance]);
  });
}

/** Appareil toujours utilisable (non révoqué, non expiré, compte actif) ; renouvelle l'échéance à l'usage (07 § 1). */
export async function tunnelStillValid(db: Queryable, tunnelId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE tunnels t SET last_seen_at = now(), expires_at = greatest(t.expires_at, now() + interval '90 days')
     FROM users u
     WHERE t.id = $1 AND t.revoked_at IS NULL AND t.expires_at > now() AND u.id = t.owner_id AND u.status = 'active'`,
    [tunnelId],
  );
  return rowCount === 1;
}

/** Commande prête à émettre vers l'extension. */
export type DispatchedJob = {
  jobId: string;
  runId: string;
  cmd: TunnelCommand;
  domain: string;
  args: unknown;
  timeoutMs: number;
  allowWriteActions: boolean;
  execution: string | null;
  attempt: number;
};

export type DispatchOutcome =
  | { kind: 'dispatched'; job: DispatchedJob }
  /** Le job n'est pas (ou plus) en attente, ou vise une autre connexion : rien à faire. */
  | { kind: 'skip' }
  /** INV5 : le run n'appartient pas à l'utilisateur de cette connexion. Le job est mis en échec, rien n'est émis. */
  | { kind: 'denied'; jobId: string; runOwnerId: string | null; jobOwnerId: string };

/**
 * Prend un job en attente pour la connexion (`tunnelId`, `ownerId`) de cette instance. Refus INV5 avant toute émission :
 * le job, son run et la connexion doivent avoir le même propriétaire (`assert_tunnel_single_user`).
 */
export async function claimTunnelJob(pool: pg.Pool, input: { jobId: string; tunnelId: string; ownerId: string; instance: string }): Promise<DispatchOutcome> {
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{
      job_id: string;
      run_id: string;
      owner_id: string;
      tunnel_id: string | null;
      state: string;
      cmd: TunnelCommand;
      domain: string;
      payload: unknown;
      timeout_ms: number;
      allow_write_actions: boolean;
      execution: string | null;
      attempts: number;
      run_owner: string | null;
      run_state: string | null;
    }>(
      `SELECT j.job_id, j.run_id, j.owner_id, j.tunnel_id, j.state, j.cmd, j.domain, j.payload, j.timeout_ms, j.allow_write_actions,
              j.execution, j.attempts, r.owner_id AS run_owner, r.state AS run_state
       FROM tunnel_jobs j LEFT JOIN runs r ON r.id = j.run_id
       WHERE j.job_id = $1 FOR UPDATE OF j SKIP LOCKED`,
      [input.jobId],
    );
    const job = rows[0];
    if (job === undefined || job.state !== 'pending') return { kind: 'skip' };
    if (job.tunnel_id !== null && job.tunnel_id !== input.tunnelId) {
      // Job destiné à une autre connexion : seul son propriétaire peut le prendre.
      if (job.owner_id === input.ownerId) return { kind: 'skip' };
    }
    if (job.owner_id !== input.ownerId || job.run_owner !== input.ownerId) {
      await tx.query(
        "UPDATE tunnel_jobs SET state = 'failed', error = 'owner_mismatch', finished_at = now(), updated_at = now() WHERE job_id = $1",
        [job.job_id],
      );
      await tx.query('SELECT pg_notify($1, $2)', [TUNNEL_DONE_CHANNEL, job.job_id]);
      return { kind: 'denied', jobId: job.job_id, runOwnerId: job.run_owner, jobOwnerId: job.owner_id };
    }
    if (job.run_state !== 'running' && job.run_state !== 'waiting_tunnel') {
      await tx.query("UPDATE tunnel_jobs SET state = 'cancelled', finished_at = now(), updated_at = now() WHERE job_id = $1", [job.job_id]);
      await tx.query('SELECT pg_notify($1, $2)', [TUNNEL_DONE_CHANNEL, job.job_id]);
      return { kind: 'skip' };
    }
    const updated = await tx.query<{ attempts: number }>(
      `UPDATE tunnel_jobs SET state = 'dispatched', tunnel_id = $2, gateway_instance = $3, dispatched_at = now(), attempts = attempts + 1,
         updated_at = now()
       WHERE job_id = $1 RETURNING attempts`,
      [job.job_id, input.tunnelId, input.instance],
    );
    return {
      kind: 'dispatched',
      job: {
        jobId: job.job_id,
        runId: job.run_id,
        cmd: job.cmd,
        domain: job.domain,
        args: job.payload,
        timeoutMs: job.timeout_ms,
        allowWriteActions: job.allow_write_actions,
        execution: job.execution,
        attempt: updated.rows[0]!.attempts,
      },
    };
  });
}

/**
 * Jobs en attente des propriétaires connectés à cette instance (rattrapage à la connexion, sondage de secours), du plus
 * ancien au plus récent. Le routage (propriétaire, connexion) est revérifié par `claimTunnelJob`.
 */
export async function pendingTunnelJobs(db: Queryable, ownerIds: readonly string[], limit = 1000): Promise<{ jobId: string; ownerId: string; tunnelId: string | null }[]> {
  if (ownerIds.length === 0) return [];
  const { rows } = await db.query<{ job_id: string; owner_id: string; tunnel_id: string | null }>(
    `SELECT job_id, owner_id, tunnel_id FROM tunnel_jobs WHERE state = 'pending' AND owner_id = ANY($1::uuid[])
     ORDER BY created_at LIMIT $2`,
    [ownerIds, limit],
  );
  return rows.map((r) => ({ jobId: r.job_id, ownerId: r.owner_id, tunnelId: r.tunnel_id }));
}

/** Routage d'un job réveillé par NOTIFY : son propriétaire et la connexion visée. */
export async function tunnelJobRoute(db: Queryable, jobId: string): Promise<{ ownerId: string; tunnelId: string | null } | null> {
  const { rows } = await db.query<{ owner_id: string; tunnel_id: string | null }>(
    "SELECT owner_id, tunnel_id FROM tunnel_jobs WHERE job_id = $1 AND state = 'pending'",
    [jobId],
  );
  const row = rows[0];
  return row === undefined ? null : { ownerId: row.owner_id, tunnelId: row.tunnel_id };
}

/** Parmi `tunnelIds`, ceux qui ne sont plus utilisables (révoqués, expirés, compte inactif, ligne détachée ailleurs). */
export async function invalidTunnels(db: Queryable, connections: readonly { tunnelId: string; epoch: number }[], instance: string): Promise<string[]> {
  if (connections.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.id FROM unnest($1::uuid[], $2::bigint[]) AS c(id, epoch)
     WHERE NOT EXISTS (
       SELECT 1 FROM tunnels t JOIN users u ON u.id = t.owner_id
       WHERE t.id = c.id AND t.revoked_at IS NULL AND t.expires_at > now() AND u.status = 'active'
         AND t.gateway_instance = $3 AND t.conn_epoch = c.epoch)`,
    [connections.map((c) => c.tunnelId), connections.map((c) => c.epoch), instance],
  );
  return rows.map((r) => r.id);
}

/**
 * Réponse d'un job émis par cette connexion (et cette tentative) : écrite en transaction, puis NOTIFY du job_id. Une
 * réponse pour un job qui n'est pas le sien, déjà clos ou d'une tentative précédente est ignorée (`false`).
 */
export async function completeTunnelJob(
  pool: pg.Pool,
  input: { jobId: string; tunnelId: string; instance: string; attempt: number; outcome: { ok: true; result: unknown } | { ok: false; error: TunnelError | 'protocol_violation'; result?: unknown } },
): Promise<boolean> {
  return inTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE tunnel_jobs SET state = $5, result = $6, error = $7, finished_at = now(), updated_at = now()
       WHERE job_id = $1 AND tunnel_id = $2 AND gateway_instance = $3 AND attempts = $4 AND state = 'dispatched'`,
      [
        input.jobId,
        input.tunnelId,
        input.instance,
        input.attempt,
        input.outcome.ok ? 'done' : 'failed',
        input.outcome.ok ? JSON.stringify(input.outcome.result) : input.outcome.result === undefined ? null : JSON.stringify(input.outcome.result),
        input.outcome.ok ? null : input.outcome.error,
      ],
    );
    if (rowCount !== 1) return false;
    await tx.query('SELECT pg_notify($1, $2)', [TUNNEL_DONE_CHANNEL, input.jobId]);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------------------------------------------------

export type TunnelJobInput = {
  runId: string;
  ownerId: string;
  cmd: TunnelCommand;
  domain: string;
  args: unknown;
  timeoutMs: number;
  replayable: boolean;
  allowWriteActions: boolean;
  execution: string | null;
  /** Contexte W3C du run (`tunnel_jobs.trace`, 14 § 10), jamais transmis à l'extension. */
  trace?: unknown;
};

/**
 * Inscrit une commande et réveille l'instance qui tient la connexion du propriétaire (NOTIFY au COMMIT, sur SON canal).
 * Sans connexion : le job attend (rattrapage à la connexion de l'extension) ; `connected` le dit au worker.
 */
export async function enqueueTunnelJob(pool: pg.Pool, input: TunnelJobInput): Promise<{ jobId: string; connected: boolean }> {
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string; gateway_instance: string }>(
      `SELECT id, gateway_instance FROM tunnels
       WHERE owner_id = $1 AND gateway_instance IS NOT NULL AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
      [input.ownerId],
    );
    const tunnel = rows[0];
    const jobId = randomUUID();
    await tx.query(
      `INSERT INTO tunnel_jobs (job_id, run_id, tunnel_id, owner_id, payload, state, trace, cmd, domain, execution, timeout_ms, replayable,
         allow_write_actions)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12)`,
      [
        jobId,
        input.runId,
        tunnel?.id ?? null,
        input.ownerId,
        JSON.stringify(input.args ?? null),
        input.trace === undefined ? null : JSON.stringify(input.trace),
        input.cmd,
        input.domain,
        input.execution,
        input.timeoutMs,
        input.replayable,
        input.allowWriteActions,
      ],
    );
    if (tunnel !== undefined) await tx.query('SELECT pg_notify($1, $2)', [gatewayChannel(tunnel.gateway_instance), `j:${jobId}`]);
    return { jobId, connected: tunnel !== undefined };
  });
}

export type TunnelJobState = { state: string; result: unknown; error: string | null; dispatched: boolean };

/** État d'un job (lecture de la table, qui fait foi). */
export async function readTunnelJob(db: Queryable, jobId: string): Promise<TunnelJobState | null> {
  const { rows } = await db.query<{ state: string; result: unknown; error: string | null; dispatched_at: Date | null }>(
    'SELECT state, result, error, dispatched_at FROM tunnel_jobs WHERE job_id = $1',
    [jobId],
  );
  const row = rows[0];
  return row === undefined ? null : { state: row.state, result: row.result, error: row.error, dispatched: row.dispatched_at !== null };
}

/** Une fois lue par le worker, la réponse (contenu de page) est effacée de la table : minimisation (17 § 6). */
export async function forgetTunnelResult(db: Queryable, jobId: string): Promise<void> {
  await db.query('UPDATE tunnel_jobs SET result = NULL, updated_at = now() WHERE job_id = $1 AND result IS NOT NULL', [jobId]);
}

/** Abandon d'un job non clos (délai, annulation du run). Rend l'état d'avant, ou `null` s'il était déjà clos. */
export async function abandonTunnelJob(db: Queryable, jobId: string, state: 'expired' | 'cancelled'): Promise<{ wasDispatched: boolean } | null> {
  const { rows } = await db.query<{ dispatched_at: Date | null }>(
    `UPDATE tunnel_jobs SET state = $2, finished_at = now(), updated_at = now()
     WHERE job_id = $1 AND state IN ('pending', 'dispatched') RETURNING dispatched_at`,
    [jobId, state],
  );
  const row = rows[0];
  return row === undefined ? null : { wasDispatched: row.dispatched_at !== null };
}

/** Le propriétaire a-t-il une extension connectée en ce moment ? */
export async function ownerTunnelConnected(db: Queryable, ownerId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM tunnels WHERE owner_id = $1 AND gateway_instance IS NOT NULL AND revoked_at IS NULL AND expires_at > now()',
    [ownerId],
  );
  return (rowCount ?? 0) > 0;
}
