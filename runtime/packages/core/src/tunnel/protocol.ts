// SPDX-License-Identifier: AGPL-3.0-only
// Protocole du tunnel WSS (07 §6 et §8, tâche 2.7). Module pur, sans Node ni navigateur : la passerelle (server), le
// worker et l'extension importent les mêmes types et les mêmes validations (`@runtime/core/tunnel`).
//
// Messages (un objet JSON par message WebSocket, schéma strict : tout champ en plus est une violation de protocole) :
// - extension → instance : `hello` (jeton HORS URL, premier message), `ping` (toutes les 20 s), `result` (réponse
//   découpée en morceaux numérotés `seq` / `last`, chacun ≤ 1 Mio) ;
// - instance → extension : `welcome`, `pong`, `cmd` (jeu fermé de quatre commandes).
// Codes de fermeture applicatifs : 4401 jeton refusé ou révoqué, 4409 remplacée par une connexion plus récente du même
// utilisateur, 4400 violation de protocole, 4429 débit dépassé, 4408 aucun `hello` à temps ou connexion muette.

export const TUNNEL_PATH = '/api/extension/tunnel';
/** `maxPayload` de la passerelle (07 §6) : 1 Mio. Aucun message ne le dépasse, réponses découpées comprises. */
export const TUNNEL_MAX_PAYLOAD = 1024 * 1024;
/** Ping applicatif de l'extension (07 §4) : maintient le service worker en vie (Chrome 116+). */
export const TUNNEL_PING_MS = 20_000;
/** Alarme `chrome.alarms` de reconnexion (07 §4, Chrome 120+ : 30 s minimum). */
export const TUNNEL_ALARM_PERIOD_MINUTES = 0.5;
/**
 * Connexion muette (aucun message, ping compris) au-delà de ce délai : fermée par la passerelle (4408) et détachée de sa
 * ligne `tunnels`. Trois pings manqués : portable en veille, coupure réseau sans FIN (connexion à moitié ouverte).
 */
export const TUNNEL_IDLE_TIMEOUT_MS = 3 * TUNNEL_PING_MS;
/** Délai pour recevoir `hello` après l'ouverture. */
export const TUNNEL_HELLO_TIMEOUT_MS = 10_000;
/** Délai par défaut d'une commande (07 §8). */
export const TUNNEL_DEFAULT_TIMEOUT_MS = 30_000;
export const TUNNEL_MAX_TIMEOUT_MS = 120_000;
/** Taille maximale d'une réponse réassemblée (au-delà : `response_too_large`). */
export const TUNNEL_MAX_RESULT_BYTES = 32 * 1024 * 1024;

export const WS_CLOSE = Object.freeze({
  protocol: 4400,
  unauthorized: 4401,
  helloTimeout: 4408,
  idleTimeout: 4408,
  replaced: 4409,
  rateLimited: 4429,
} as const);

export const TUNNEL_COMMANDS = Object.freeze(['http_fetch', 'page_fetch', 'page_script', 'agent_step'] as const);
export type TunnelCommand = (typeof TUNNEL_COMMANDS)[number];

/**
 * Erreurs d'une commande (07 §8 et §5). `method_not_allowed` : commande ou méthode hors du jeu fermé, argument qui
 * ressemble à du code (rien n'est évalué) ; `challenge_in_tunnel` : défi détecté, plus aucune commande sur l'onglet.
 */
export const TUNNEL_ERRORS = Object.freeze([
  'method_not_allowed',
  'stale_ref',
  'write_action_blocked',
  'challenge_in_tunnel',
  'domain_not_allowed',
  'timeout',
  'tab_unavailable',
  'fetch_failed',
  'response_too_large',
  'permission_required',
  'tunnel_disconnected',
  'owner_mismatch',
] as const);
export type TunnelError = (typeof TUNNEL_ERRORS)[number];

export type HelloFrame = { readonly type: 'hello'; readonly token: string; readonly version: string };
export type PingFrame = { readonly type: 'ping' };
/** Morceau d'une réponse : `data` est une tranche du JSON de `TunnelResult` ; `seq` part de 0, `last` clôt. */
export type ResultFrame = { readonly type: 'result'; readonly job_id: string; readonly seq: number; readonly last: boolean; readonly data: string };
export type ExtensionFrame = HelloFrame | PingFrame | ResultFrame;

export type WelcomeFrame = { readonly type: 'welcome'; readonly email: string; readonly ping_ms: number; readonly max_payload: number };
export type PongFrame = { readonly type: 'pong' };
/** Commande (07 §8). `allow_write_actions` : confirmé dans l'interface pour l'API du run (08 §4). */
export type CommandFrame = {
  readonly type: 'cmd';
  readonly job_id: string;
  readonly run_id: string;
  readonly cmd: TunnelCommand;
  readonly domain: string;
  readonly args: unknown;
  readonly timeout_ms: number;
  readonly allow_write_actions: boolean;
};
export type ServerFrame = WelcomeFrame | PongFrame | CommandFrame;

/** Réponse réassemblée d'une commande (07 §8). `body` dépend de la commande (`FetchResponse`, valeur CDP, `agent_step`). */
export type TunnelResult = {
  readonly ok: boolean;
  readonly error: TunnelError | null;
  readonly ms: number;
  readonly snapshot_id: string | null;
  readonly body: unknown;
};

/** Corps de `http_fetch` / `page_fetch`. */
export type FetchResponse = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly url: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (r: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(r).every((k) => keys.includes(k));
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isTunnelError(value: unknown): value is TunnelError {
  return typeof value === 'string' && (TUNNEL_ERRORS as readonly string[]).includes(value);
}

/** JSON d'un message, ou `null` (texte invalide, binaire, trop gros). */
function parseJson(raw: string): unknown {
  if (raw.length > TUNNEL_MAX_PAYLOAD) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Message reçu de l'extension, validé ; `null` = violation de protocole (la passerelle ferme en 4400). */
export function parseExtensionFrame(raw: string): ExtensionFrame | null {
  const m = parseJson(raw);
  if (!isRecord(m)) return null;
  switch (m['type']) {
    case 'hello':
      return onlyKeys(m, ['type', 'token', 'version']) && str(m['token'], 256) && str(m['version'], 64) ? { type: 'hello', token: m['token'], version: m['version'] } : null;
    case 'ping':
      return onlyKeys(m, ['type']) ? { type: 'ping' } : null;
    case 'result':
      return onlyKeys(m, ['type', 'job_id', 'seq', 'last', 'data']) && isUuid(m['job_id']) && int(m['seq'], 0, 100_000) && typeof m['last'] === 'boolean' && typeof m['data'] === 'string'
        ? { type: 'result', job_id: m['job_id'], seq: m['seq'], last: m['last'], data: m['data'] }
        : null;
    default:
      return null;
  }
}

/** Message reçu de l'instance, validé (côté extension) ; `null` = ignoré et journalisé. */
export function parseServerFrame(raw: string): ServerFrame | null {
  const m = parseJson(raw);
  if (!isRecord(m)) return null;
  switch (m['type']) {
    case 'welcome':
      return onlyKeys(m, ['type', 'email', 'ping_ms', 'max_payload']) && str(m['email'], 320) && int(m['ping_ms'], 1000, 60_000) && int(m['max_payload'], 1024, TUNNEL_MAX_PAYLOAD)
        ? { type: 'welcome', email: m['email'], ping_ms: m['ping_ms'], max_payload: m['max_payload'] }
        : null;
    case 'pong':
      return onlyKeys(m, ['type']) ? { type: 'pong' } : null;
    case 'cmd': {
      if (!onlyKeys(m, ['type', 'job_id', 'run_id', 'cmd', 'domain', 'args', 'timeout_ms', 'allow_write_actions'])) return null;
      const cmd = m['cmd'];
      if (!isUuid(m['job_id']) || !isUuid(m['run_id']) || !(TUNNEL_COMMANDS as readonly unknown[]).includes(cmd)) return null;
      if (!str(m['domain'], 253) || !int(m['timeout_ms'], 1, TUNNEL_MAX_TIMEOUT_MS) || typeof m['allow_write_actions'] !== 'boolean') return null;
      return {
        type: 'cmd',
        job_id: m['job_id'],
        run_id: m['run_id'],
        cmd: cmd as TunnelCommand,
        domain: m['domain'],
        args: m['args'],
        timeout_ms: m['timeout_ms'],
        allow_write_actions: m['allow_write_actions'],
      };
    }
    default:
      return null;
  }
}

/** Réponse réassemblée, validée ; `null` = hors contrat (jamais comptée comme un succès). */
export function parseTunnelResult(text: string): TunnelResult | null {
  let m: unknown;
  try {
    m = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(m) || !onlyKeys(m, ['ok', 'error', 'ms', 'snapshot_id', 'body'])) return null;
  const { ok, error, ms, snapshot_id: snapshotId } = m;
  if (typeof ok !== 'boolean' || !int(ms, 0, 3_600_000)) return null;
  if (!(error === null || isTunnelError(error)) || (ok && error !== null) || (!ok && error === null)) return null;
  if (!(snapshotId === null || str(snapshotId, 64))) return null;
  return { ok, error: error as TunnelError | null, ms: ms, snapshot_id: (snapshotId as string | null) ?? null, body: m['body'] ?? null };
}

/** Corps `FetchResponse` validé (statut, en-têtes en chaînes, corps texte, URL finale) ; `null` hors contrat. */
export function parseFetchResponse(body: unknown, maxBytes: number): FetchResponse | null {
  if (!isRecord(body) || !onlyKeys(body, ['status', 'headers', 'body', 'url'])) return null;
  if (!int(body['status'], 0, 999) || typeof body['body'] !== 'string' || !str(body['url'], 8192) || !isRecord(body['headers'])) return null;
  if (body['body'].length > maxBytes) return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(body['headers'])) {
    if (typeof value !== 'string' || name.length > 256 || value.length > 16_384) return null;
    headers[name.toLowerCase()] = value;
  }
  return { status: body['status'], headers, body: body['body'], url: body['url'] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Arguments des commandes `http_fetch` et `page_fetch`
// ---------------------------------------------------------------------------------------------------------------------

export const FETCH_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const);
/**
 * Verbes d'écriture d'une requête : bloqués sans `allow_write_actions` (fermé par défaut). POST n'en fait pas partie :
 * c'est le verbe des requêtes déclaratives E1/E2 (recherche, GraphQL ; contrat type de 04b, `allow_write_actions: false`),
 * déjà accepté sur le chemin serveur ; le DSL n'émet que GET et POST. La garde d'écriture du CDC (07 §5, 08 §4) vise les
 * clics d'envoi, tenue par `page_script` / `agent_step`. Un POST n'est jamais rejoué après une coupure.
 */
const WRITE_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);
/** Lectures pures, rejouables sans risque après une coupure. */
const REPLAYABLE_METHODS = new Set(['GET', 'HEAD']);
/**
 * En-têtes qu'une commande ne pose jamais : le navigateur attache lui-même cookies, origine et agent (07 §3) ; aucune
 * falsification d'identité ([_exclusions] X2) ; ni hôte ni connexion.
 */
const FORBIDDEN_HEADERS = new Set(['cookie', 'cookie2', 'origin', 'referer', 'user-agent', 'host', 'connection', 'content-length', 'proxy-authorization', 'sec-ch-ua', 'x-forwarded-for', 'forwarded']);
export const FETCH_MAX_REQUEST_BODY = 256 * 1024;
export const FETCH_DEFAULT_MAX_BYTES = 5_000_000;
const FETCH_MAX_BYTES_LIMIT = 20_000_000;

export type FetchArgs = {
  readonly url: string;
  readonly method: (typeof FETCH_METHODS)[number];
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly max_bytes: number;
};

export type ParsedArgs<T> = { readonly ok: true; readonly args: T } | { readonly ok: false; readonly error: 'method_not_allowed' | 'domain_not_allowed' | 'write_action_blocked'; readonly reason: string };
const refuse = <T>(error: 'method_not_allowed' | 'domain_not_allowed' | 'write_action_blocked', reason: string): ParsedArgs<T> => ({ ok: false, error, reason });

/** Vrai si `host` est le domaine connecté ou l'un de ses sous-domaines (jamais un suffixe sans point). */
export function hostWithinDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  return h === domain || h.endsWith(`.${domain}`);
}

/** URL http(s) d'une commande, dont l'hôte est dans `domain` ; `null` sinon (schéma, identifiants, autre domaine). */
export function commandUrl(raw: unknown, domain: string): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return hostWithinDomain(url.hostname, domain) ? url : null;
}

/** Valide les `args` d'un `http_fetch` / `page_fetch` (côté passerelle ET côté extension). */
export function parseFetchArgs(raw: unknown, domain: string, allowWriteActions: boolean): ParsedArgs<FetchArgs> {
  if (!isRecord(raw) || !onlyKeys(raw, ['url', 'method', 'headers', 'body', 'max_bytes'])) return refuse('method_not_allowed', 'args : champs hors contrat');
  const method = typeof raw['method'] === 'string' ? raw['method'].toUpperCase() : 'GET';
  if (!(FETCH_METHODS as readonly string[]).includes(method)) return refuse('method_not_allowed', 'méthode HTTP hors liste');
  if (typeof raw['url'] !== 'string') return refuse('method_not_allowed', 'url manquante');
  const url = commandUrl(raw['url'], domain);
  if (url === null) return refuse('domain_not_allowed', 'url hors du domaine connecté');
  if (!allowWriteActions && WRITE_METHODS.has(method)) return refuse('write_action_blocked', 'écriture sans allow_write_actions');
  const headers: Record<string, string> = {};
  if (raw['headers'] !== undefined) {
    if (!isRecord(raw['headers']) || Object.keys(raw['headers']).length > 50) return refuse('method_not_allowed', 'en-têtes invalides');
    for (const [name, value] of Object.entries(raw['headers'])) {
      const lower = name.toLowerCase();
      if (!/^[a-z0-9-]{1,64}$/.test(lower) || typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) return refuse('method_not_allowed', 'en-tête invalide');
      if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith('proxy-')) return refuse('method_not_allowed', `en-tête interdit : ${lower}`);
      headers[lower] = value;
    }
  }
  const body = raw['body'] ?? null;
  if (body !== null && !(typeof body === 'string' && body.length <= FETCH_MAX_REQUEST_BODY)) return refuse('method_not_allowed', 'corps invalide');
  if (body !== null && (method === 'GET' || method === 'HEAD')) return refuse('method_not_allowed', 'corps sur GET/HEAD');
  const maxBytes = raw['max_bytes'] ?? FETCH_DEFAULT_MAX_BYTES;
  if (!int(maxBytes, 1, FETCH_MAX_BYTES_LIMIT)) return refuse('method_not_allowed', 'max_bytes invalide');
  return { ok: true, args: { url: url.href, method: method as FetchArgs['method'], headers, body, max_bytes: maxBytes } };
}

/** Une commande peut-elle être rejouée sans risque après une coupure (lecture pure) ? */
export function isReplayableFetch(args: Pick<FetchArgs, 'method'>): boolean {
  return REPLAYABLE_METHODS.has(args.method);
}
