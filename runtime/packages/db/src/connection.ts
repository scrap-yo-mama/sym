// Connexions PostgreSQL (14 § 2 et § 4) : DATABASE_URL pour les requêtes, DATABASE_URL_DIRECT (défaut : DATABASE_URL)
// pour LISTEN, pg-boss, migrations et verrous. Un pooler en mode transaction casse LISTEN et les verrous de session :
// sans URL directe, démarrage refusé avec le message « connexion de session requise ».
import { randomBytes } from 'node:crypto';
import pg from 'pg';

export class DatabaseConfigError extends Error {
  override name = 'DatabaseConfigError';
}

export type Connections = {
  /** URL des requêtes applicatives (peut viser un pooler). */
  appUrl: string;
  /** URL de session : LISTEN/NOTIFY, pg-boss, migrations, pg_advisory_lock. */
  sessionUrl: string;
};

export type SessionProbe = (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** Hôte et port d'une URL, sans identifiants (pour les messages). */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}`;
  } catch {
    return '(URL illisible)';
  }
}

/**
 * Heuristique documentée (packages/db/README.md) : signatures connues d'un pooler en mode transaction.
 * Renvoie la raison, ou null si rien ne l'indique (la sonde réelle tranche ensuite).
 */
export function transactionPoolerHint(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DatabaseConfigError('DATABASE_URL illisible : URL PostgreSQL attendue (postgres://utilisateur:motdepasse@hôte:port/base)');
  }
  if (u.port === '6543') return 'port 6543 (pooler Supabase/Supavisor en mode transaction)';
  if (/-pooler\./i.test(u.hostname)) return 'hôte « -pooler » (pooler Neon, PgBouncer en mode transaction)';
  if (u.searchParams.get('pgbouncer') === 'true') return 'paramètre pgbouncer=true';
  return null;
}

/**
 * Sonde réelle : le même client garde-t-il son backend (pg_backend_pid stable) et reçoit-il un NOTIFY émis
 * depuis une autre connexion ? Derrière un pooler en mode transaction, l'un ou l'autre échoue.
 */
export async function probeSessionSupport(url: string, timeoutMs = 3000): Promise<{ ok: true } | { ok: false; reason: string }> {
  const listener = new pg.Client({ connectionString: url, application_name: 'runtime-probe' });
  const notifier = new pg.Client({ connectionString: url, application_name: 'runtime-probe' });
  await listener.connect();
  try {
    await notifier.connect();
    const pids = [];
    for (let i = 0; i < 3; i += 1) {
      const { rows } = await listener.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      pids.push(rows[0]?.pid);
    }
    if (new Set(pids).size > 1) return { ok: false, reason: 'pg_backend_pid change entre deux requêtes' };

    const channel = `runtime_probe_${randomBytes(6).toString('hex')}`;
    const received = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      listener.on('notification', (msg) => {
        if (msg.channel === channel) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    await listener.query(`LISTEN ${channel}`);
    await notifier.query('SELECT pg_notify($1, $2)', [channel, 'ping']);
    const ok = await received;
    await listener.query(`UNLISTEN ${channel}`).catch(() => {});
    return ok ? { ok: true } : { ok: false, reason: `NOTIFY non reçu en ${timeoutMs} ms (LISTEN inopérant)` };
  } finally {
    await notifier.end().catch(() => {});
    await listener.end().catch(() => {});
  }
}

/**
 * Résout les deux URL et refuse de démarrer si la connexion de session n'en est pas une.
 * `probe` est injectable pour simuler un pooler dans les tests.
 */
export async function resolveConnections(
  env: NodeJS.ProcessEnv,
  probe: SessionProbe = (url) => probeSessionSupport(url),
): Promise<Connections> {
  const appUrl = env.DATABASE_URL;
  if (!appUrl) {
    throw new DatabaseConfigError('DATABASE_URL manquante : URL de la base PostgreSQL (≥ 15) obligatoire');
  }
  const direct = env.DATABASE_URL_DIRECT;
  const sessionUrl = direct || appUrl;
  const variable = direct ? 'DATABASE_URL_DIRECT' : 'DATABASE_URL';
  const refuse = (reason: string) =>
    new DatabaseConfigError(
      direct
        ? `connexion de session requise : DATABASE_URL_DIRECT (${describeUrl(sessionUrl)}) passe par un pooler en mode transaction (${reason}). ` +
            'Indiquez l\'URL directe de la base, sans pooler.'
        : `connexion de session requise : DATABASE_URL (${describeUrl(sessionUrl)}) passe par un pooler en mode transaction (${reason}). ` +
            'LISTEN, pg-boss, les migrations et les verrous exigent une connexion directe : définissez DATABASE_URL_DIRECT ' +
            '(URL directe de la base, sans pooler, ou pooler en mode session).',
    );
  const hint = transactionPoolerHint(sessionUrl);
  if (hint) throw refuse(hint);
  const result = await probe(sessionUrl).catch((error: Error) => {
    throw new DatabaseConfigError(`${variable} (${describeUrl(sessionUrl)}) injoignable : ${error.message}`);
  });
  if (!result.ok) throw refuse(result.reason);
  return { appUrl, sessionUrl };
}
