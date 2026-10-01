// SPDX-License-Identifier: AGPL-3.0-only
// `runtime diagnostics` (14 § 7) : fichier produit EN LOCAL, masqué, jamais envoyé (INV9) ; l'administrateur le joint
// lui-même à un ticket. Contenu : versions, NOMS des réglages (jamais les valeurs), compteurs, dernières `failure_class`,
// résultat de `doctor` réduit à (id, statut, code). Aucun texte libre venu de la base, aucun nom d'hôte, aucune URL.
import { redact } from '@runtime/core';
import type pg from 'pg';
import type { DoctorReport } from './doctor.js';
import { currentSchemaVersion, expectedSchemaVersion } from '../migrate.js';

export type Diagnostics = {
  format: 'runtime-diagnostics';
  format_version: 1;
  generated_at: string;
  versions: { runtime: string; node: string; postgres: string; schema: { current: number | null; expected: number } };
  /** Faux : la base ne répond pas, seuls les contrôles locaux de `doctor` sont dans le fichier. */
  database_reachable: boolean;
  /** Clés de `settings` seulement : leurs valeurs (empreintes, état de rotation, dates) n'en sortent pas. */
  settings_names: string[];
  /** Variables du catalogue (14 § 2) posées dans l'environnement, par leur NOM. */
  env_names_set: string[];
  counters: {
    users: number;
    apis_by_status: Record<string, number>;
    runs_by_state: Record<string, number>;
    secrets: { ok: number; unreadable: number };
    schedules_enabled: number;
    workers_alive: number;
  } | null;
  last_failure_classes: { failure_class: string; count: number; last_at: string }[];
  doctor: { exit_code: number; checks: { id: string; status: string; code: string }[] };
};

/** Variables du catalogue dont la présence éclaire un diagnostic. Liste fermée : une variable hors liste n'apparaît pas. */
export const DIAGNOSTIC_ENV_NAMES = [
  'DATABASE_URL', 'DATABASE_URL_DIRECT', 'DB_POOL_MAX', 'DATABASE_SSL', 'MASTER_KEY', 'MASTER_KEY_FILE', 'MASTER_KEY_PREVIOUS',
  'PUBLIC_URL', 'INSTANCE_CONTACT', 'PORT', 'TRUST_PROXY', 'MAX_WAIT_SECONDS', 'BROWSER_CONCURRENCY', 'WORKER_CONCURRENCY',
  'AUTO_MIGRATE', 'SHUTDOWN_TIMEOUT_SECONDS', 'ADMIN_BOOTSTRAP_TOKEN', 'ADMIN_EMAIL', 'MFA_ENFORCED', 'LOG_LEVEL', 'LOG_FORMAT',
  'METRICS_TOKEN', 'OTEL_ENABLED', 'ARTIFACTS_LEVEL', 'STORAGE_PLAN_GB', 'DISABLE_REST', 'DISABLE_MCP', 'DISABLE_OPENAPI',
  'DISABLE_TUNNEL', 'DISABLE_BROWSER',
] as const;

type Q = Pick<pg.ClientBase, 'query'>;

const toRecord = (rows: { k: string; n: number }[]): Record<string, number> => Object.fromEntries(rows.map((r) => [r.k, r.n]));

export async function buildDiagnostics(
  db: Q,
  input: { env: NodeJS.ProcessEnv; runtimeVersion: string; doctor: DoctorReport; now?: Date },
): Promise<Diagnostics> {
  const { rows: ver } = await db.query<{ v: string }>("SELECT current_setting('server_version') AS v");
  const { rows: names } = await db.query<{ key: string }>('SELECT key FROM settings ORDER BY key');
  const { rows: users } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
  const { rows: apis } = await db.query<{ k: string; n: number }>('SELECT status AS k, count(*)::int AS n FROM apis GROUP BY status ORDER BY status');
  const { rows: runs } = await db.query<{ k: string; n: number }>('SELECT state AS k, count(*)::int AS n FROM runs GROUP BY state ORDER BY state');
  const { rows: sec } = await db.query<{ ok: number; unreadable: number }>(
    `SELECT count(*) FILTER (WHERE state = 'ok')::int AS ok, count(*) FILTER (WHERE state = 'unreadable')::int AS unreadable FROM secrets`,
  );
  const { rows: sched } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM schedules WHERE enabled');
  const { rows: beats } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM worker_heartbeats WHERE last_seen_at > now() - interval '45 seconds'");
  // `failure_class` est une énumération fermée (CHECK) : jamais de texte libre ici (`error_detail` n'est pas lu).
  const { rows: failures } = await db.query<{ failure_class: string; count: number; last_at: Date }>(
    `SELECT failure_class, count(*)::int AS count, max(coalesce(finished_at, created_at)) AS last_at
     FROM (SELECT failure_class, finished_at, created_at FROM runs WHERE failure_class IS NOT NULL ORDER BY created_at DESC LIMIT 200) recent
     GROUP BY failure_class ORDER BY last_at DESC LIMIT 10`,
  );
  const schema = { current: await currentSchemaVersion(db), expected: expectedSchemaVersion() };
  const diagnostics: Diagnostics = {
    format: 'runtime-diagnostics',
    format_version: 1,
    database_reachable: true,
    generated_at: (input.now ?? new Date()).toISOString(),
    versions: { runtime: input.runtimeVersion, node: process.versions.node, postgres: ver[0]?.v ?? 'inconnue', schema },
    settings_names: names.map((r) => r.key),
    env_names_set: DIAGNOSTIC_ENV_NAMES.filter((n) => input.env[n] !== undefined && input.env[n] !== ''),
    counters: {
      users: users[0]?.n ?? 0,
      apis_by_status: toRecord(apis),
      runs_by_state: toRecord(runs),
      secrets: { ok: sec[0]?.ok ?? 0, unreadable: sec[0]?.unreadable ?? 0 },
      schedules_enabled: sched[0]?.n ?? 0,
      workers_alive: beats[0]?.n ?? 0,
    },
    last_failure_classes: failures.map((f) => ({ failure_class: f.failure_class, count: f.count, last_at: f.last_at.toISOString() })),
    doctor: { exit_code: input.doctor.exitCode, checks: input.doctor.checks.map(({ id, status, code }) => ({ id, status, code })) },
  };
  // Dernière couche (08 § 3) : balayage des valeurs de secret connues du processus, même si rien ne devrait en contenir.
  return redact(diagnostics);
}

/** Base injoignable : le fichier ne porte que ce que l'on sait sans elle (versions locales, noms de variables, `doctor`). */
export function buildOfflineDiagnostics(input: { env: NodeJS.ProcessEnv; runtimeVersion: string; doctor: DoctorReport; now?: Date }): Diagnostics {
  return redact({
    format: 'runtime-diagnostics',
    format_version: 1,
    database_reachable: false,
    generated_at: (input.now ?? new Date()).toISOString(),
    versions: { runtime: input.runtimeVersion, node: process.versions.node, postgres: 'inconnue', schema: { current: null, expected: expectedSchemaVersion() } },
    settings_names: [],
    env_names_set: DIAGNOSTIC_ENV_NAMES.filter((n) => input.env[n] !== undefined && input.env[n] !== ''),
    counters: null,
    last_failure_classes: [],
    doctor: { exit_code: input.doctor.exitCode, checks: input.doctor.checks.map(({ id, status, code }) => ({ id, status, code })) },
  } satisfies Diagnostics);
}
