// Sondes (14 § 3) : disponibilité (`/api/ready`) et battements des workers. Booléens seulement : aucune version de
// dépendance, aucun nom d'hôte, aucun message d'erreur dans ce qui sort (la réponse est publique).
import { verifyKeyCheck, type KeyCheckRecord, type Keyring } from '@runtime/core';
import type pg from 'pg';
import { currentSchemaVersion } from './migrate.js';
import { KEY_CHECK_SETTING, REKEY_STATE_SETTING } from './secrets.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Un worker sans battement depuis 45 s est mort (14 § 3, à valider par 4.4). */
export const WORKER_DEAD_AFTER_SECONDS = 45;

export type ReadinessChecks = { database: boolean; schema: boolean; key_check: boolean };
export type Readiness = { ready: boolean; checks: ReadinessChecks };

/**
 * Disponibilité : base joignable, schéma à la version attendue (migrations appliquées), `key_check` valide pour la clé
 * de ce processus et aucune rotation en cours. Lecture seule : contrairement à `keyCheck`, n'initialise rien.
 */
export async function checkReadiness(db: Queryable, keyring: Keyring, expectedSchemaVersion: number): Promise<Readiness> {
  const checks: ReadinessChecks = { database: false, schema: false, key_check: false };
  try {
    await db.query('SELECT 1');
    checks.database = true;
    checks.schema = (await currentSchemaVersion(db)) === expectedSchemaVersion;
    if (checks.schema) {
      const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [
        [KEY_CHECK_SETTING, REKEY_STATE_SETTING],
      ]);
      const record = rows.find((r) => r.key === KEY_CHECK_SETTING)?.value as KeyCheckRecord | undefined;
      const rotating = rows.some((r) => r.key === REKEY_STATE_SETTING);
      checks.key_check = record !== undefined && !rotating && verifyKeyCheck(record, keyring.current);
    }
  } catch {
    // Base coupée ou illisible : les contrôles restants restent à false.
  }
  return { ready: checks.database && checks.schema && checks.key_check, checks };
}

export type WorkerStatus = {
  workerId: string;
  startedAt: Date;
  lastSeenAt: Date;
  ageSeconds: number;
  version: string;
  browserContexts: number;
  rssMb: number | null;
  draining: boolean;
  alive: boolean;
};

/** Battements des workers (`worker_heartbeats`), vivants ou non. Informatif : n'entre pas dans `/api/ready`. */
export async function listWorkers(db: Queryable): Promise<WorkerStatus[]> {
  const { rows } = await db.query<{
    worker_id: string;
    started_at: Date;
    last_seen_at: Date;
    age: number;
    version: string;
    browser_contexts: number;
    rss_mb: number | null;
    draining: boolean;
  }>(
    `SELECT worker_id, started_at, last_seen_at, extract(epoch FROM now() - last_seen_at)::float8 AS age, version,
            browser_contexts, rss_mb, draining
     FROM worker_heartbeats ORDER BY worker_id`,
  );
  return rows.map((r) => ({
    workerId: r.worker_id,
    startedAt: r.started_at,
    lastSeenAt: r.last_seen_at,
    ageSeconds: r.age,
    version: r.version,
    browserContexts: r.browser_contexts,
    rssMb: r.rss_mb,
    draining: r.draining,
    alive: r.age < WORKER_DEAD_AFTER_SECONDS,
  }));
}

/** Runs en attente ou en cours (profondeur de file vue depuis `runs`, sans toucher au schéma `pgboss`). */
export async function queueDepth(db: Queryable): Promise<{ queued: number; running: number; oldestQueuedAgeSeconds: number | null }> {
  const { rows } = await db.query<{ queued: number; running: number; oldest: number | null }>(
    `SELECT count(*) FILTER (WHERE state = 'queued')::int AS queued, count(*) FILTER (WHERE state = 'running')::int AS running,
            extract(epoch FROM now() - min(created_at) FILTER (WHERE state = 'queued'))::float8 AS oldest
     FROM runs WHERE state IN ('queued', 'running')`,
  );
  return { queued: rows[0]?.queued ?? 0, running: rows[0]?.running ?? 0, oldestQueuedAgeSeconds: rows[0]?.oldest ?? null };
}
