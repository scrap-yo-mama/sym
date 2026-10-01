// SPDX-License-Identifier: AGPL-3.0-only
// `runtime doctor` (14 § 7) : contrôles LOCAUX, aucun appel réseau hors de la base. Lecture seule : rien n'est écrit
// (pas même `key_check` sur une base neuve). Chaque contrôle porte un `code` stable ; seul `message` est un texte libre
// destiné au terminal (le fichier de `runtime diagnostics` n'embarque que `id`, `status` et `code`).
// Code de sortie : 0 tout va bien, 1 avertissement, 2 erreur.
import { loadKeyring, MasterKeyError, verifyKeyCheck, type KeyCheckRecord } from '@runtime/core';
import pg from 'pg';
import { readBackupDeclaration } from './backup.js';
import { connectionBudget } from './budget.js';
import { schemaCompatibility } from './schema-version.js';
import { DatabaseConfigError, resolveConnections, type SessionProbe } from '../connection.js';
import { MIN_SERVER_VERSION_NUM, currentSchemaVersion, expectedSchemaVersion } from '../migrate.js';
import { KEY_CHECK_SETTING, REKEY_STATE_SETTING } from '../secrets.js';

export type CheckStatus = 'ok' | 'warn' | 'error';

export const DOCTOR_CHECK_IDS = [
  'database',
  'pooler',
  'postgres_version',
  'schema',
  'app_role',
  'key_check',
  'secrets',
  'connections',
  'workers',
  'storage',
  'backup',
  'public_url',
  'bootstrap_token',
] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

export type DoctorCheck = { id: DoctorCheckId; status: CheckStatus; code: string; message: string };
export type DoctorReport = { checks: DoctorCheck[]; exitCode: 0 | 1 | 2 };

/** Un worker est mort après 45 s sans battement (14 § 3, seuil à valider). */
export const WORKER_DEAD_AFTER_SECONDS = 45;
/** Sauvegarde déclarée plus vieille que cela : avertissement (choix de conception, à valider en 4.4). */
export const BACKUP_MAX_AGE_DAYS = 7;
export const STORAGE_WARN_RATIO = 0.8;
export const STORAGE_ERROR_RATIO = 0.95;
const DEFAULT_POOL_MAX = 5;
const DEFAULT_WORKER_CONCURRENCY = 5;

export type DoctorInput = {
  env: NodeJS.ProcessEnv;
  /** Sonde de connexion de session (injectable dans les tests). */
  probe?: SessionProbe;
  now?: () => Date;
  /** Version de schéma attendue par ce code (défaut : dernière migration livrée). */
  expectedSchema?: number;
};

const GIB = 1024 ** 3;

function check(id: DoctorCheckId, status: CheckStatus, code: string, message: string): DoctorCheck {
  return { id, status, code, message };
}

export function doctorExitCode(checks: readonly DoctorCheck[]): 0 | 1 | 2 {
  if (checks.some((c) => c.status === 'error')) return 2;
  return checks.some((c) => c.status === 'warn') ? 1 : 0;
}

export function formatDoctor(report: DoctorReport): string {
  const tag: Record<CheckStatus, string> = { ok: 'ok          ', warn: 'avertissement', error: 'erreur       ' };
  const lines = report.checks.map((c) => `[${tag[c.status]}] ${c.id} : ${c.message}`);
  const count = (s: CheckStatus) => report.checks.filter((c) => c.status === s).length;
  lines.push(`doctor : ${count('ok')} ok, ${count('warn')} avertissement(s), ${count('error')} erreur(s) (code de sortie ${report.exitCode}).`);
  return lines.join('\n');
}

function positiveInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

function publicUrlCheck(env: NodeJS.ProcessEnv): DoctorCheck {
  const raw = env['PUBLIC_URL'];
  if (!raw) return check('public_url', 'warn', 'public_url_missing', 'PUBLIC_URL absente de cet environnement : l’extension, le MCP et les cookies `Secure` en dépendent.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return check('public_url', 'error', 'public_url_invalid', 'PUBLIC_URL illisible : URL http(s) de l’instance attendue (ex. https://runtime.example.org).');
  }
  if (url.protocol === 'https:') return check('public_url', 'ok', 'public_url_https', 'PUBLIC_URL en HTTPS.');
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return check('public_url', 'ok', 'public_url_loopback', 'PUBLIC_URL en HTTP sur la boucle locale (essai en local).');
  return check('public_url', 'warn', 'public_url_http', 'PUBLIC_URL n’est pas en HTTPS : les cookies `Secure` et l’extension exigent HTTPS hors de la boucle locale.');
}

type Q = Pick<pg.ClientBase, 'query'>;

async function readKeyCheck(db: Q): Promise<{ record: KeyCheckRecord | undefined; rekeyInProgress: boolean }> {
  const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings WHERE key = ANY($1)', [
    [KEY_CHECK_SETTING, REKEY_STATE_SETTING],
  ]);
  return {
    record: rows.find((r) => r.key === KEY_CHECK_SETTING)?.value as KeyCheckRecord | undefined,
    rekeyInProgress: rows.some((r) => r.key === REKEY_STATE_SETTING),
  };
}

async function keyChecks(db: Q, env: NodeJS.ProcessEnv): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  let keyring;
  try {
    keyring = loadKeyring({ ...env });
  } catch (error) {
    // Le message de MasterKeyError nomme la variable et `runtime keygen`, jamais la valeur.
    const detail = error instanceof MasterKeyError ? error.message : 'MASTER_KEY illisible';
    return [check('key_check', 'error', 'master_key_invalid', detail)];
  }
  const { record, rekeyInProgress } = await readKeyCheck(db);
  const { rows: sec } = await db.query<{ ok: number; unreadable: number }>(
    `SELECT count(*) FILTER (WHERE state = 'ok')::int AS ok, count(*) FILTER (WHERE state = 'unreadable')::int AS unreadable FROM secrets`,
  );
  const ok = sec[0]?.ok ?? 0;
  const unreadable = sec[0]?.unreadable ?? 0;
  if (rekeyInProgress) {
    out.push(check('key_check', 'error', 'rekey_incomplete', 'rotation de clé inachevée : relancez `runtime rekey --confirm` (MASTER_KEY nouvelle, MASTER_KEY_PREVIOUS ancienne).'));
  } else if (!record) {
    out.push(
      ok > 0
        ? check('key_check', 'error', 'key_check_missing', 'settings.key_check absent alors que des secrets existent : base incohérente.')
        : check('key_check', 'ok', 'key_check_pending', 'base neuve : le témoin de clé sera créé au premier démarrage.'),
    );
  } else if (!verifyKeyCheck(record, keyring.current)) {
    out.push(
      check(
        'key_check',
        'error',
        'key_mismatch',
        `MASTER_KEY (empreinte ${keyring.current.fingerprint}) ne correspond pas à cette base (empreinte ${record.fingerprint}). ` +
          'Remettez la clé d’origine ; clé perdue : `runtime secrets accept-key-loss --confirm` (les secrets restent à ressaisir).',
      ),
    );
  } else {
    const { rows } = await db.query<{ v: number }>("SELECT DISTINCT kek_version AS v FROM secrets WHERE state = 'ok' AND kek_version <> $1 ORDER BY 1", [record.version]);
    out.push(
      rows.length > 0
        ? check('key_check', 'error', 'key_versions', `secrets sous une version de clé inconnue (${rows.map((r) => r.v).join(', ')} ; courante ${record.version}).`)
        : check('key_check', 'ok', 'key_ok', `clé vérifiée (empreinte ${keyring.current.fingerprint}, version ${record.version}).`),
    );
  }
  out.push(
    unreadable > 0
      ? check('secrets', 'warn', 'secrets_unreadable', `${unreadable} secret(s) illisible(s) (« À ressaisir ») : ressaisissez-les dans Réglages.`)
      : check('secrets', 'ok', 'secrets_readable', `${ok} secret(s), tous lisibles.`),
  );
  return out;
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const { env } = input;
  const now = (input.now ?? (() => new Date()))();
  const checks: DoctorCheck[] = [];
  const finish = (): DoctorReport => {
    const order = new Map(DOCTOR_CHECK_IDS.map((id, i) => [id, i]));
    checks.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return { checks, exitCode: doctorExitCode(checks) };
  };

  // Variables seules : valables même si la base est inaccessible.
  checks.push(publicUrlCheck(env));

  let sessionUrl: string;
  try {
    ({ sessionUrl } = await resolveConnections(env, input.probe));
    checks.push(check('pooler', 'ok', 'session_connection', env['DATABASE_URL_DIRECT'] ? 'connexion de session directe (DATABASE_URL_DIRECT).' : 'DATABASE_URL accepte LISTEN et les verrous de session.'));
  } catch (error) {
    const message = error instanceof DatabaseConfigError ? error.message : 'configuration de base illisible';
    const pooler = /pooler/.test(message);
    checks.push(check(pooler ? 'pooler' : 'database', 'error', pooler ? 'pooler_transaction' : 'database_unreachable', message));
    return finish();
  }

  const client = new pg.Client({ connectionString: sessionUrl, application_name: 'runtime-doctor', connectionTimeoutMillis: 5000 });
  client.on('error', () => {});
  try {
    await client.connect();
  } catch {
    checks.push(check('database', 'error', 'database_unreachable', 'base injoignable : vérifiez DATABASE_URL (ou DATABASE_URL_DIRECT) et que PostgreSQL tourne.'));
    return finish();
  }
  try {
    checks.push(check('database', 'ok', 'database_ok', 'base joignable.'));

    const { rows: ver } = await client.query<{ num: string; version: string }>("SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS version");
    const num = Number(ver[0]?.num);
    const versionLabel = ver[0]?.version ?? 'inconnue';
    if (!(num >= MIN_SERVER_VERSION_NUM)) {
      checks.push(check('postgres_version', 'error', 'pg_too_old', `PostgreSQL ${versionLabel} : 15 minimum requis (16 recommandé).`));
    } else if (num < 160000) {
      checks.push(check('postgres_version', 'warn', 'pg_15', `PostgreSQL ${versionLabel} : la 15 perd son support le 2027-11-11, 16 recommandé.`));
    } else {
      checks.push(check('postgres_version', 'ok', 'pg_ok', `PostgreSQL ${versionLabel}.`));
    }

    const expected = input.expectedSchema ?? expectedSchemaVersion();
    const found = await currentSchemaVersion(client);
    const compat = schemaCompatibility(found, expected);
    checks.push(
      compat === 'ok'
        ? check('schema', 'ok', 'schema_ok', `schéma en version ${found}.`)
        : compat === 'behind'
          ? check('schema', 'error', 'schema_behind', `schéma en version ${found}, ${expected} attendue : lancez \`runtime migrate\`.`)
          : check('schema', 'error', 'schema_ahead', `schéma en version ${found}, ce code n'attend que la ${expected} : image plus ancienne que la base, restaurez la sauvegarde prise avant la mise à jour.`),
    );
    if (compat !== 'ok') return finish(); // les contrôles suivants lisent des tables du schéma attendu

    // Rôle de cluster de la RLS (migration 0003) : un pg_dump ne l'emporte pas (voir roles.ts).
    const { rows: role } = await client.query<{ exists: boolean; member: boolean; bypass: boolean; grants: boolean }>(
      `WITH r AS (SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_app') AS exists)
       SELECT r.exists,
              CASE WHEN r.exists THEN pg_has_role(current_user, 'runtime_app', 'member') ELSE false END AS member,
              CASE WHEN r.exists THEN coalesce((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'runtime_app'), false) ELSE false END AS bypass,
              CASE WHEN r.exists THEN has_table_privilege('runtime_app', 'public.apis', 'SELECT') ELSE false END AS grants
       FROM r`,
    );
    const r = role[0] ?? { exists: false, member: false, bypass: false, grants: false };
    checks.push(
      !r.exists
        ? check('app_role', 'error', 'app_role_missing', 'rôle `runtime_app` absent du cluster (la RLS ne peut pas s’appliquer) : après une restauration sur un autre cluster, recommencez sur une base vide avec `runtime restore-prepare` AVANT `pg_restore` (docs/exploitation.md).')
        : r.bypass
          ? check('app_role', 'error', 'app_role_bypass', 'le rôle `runtime_app` contourne la RLS (SUPERUSER ou BYPASSRLS) : à corriger avant toute utilisation.')
          : !r.member
            ? check('app_role', 'error', 'app_role_not_member', 'l’utilisateur de la base ne peut pas prendre le rôle `runtime_app` : `runtime restore-prepare` ou `GRANT runtime_app TO <utilisateur>`.')
            : !r.grants
              ? check('app_role', 'error', 'app_role_no_grants', 'le rôle `runtime_app` n’a pas ses droits sur les tables (restauration faite sans `runtime restore-prepare` ?) : recommencez la restauration sur une base vide, après `runtime restore-prepare`.')
              : check('app_role', 'ok', 'app_role_ok', 'rôle `runtime_app` présent, avec ses droits, sans contournement de la RLS.'),
    );

    checks.push(...(await keyChecks(client, env)));

    // Budget de connexions : 1 web (nombre d'instances non connu de la base), workers vivants (au moins 1).
    const poolMax = positiveInt(env['DB_POOL_MAX'], DEFAULT_POOL_MAX);
    const concurrency = positiveInt(env['WORKER_CONCURRENCY'], DEFAULT_WORKER_CONCURRENCY);
    const { rows: beats } = await client.query<{ alive: number; dead: number }>(
      `SELECT count(*) FILTER (WHERE last_seen_at > now() - make_interval(secs => $1))::int AS alive,
              count(*) FILTER (WHERE last_seen_at <= now() - make_interval(secs => $1))::int AS dead
       FROM worker_heartbeats`,
      [WORKER_DEAD_AFTER_SECONDS],
    );
    const alive = beats[0]?.alive ?? 0;
    const dead = beats[0]?.dead ?? 0;
    const { rows: mc } = await client.query<{ max: string }>("SELECT current_setting('max_connections') AS max");
    const maxConnections = Number(mc[0]?.max);
    if (poolMax === null) {
      checks.push(check('connections', 'error', 'db_pool_max_invalid', 'DB_POOL_MAX invalide : entier ≥ 1 attendu.'));
    } else if (concurrency === null || concurrency > poolMax) {
      checks.push(check('connections', 'error', 'concurrency_above_pool', `WORKER_CONCURRENCY (${concurrency ?? 'invalide'}) doit rester ≤ DB_POOL_MAX (${poolMax}).`));
    } else {
      const b = connectionBudget({ poolMax, webInstances: 1, workerInstances: Math.max(1, alive), maxConnections });
      const detail = `${b.total} connexion(s) prévue(s) sur ${b.maxConnections} (web 1 × ${poolMax + 1}, ${Math.max(1, alive)} worker(s)).`;
      checks.push(
        b.level === 'ok'
          ? check('connections', 'ok', 'budget_ok', detail)
          : b.level === 'warn'
            ? check('connections', 'warn', 'budget_near_limit', `${detail} Au-delà de 80 % de max_connections : aucune place pour une instance de plus.`)
            : check('connections', 'error', 'budget_exceeded', `${detail} Dépasse max_connections : réduisez DB_POOL_MAX ou le nombre d'instances.`),
      );
    }

    checks.push(
      alive === 0
        ? check('workers', 'warn', 'no_worker', 'aucun worker vivant (battement de moins de 45 s) : aucun run ne sera exécuté.')
        : check('workers', 'ok', 'workers_alive', `${alive} worker(s) vivant(s)${dead > 0 ? `, ${dead} sans battement depuis plus de 45 s` : ''}.`),
    );

    // Taille du plan : taille de la base contre STORAGE_PLAN_GB (14 § 9 : alerte à 80 %, refus des runs à 95 %).
    const { rows: size } = await client.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes');
    const bytes = Number(size[0]?.bytes ?? 0);
    const gb = (n: number) => (n / GIB).toFixed(2);
    const planRaw = env['STORAGE_PLAN_GB'];
    if (planRaw === undefined || planRaw === '') {
      checks.push(check('storage', 'ok', 'storage_unguarded', `base de ${gb(bytes)} Go ; STORAGE_PLAN_GB non posée : pas de garde disque.`));
    } else {
      const plan = Number(planRaw);
      if (!(plan > 0) || !Number.isFinite(plan)) {
        checks.push(check('storage', 'error', 'storage_plan_invalid', 'STORAGE_PLAN_GB invalide : nombre de Go > 0 attendu.'));
      } else {
        const ratio = bytes / (plan * GIB);
        const detail = `base de ${gb(bytes)} Go sur un plan de ${plan} Go (${Math.round(ratio * 100)} %).`;
        checks.push(
          ratio >= STORAGE_ERROR_RATIO
            ? check('storage', 'error', 'storage_full', `${detail} Les nouveaux runs sont refusés (storage_full) : purgez ou agrandissez le plan.`)
            : ratio >= STORAGE_WARN_RATIO
              ? check('storage', 'warn', 'storage_80', `${detail} Alerte à 80 % : agrandissez le plan ou réduisez la rétention.`)
              : check('storage', 'ok', 'storage_ok', detail),
        );
      }
    }

    const backupAt = await readBackupDeclaration(client);
    if (!backupAt) {
      checks.push(check('backup', 'warn', 'backup_never', 'aucune sauvegarde déclarée : faites un `pg_dump` (et gardez MASTER_KEY à part), puis `runtime backup declare`.'));
    } else {
      const ageDays = (now.getTime() - backupAt.getTime()) / 86_400_000;
      checks.push(
        ageDays > BACKUP_MAX_AGE_DAYS
          ? check('backup', 'warn', 'backup_old', `dernière sauvegarde déclarée il y a ${Math.floor(ageDays)} jours (seuil ${BACKUP_MAX_AGE_DAYS}).`)
          : check('backup', 'ok', 'backup_recent', `dernière sauvegarde déclarée le ${backupAt.toISOString().slice(0, 10)}.`),
      );
    }

    const tokenSet = Boolean(env['ADMIN_BOOTSTRAP_TOKEN'] || env['ADMIN_BOOTSTRAP_TOKEN_FILE']);
    const { rows: owners } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role = 'owner'");
    const hasOwner = (owners[0]?.n ?? 0) > 0;
    checks.push(
      tokenSet && hasOwner
        ? check('bootstrap_token', 'warn', 'bootstrap_token_set', 'ADMIN_BOOTSTRAP_TOKEN est encore posé alors qu’un owner existe : retirez-le.')
        : check('bootstrap_token', 'ok', tokenSet ? 'bootstrap_token_needed' : 'bootstrap_token_absent', tokenSet ? 'jeton d’amorçage posé, aucun owner encore.' : 'aucun jeton d’amorçage posé.'),
    );
  } finally {
    await client.end().catch(() => {});
  }
  return finish();
}
