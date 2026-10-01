// SPDX-License-Identifier: AGPL-3.0-only
// Ponts du bac à sable, côté hôte (08 §3) : chaque pont reçoit une chaîne JSON non fiable venue de l'isolat, valide
// schéma, taille et domaine, puis agit. `ctx.fetch` passe par la garde SSRF (INV10) et reste dans les domaines de l'API.
// Toute violation est journalisée `sandbox_violation` (puits unique : `violation`, 32 au plus par run) et tue l'enfant
// (engine.ts). Budgets côté hôte, par run : octets d'éléments retenus, octets de réponses lus, octets de journal.
import type { Logger } from 'pino';
import type {
  SandboxBridges,
  SandboxFetchRequest,
  SandboxFetchResponse,
  SandboxViolation,
  SandboxViolationReason,
} from '@runtime/core';
import { findSsrfBlocked, guardedFetch, normalizeHostname, type SsrfGuard } from '@runtime/core/net';

/** Refus d'un pont. `code` est relayé au script ; `violation` : à journaliser comme `sandbox_violation`. */
export class SandboxBridgeError extends Error {
  /** `rate_limited` : cadence du domaine refusée (1.9) ; `request_cap` : `max_requests_per_run` atteint. */
  readonly code: SandboxViolationReason | 'fetch_failed' | 'page_failed' | 'page_unavailable' | 'rate_limited' | 'request_cap' | 'access_refused';
  readonly violation: boolean;
  readonly detail?: string;
  constructor(code: SandboxBridgeError['code'], violation: boolean, detail?: string) {
    super(code);
    this.name = 'SandboxBridgeError';
    this.code = code;
    this.violation = violation;
    this.detail = detail;
  }
}

/** Réponse minimale attendue du transport (undici ou fetch global). */
export type BridgeResponse = {
  readonly status: number;
  readonly url: string;
  readonly headers: { get(name: string): string | null; forEach(callback: (value: string, name: string) => void): void };
  readonly body: ReadableStream<Uint8Array> | null;
};
/**
 * Transport d'un saut, SANS suivre les redirections (le pont les suit lui-même et contrôle le domaine de chaque saut
 * avant toute connexion). Il doit passer par la garde SSRF.
 */
export type BridgeFetch = (request: SandboxFetchRequest, signal: AbortSignal) => Promise<BridgeResponse>;

export type SandboxBridgeOptions = {
  /** Domaines de l'API : nom exact, ou `*.exemple.fr` pour les sous-domaines (pas le domaine nu). */
  allowedDomains: readonly string[];
  /** Garde SSRF appliquée à chaque connexion (et redirection). */
  guard: SsrfGuard;
  logger: Logger;
  /** Transport (défaut : `guardedFetch` sous `guard`). Les modes réseau (1.4) passent le leur, gardé lui aussi. */
  fetch?: BridgeFetch;
  allowedMethods?: readonly string[];
  maxRequests?: number;
  maxRequestBodyBytes?: number;
  maxResponseBytes?: number;
  fetchTimeoutMs?: number;
  maxItems?: number;
  maxItemBytes?: number;
  /** Plafond cumulé des éléments retenus par le parent, en octets JSON (défaut 50 Mio). */
  maxTotalItemBytes?: number;
  /** Plafond cumulé des corps de réponse lus par `ctx.fetch` sur le run, en octets (défaut 50 Mio). */
  maxTotalResponseBytes?: number;
  /** Plafond du journal du script ; au-delà, violation `output_limit` (défaut 64 Kio). */
  maxLogBytes?: number;
  /**
   * Destination des lignes de `ctx.log` (texte libre du script, qui peut contenir des données extraites) : la mémoire
   * de l'essai seulement. Ni le journal du worker ni `run_logs` ne reçoivent jamais ce texte, seulement le nombre de
   * lignes et la taille (17 §6, « identifiants techniques uniquement »).
   */
  onLog?: (args: readonly string[]) => void;
  /**
   * Contrôle de la réponse finale de `ctx.fetch` (après redirections, corps lu et borné) AVANT sa remise au script :
   * une erreur levée ici (`SandboxBridgeError`) est rendue au script à la place de la réponse.
   */
  inspect?: (response: SandboxFetchResponse) => Promise<void> | void;
};

export type SandboxBridgeHandle = {
  bridges: SandboxBridges;
  /** Éléments émis par `ctx.emit` (JSON validé). */
  readonly items: unknown[];
  readonly violations: SandboxViolation[];
};

const DEFAULT_METHODS = ['GET', 'HEAD', 'POST'];
/** En-têtes que le script ne fixe jamais : identité de connexion et secrets restent à l'hôte (INV8). */
const FORBIDDEN_HEADERS = new Set([
  'host', 'cookie', 'cookie2', 'authorization', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding',
  'content-length', 'te', 'trailer', 'upgrade', 'expect', 'proxy-connection',
]);
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const CROSS_ORIGIN_HEADERS = ['accept', 'accept-language', 'user-agent'];
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const MAX_URL = 8192;
const MAX_HEADERS = 50;
const MAX_HEADER_VALUE = 8192;
/** Violations retenues et journalisées par run (l'enfant est tué à la première ; borne contre l'inondation). */
const MAX_VIOLATIONS = 32;

/** Normalise une entrée de la liste des domaines (IDN → punycode, minuscules, sans point final). */
export function normalizeDomain(entry: string): string {
  const wildcard = entry.startsWith('*.');
  const bare = wildcard ? entry.slice(2) : entry;
  const host = normalizeHostname(new URL(`http://${bare}`).hostname);
  return wildcard ? `*.${host}` : host;
}

/** Vrai si `host` (déjà normalisé) est un domaine de l'API. */
export function domainAllowed(host: string, allowed: readonly string[]): boolean {
  const h = normalizeHostname(host);
  return allowed.some((entry) => (entry.startsWith('*.') ? h.endsWith(entry.slice(1)) : h === entry));
}

function bad(detail: string): never {
  throw new SandboxBridgeError('invalid_bridge_call', true, detail);
}

function parseJson(raw: unknown, what: string): unknown {
  if (typeof raw !== 'string') bad(`${what} : chaîne JSON attendue`);
  try {
    return JSON.parse(raw);
  } catch {
    return bad(`${what} : JSON invalide`);
  }
}

/** Valide une requête `ctx.fetch` (schéma, tailles, méthode, en-têtes, domaine). */
export function validateFetchRequest(
  raw: unknown,
  policy: { allowedDomains: readonly string[]; allowedMethods: readonly string[]; maxRequestBodyBytes: number },
): SandboxFetchRequest {
  const value = parseJson(raw, 'fetch');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad('fetch : objet attendu');
  const r = value as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!['url', 'method', 'headers', 'body'].includes(key)) bad(`fetch : champ inconnu`);
  if (typeof r.url !== 'string' || r.url.length > MAX_URL) bad('fetch : url');
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    return bad('fetch : url invalide');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') bad('fetch : schéma');
  if (url.username !== '' || url.password !== '') bad('fetch : identifiants dans l’url');
  const method = typeof r.method === 'string' ? r.method.toUpperCase() : bad('fetch : méthode');
  if (!policy.allowedMethods.includes(method)) throw new SandboxBridgeError('method_not_allowed', true, method.slice(0, 16));
  const headers: Record<string, string> = {};
  if (r.headers !== undefined) {
    if (typeof r.headers !== 'object' || r.headers === null || Array.isArray(r.headers)) bad('fetch : en-têtes');
    const entries = Object.entries(r.headers as Record<string, unknown>);
    if (entries.length > MAX_HEADERS) bad('fetch : trop d’en-têtes');
    for (const [name, v] of entries) {
      if (!TOKEN.test(name)) bad('fetch : nom d’en-tête');
      if (typeof v !== 'string' || v.length > MAX_HEADER_VALUE || /[\r\n\0]/.test(v)) bad('fetch : valeur d’en-tête');
      const lower = name.toLowerCase();
      if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-')) {
        throw new SandboxBridgeError('forbidden_header', true, lower.slice(0, 64));
      }
      headers[lower] = v;
    }
  }
  let body: string | undefined;
  if (r.body !== undefined && r.body !== null) {
    if (typeof r.body !== 'string') bad('fetch : corps (chaîne attendue)');
    if (Buffer.byteLength(r.body) > policy.maxRequestBodyBytes) bad('fetch : corps trop grand');
    if (method === 'GET' || method === 'HEAD') bad('fetch : corps sur GET/HEAD');
    body = r.body;
  }
  // Domaine en dernier : les autres refus ne révèlent rien du réseau.
  if (!domainAllowed(url.hostname, policy.allowedDomains)) {
    throw new SandboxBridgeError('domain_not_allowed', true, normalizeHostname(url.hostname).slice(0, 253));
  }
  return { url: url.href, method, headers, body };
}

/** Saut de redirection : domaine contrôlé AVANT la connexion, pas de retour de https vers http, en-têtes réduits. */
function nextHop(
  from: SandboxFetchRequest,
  status: number,
  location: string,
  hop: number,
  allowedDomains: readonly string[],
): SandboxFetchRequest {
  if (hop >= MAX_REDIRECTS) throw new SandboxBridgeError('fetch_failed', false);
  let next: URL;
  try {
    next = new URL(location, from.url);
  } catch {
    throw new SandboxBridgeError('fetch_failed', false);
  }
  const prev = new URL(from.url);
  if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new SandboxBridgeError('ssrf_blocked', true, 'scheme');
  if (prev.protocol === 'https:' && next.protocol === 'http:') throw new SandboxBridgeError('ssrf_blocked', true, 'https_downgrade');
  if (!domainAllowed(next.hostname, allowedDomains)) {
    throw new SandboxBridgeError('domain_not_allowed', true, normalizeHostname(next.hostname).slice(0, 253));
  }
  const toGet = status === 303 || ((status === 301 || status === 302) && from.method === 'POST');
  let headers = from.headers;
  if (next.origin !== prev.origin) {
    headers = Object.fromEntries(Object.entries(from.headers).filter(([name]) => CROSS_ORIGIN_HEADERS.includes(name)));
  }
  const keepBody = !toGet && next.origin === prev.origin;
  return { url: next.href, method: toGet ? 'GET' : from.method, headers, ...(keepBody && from.body !== undefined ? { body: from.body } : {}) };
}

async function readCapped(response: BridgeResponse, max: number): Promise<{ body: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { body: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** Construit les ponts d'un run. Un jeu par exécution : quotas et annulation sont par run. */
export function createSandboxBridges(options: SandboxBridgeOptions): SandboxBridgeHandle {
  const allowedDomains = options.allowedDomains.map(normalizeDomain);
  const allowedMethods = (options.allowedMethods ?? DEFAULT_METHODS).map((m) => m.toUpperCase());
  const maxRequests = options.maxRequests ?? 100;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 1024 * 1024;
  const maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 30_000;
  const maxItems = options.maxItems ?? 10_000;
  const maxItemBytes = options.maxItemBytes ?? 1024 * 1024;
  const maxTotalItemBytes = options.maxTotalItemBytes ?? 50 * 1024 * 1024;
  const maxTotalResponseBytes = options.maxTotalResponseBytes ?? 50 * 1024 * 1024;
  const maxLogBytes = options.maxLogBytes ?? 64 * 1024;
  const log = options.logger;
  const abort = new AbortController();
  const transport: BridgeFetch =
    options.fetch ??
    ((request, signal) =>
      guardedFetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal }, {
        guard: options.guard,
        followRedirects: false,
      }) as Promise<BridgeResponse>);

  const items: unknown[] = [];
  const violations: SandboxViolation[] = [];
  let requests = 0;
  let logBytes = 0;
  let itemBytes = 0;
  let responseBytes = 0;

  const bridges: SandboxBridges = {
    async fetch(raw) {
      if (++requests > maxRequests) throw new SandboxBridgeError('bridge_quota', true, 'fetch');
      if (responseBytes >= maxTotalResponseBytes) throw new SandboxBridgeError('bridge_quota', true, 'response_bytes');
      const request = validateFetchRequest(raw, { allowedDomains, allowedMethods, maxRequestBodyBytes });
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(fetchTimeoutMs)]);
      let current = request;
      let response: BridgeResponse;
      for (let hop = 0; ; hop++) {
        try {
          response = await transport(current, signal);
        } catch (error) {
          if (error instanceof SandboxBridgeError) throw error;
          const blocked = findSsrfBlocked(error);
          if (blocked !== undefined) throw new SandboxBridgeError('ssrf_blocked', true, blocked.detail.reason);
          throw new SandboxBridgeError('fetch_failed', false);
        }
        const location = response.headers.get('location');
        if (!REDIRECTS.has(response.status) || location === null) break;
        await response.body?.cancel().catch(() => undefined);
        current = nextHop(current, response.status, location, hop, allowedDomains);
      }
      const finalUrl = new URL(current.url);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
      });
      // Budget hôte : un corps n'est lu que dans la limite de ce qui reste au run (coupé, `truncated`).
      const { body, truncated } = await readCapped(response, Math.min(maxResponseBytes, maxTotalResponseBytes - responseBytes));
      responseBytes += Buffer.byteLength(body);
      const out: SandboxFetchResponse = { status: response.status, url: finalUrl.href, headers, body, truncated };
      // Garde de l'appelant (classement de la réponse, tâche 1.6, INV6) : un refus lève avant toute remise au script.
      await options.inspect?.(out);
      return out;
    },
    log(raw) {
      const args = parseJson(raw, 'log');
      if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) bad('log : tableau de chaînes attendu');
      const size = Buffer.byteLength(raw as string);
      if (logBytes + size > maxLogBytes) throw new SandboxBridgeError('output_limit', true, 'log');
      logBytes += size;
      options.onLog?.(args as string[]);
      log.info({ event: 'sandbox_log', count: (args as string[]).length, bytes: size }, 'sandbox_log');
    },
    emit(raw) {
      if (typeof raw !== 'string') bad('emit : chaîne JSON attendue');
      const size = Buffer.byteLength(raw);
      if (size > maxItemBytes) throw new SandboxBridgeError('output_limit', true, 'emit');
      const item = parseJson(raw, 'emit');
      if (items.length >= maxItems) throw new SandboxBridgeError('output_limit', true, 'emit');
      // Plafond cumulé : sans lui, maxItems × maxItemBytes (10 Go) pourrait s'accumuler dans le worker.
      if (itemBytes + size > maxTotalItemBytes) throw new SandboxBridgeError('output_limit', true, 'emit_total');
      itemBytes += size;
      items.push(item);
    },
    violation(v) {
      if (violations.length >= MAX_VIOLATIONS) return;
      violations.push(v);
      log.warn({ event: 'sandbox_violation', reason: v.reason, detail: v.detail }, 'sandbox_violation');
    },
    close() {
      abort.abort();
    },
  };
  return { bridges, items, violations };
}
