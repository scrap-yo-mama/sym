// Garde-fous du processus du spike (protocole §13, §11) : environnement nettoyé et compteur réseau côté Node.
// Le compteur écoute les canaux de diagnostic de Node (fetch/undici et http/https) : toute requête sortante du processus
// (Stagehand, SDK Browserbase, client LLM) y passe, sans patch des modules.
import { subscribe, unsubscribe } from 'node:diagnostics_channel';

/** Variables qui activent un service Browserbase ou la recherche Brave (§13, §15) : le harnais refuse de démarrer. */
const FORBIDDEN_ENV = [
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'BB_API_KEY',
  'BB_PROJECT_ID',
  'BRAVE_API_KEY',
  'STAGEHAND_API_URL',
  'STAGEHAND_BASE_URL',
  'BROWSERBASE_FLOW_LOGS',
  'BROWSERBASE_CONFIG_DIR',
] as const;

export function forbiddenEnvPresent(env: NodeJS.ProcessEnv = process.env): string[] {
  return FORBIDDEN_ENV.filter((name) => env[name] !== undefined);
}

/** Options de Stagehand qui ouvrent une session Browserbase ou la résolution de captcha (X1) : interdites. */
const FORBIDDEN_STAGEHAND_OPTIONS = ['apiKey', 'projectId', 'browserbaseSessionCreateParams', 'browserbaseSessionID', 'keepAlive'] as const;

/**
 * Stagehand en local seulement (protocole §13, §15 ; exclusion X1) : `env: 'LOCAL'`, `disableAPI: true`, aucune option
 * de session Browserbase, aucune résolution de captcha (`waitForCaptchaSolves` et toute option « captcha » ; le
 * `CaptchaSolver` de Stagehand n'agit qu'en `BROWSERBASE`), environnement sans clé Browserbase ni Brave. Appelé avant
 * chaque `new Stagehand(...)` ; la tâche 2.4 le reprend tel quel en production.
 */
export function assertStagehandLocalOnly(options: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];
  if (options['env'] !== 'LOCAL') problems.push(`env doit valoir LOCAL (reçu : ${String(options['env'])})`);
  if (options['disableAPI'] !== true) problems.push('disableAPI doit valoir true');
  for (const key of Object.keys(options)) {
    if (options[key] === undefined) continue;
    const forbidden = (FORBIDDEN_STAGEHAND_OPTIONS as readonly string[]).includes(key) || /browserbase/i.test(key) || (/captcha/i.test(key) && options[key] !== false);
    if (forbidden) problems.push(`option ${key} interdite`);
  }
  const vars = forbiddenEnvPresent(env);
  if (vars.length > 0) problems.push(`variables d'environnement interdites : ${vars.join(', ')}`);
  if (problems.length > 0) throw new Error(`Stagehand hors du mode local : ${problems.join(' ; ')}`);
}

interface NetEvent {
  readonly host: string;
  readonly channel: 'undici' | 'http';
  readonly allowed: boolean;
}

export interface NetMonitor {
  readonly events: readonly NetEvent[];
  /** Requêtes hors boucle locale et hors fournisseur LLM (arrêt du spike, §11). */
  offsite(): NetEvent[];
  count(): number;
  reset(): void;
  stop(): void;
}

const LOCAL = /^(127\.0\.0\.1|localhost|\[?::1\]?|[a-z0-9_.-]+\.localhost)$/i;

/** `allowedHosts` : hôtes externes permis (l'endpoint du fournisseur LLM). La boucle locale est toujours permise. */
export function startNetMonitor(allowedHosts: readonly string[]): NetMonitor {
  let events: NetEvent[] = [];
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const record = (channel: NetEvent['channel'], rawHost: string | undefined): void => {
    const host = (rawHost ?? '').toLowerCase().replace(/:\d+$/, '');
    events.push({ host, channel, allowed: LOCAL.test(host) || allowed.has(host) });
  };
  const onUndici = (message: unknown): void => {
    const request = (message as { request?: { origin?: string | URL } }).request;
    const origin = request?.origin;
    let host: string | undefined;
    try {
      host = origin === undefined ? undefined : new URL(String(origin)).host;
    } catch {
      host = String(origin);
    }
    record('undici', host);
  };
  const onHttp = (message: unknown): void => {
    const request = (message as { request?: { host?: string; getHeader?: (n: string) => unknown } }).request;
    const header = request?.getHeader?.('host');
    record('http', request?.host ?? (typeof header === 'string' ? header : undefined));
  };
  subscribe('undici:request:create', onUndici);
  subscribe('http.client.request.start', onHttp);
  return {
    get events() {
      return events;
    },
    offsite: () => events.filter((e) => !e.allowed),
    count: () => events.length,
    reset: () => {
      events = [];
    },
    stop: () => {
      unsubscribe('undici:request:create', onUndici);
      unsubscribe('http.client.request.start', onHttp);
    },
  };
}
