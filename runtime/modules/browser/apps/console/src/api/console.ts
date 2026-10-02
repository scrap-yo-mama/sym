// SPDX-License-Identifier: AGPL-3.0-only
// Service API typé des écrans de la console (tâche 3.6, 04d § 5.2). `ConsoleApi` est servie en production par
// `createHttpConsoleApi` (passerelle, même origine, cookie `__Host-`) et en développement et en test par la simulation
// `testing/mock-console.ts`. Aucune décision de droit ici : le serveur répond, la console affiche.
// À BRANCHER :
//   - 2.2 (REST) : routes de `CONSOLE_ROUTES` (04 § 2) ; filtres `apiKeyId`, `nodeId` et `state` à plusieurs valeurs de la
//     liste des sessions (04d § 5.2), en plus de ceux de 04 § 9 ; champs de `ConsoleSession` (types.ts) ;
//   - 2.5 (SSE) : `GET /v1/sessions/{id}/events`, lu par `fetch` en flux (cookie de session, reprise par `Last-Event-ID`) ;
//   - 2.6 (comptage) : `GET /v1/usage`, `GET /v1/usage.csv`, `POST /v1/admin/usage/reconcile`, champ `drift` proposé ;
//   - 3.2 (vue en direct) : `POST …/live-url` puis WebSocket `/v1/sessions/{id}/live/stream?t=…`, messages de 04d § 1.2 ;
//   - 2.1 et admin : `/v1/admin/nodes`, `/v1/admin/tenants`, `/v1/admin/keys` ; profils et proxys (04c § 2.2, § 4.4).
import { SESSION_STATES, TERMINAL_SESSION_STATES, type SessionEvent, type SessionState, type StorageState } from '@sym/contracts/browser';
import type { ApiResult, HttpClient } from './client.js';
import type {
  ApiKey,
  ConsoleSession,
  ConsoleSessionPage,
  CreatedKey,
  CreateKeyRequest,
  LiveClientMessage,
  LiveConnection,
  LiveMode,
  LiveServerMessage,
  LiveUrl,
  NodeInfo,
  Profile,
  ProxyProfile,
  ProxyTestResult,
  Recording,
  SessionFile,
  SessionQuery,
  Tenant,
  UsageQuery,
  UsageReport,
} from './types.js';

const enc = encodeURIComponent;

export const CONSOLE_ROUTES = {
  sessions: '/v1/sessions',
  session: (id: string) => `/v1/sessions/${enc(id)}`,
  extend: (id: string) => `/v1/sessions/${enc(id)}/extend`,
  events: (id: string) => `/v1/sessions/${enc(id)}/events`,
  recordings: (id: string) => `/v1/sessions/${enc(id)}/recordings`,
  recording: (id: string, rid: string) => `/v1/sessions/${enc(id)}/recordings/${enc(rid)}`,
  files: (id: string) => `/v1/sessions/${enc(id)}/files`,
  file: (id: string, fid: string) => `/v1/sessions/${enc(id)}/files/${enc(fid)}`,
  liveUrl: (id: string) => `/v1/sessions/${enc(id)}/live-url`,
  nodes: '/v1/admin/nodes',
  drain: (id: string) => `/v1/admin/nodes/${enc(id)}/drain`,
  tenants: '/v1/admin/tenants',
  keys: '/v1/admin/keys',
  key: (id: string) => `/v1/admin/keys/${enc(id)}`,
  profiles: '/v1/profiles',
  profileState: (id: string) => `/v1/profiles/${enc(id)}/storage-state`,
  profileImport: (id: string) => `/v1/profiles/${enc(id)}/import`,
  proxyProfiles: '/v1/proxy-profiles',
  proxyTest: (id: string) => `/v1/proxy-profiles/${enc(id)}/test`,
  usage: '/v1/usage',
  usageCsv: '/v1/usage.csv',
  reconcile: '/v1/admin/usage/reconcile',
} as const;

export const CURRENT_STATES: readonly SessionState[] = SESSION_STATES.filter((s) => !(TERMINAL_SESSION_STATES as readonly string[]).includes(s));
export const PAST_STATES: readonly SessionState[] = TERMINAL_SESSION_STATES;
export const SESSION_PAGE_SIZE = 50;

const METADATA_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** Chaîne de requête de `GET /v1/sessions` : l'onglet borne les états, un filtre d'état doit en faire partie. */
export function sessionQueryString(q: SessionQuery): string {
  const tabStates = q.tab === 'current' ? CURRENT_STATES : PAST_STATES;
  if (q.state !== undefined && !tabStates.includes(q.state)) throw new RangeError(`état ${q.state} hors de l’onglet ${q.tab}`);
  const limit = q.limit ?? SESSION_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('limit : 1 à 200 (04 § 9)');
  const params = new URLSearchParams();
  params.set('state', q.state ?? tabStates.join(','));
  if (q.type) params.set('type', q.type);
  if (q.apiKeyId) params.set('apiKeyId', q.apiKeyId);
  if (q.nodeId) params.set('nodeId', q.nodeId);
  if (q.createdAfter) params.set('createdAfter', q.createdAfter);
  if (q.createdBefore) params.set('createdBefore', q.createdBefore);
  if (q.metadata) {
    if (!METADATA_KEY.test(q.metadata.key)) throw new RangeError('clé de metadata invalide');
    params.set(`metadata.${q.metadata.key}`, q.metadata.value);
  }
  if (q.cursor) params.set('cursor', q.cursor);
  params.set('limit', String(limit));
  return `?${params.toString()}`;
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Chaîne de requête de `GET /v1/usage` et `/v1/usage.csv` (04d § 4.3). */
export function usageQueryString(q: UsageQuery): string {
  if (!DAY.test(q.from) || !DAY.test(q.to) || q.from > q.to) throw new RangeError('période invalide (AAAA-MM-JJ, début ≤ fin)');
  const params = new URLSearchParams({ from: q.from, to: q.to, groupBy: q.groupBy });
  if (q.apiKeyId) params.set('apiKeyId', q.apiKeyId);
  return `?${params.toString()}`;
}

/** Lecteur SSE incrémental (format `text/event-stream`) : rend les événements complets reçus. */
export function parseSse(): { push(chunk: string): { id?: string; event?: string; data: string }[]; retryMs(): number | undefined } {
  let buffer = '';
  let retry: number | undefined;
  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n?/g, '\n');
      const out: { id?: string; event?: string; data: string }[] = [];
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data: string[] = [];
        let id: string | undefined;
        let event: string | undefined;
        for (const line of block.split('\n')) {
          if (line === '' || line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'data') data.push(value);
          else if (field === 'id') id = value;
          else if (field === 'event') event = value;
          else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
        }
        if (data.length > 0) out.push({ ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), data: data.join('\n') });
      }
      return out;
    },
    retryMs: () => retry,
  };
}

/** URL du flux de la vue en direct : celle de la page signée (`…/live?t=`), chemin `/live/stream`, schéma WebSocket. */
export function liveStreamUrl(signedUrl: string, origin: string): string {
  const url = new URL(signedUrl, origin);
  if (url.origin !== new URL(origin).origin) throw new Error('URL de vue en direct d’une autre origine');
  if (!url.searchParams.get('t') || !/^\/v1\/sessions\/[^/]+\/live$/.test(url.pathname)) throw new Error('URL de vue en direct sans jeton ou mal formée');
  url.pathname = `${url.pathname}/stream`;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export interface ConsoleApi {
  listSessions(q: SessionQuery): Promise<ApiResult<ConsoleSessionPage>>;
  getSession(id: string): Promise<ApiResult<ConsoleSession, 'session_not_found'>>;
  releaseSession(id: string): Promise<ApiResult<ConsoleSession, 'session_not_found'>>;
  extendSession(id: string, timeoutSeconds: number): Promise<ApiResult<ConsoleSession, 'session_not_found' | 'invalid_option' | 'quota_exceeded'>>;
  listRecordings(id: string): Promise<ApiResult<{ data: Recording[] }>>;
  listFiles(id: string): Promise<ApiResult<{ data: SessionFile[] }>>;
  recordingHref(id: string, rid: string): string;
  fileHref(id: string, fid: string): string;
  /** Événements de la session (historique puis direct) ; rend la fonction de désabonnement. */
  watchEvents(id: string, onEvent: (event: SessionEvent) => void): () => void;
  openLive(id: string, mode: LiveMode): Promise<ApiResult<LiveConnection, 'session_not_found' | 'forbidden'>>;
  listNodes(): Promise<ApiResult<{ data: NodeInfo[] }>>;
  drainNode(id: string): Promise<ApiResult<NodeInfo, 'no_node'>>;
  listTenants(): Promise<ApiResult<{ data: Tenant[] }>>;
  listKeys(): Promise<ApiResult<{ data: ApiKey[] }>>;
  createKey(request: CreateKeyRequest): Promise<ApiResult<CreatedKey, 'invalid_option'>>;
  revokeKey(id: string): Promise<ApiResult<ApiKey>>;
  listProfiles(): Promise<ApiResult<{ data: Profile[] }>>;
  exportProfile(id: string): Promise<ApiResult<StorageState, 'profile_locked'>>;
  importProfile(id: string, state: StorageState): Promise<ApiResult<Profile, 'profile_locked' | 'invalid_option'>>;
  listProxyProfiles(): Promise<ApiResult<{ data: ProxyProfile[] }>>;
  testProxyProfile(id: string): Promise<ApiResult<ProxyTestResult, 'proxy_unreachable'>>;
  usage(q: UsageQuery): Promise<ApiResult<UsageReport>>;
  usageCsvHref(q: UsageQuery): string;
  reconcile(): Promise<ApiResult<{ started: true }>>;
}

export type HttpConsoleApiOptions = {
  /** Origine de la passerelle (même origine que la console). */
  baseUrl: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  WebSocket?: typeof WebSocket;
};

/** Événements lus en flux par `fetch` (cookie de session envoyé, `EventSource` ne permet pas de choisir les en-têtes). */
function watchSse(options: HttpConsoleApiOptions, path: string, onEvent: (event: SessionEvent) => void): () => void {
  const doFetch = options.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const controller = new AbortController();
  const seen = new Set<string>();
  let lastId: string | undefined;
  const run = async (): Promise<void> => {
    let delay = 3_000;
    while (!controller.signal.aborted) {
      const parser = parseSse();
      try {
        const headers: Record<string, string> = { accept: 'text/event-stream' };
        if (lastId !== undefined) headers['last-event-id'] = lastId;
        const response = await doFetch(`${options.baseUrl}${path}`, { headers, credentials: 'same-origin', signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const message of parser.push(value)) {
            if (message.id !== undefined) {
              if (seen.has(message.id)) continue;
              seen.add(message.id);
              lastId = message.id;
            }
            try {
              onEvent(JSON.parse(message.data) as SessionEvent);
            } catch {
              // événement illisible : ignoré
            }
          }
        }
        delay = parser.retryMs() ?? 3_000;
      } catch {
        if (controller.signal.aborted) return;
        delay = Math.min(delay * 2, 30_000);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };
  void run();
  return () => controller.abort();
}

export function createHttpConsoleApi(http: HttpClient, options: HttpConsoleApiOptions): ConsoleApi {
  const get = <T, C extends string = string>(path: string) => http.request<T, C>('GET', path);
  return {
    listSessions: (q) => get<ConsoleSessionPage>(`${CONSOLE_ROUTES.sessions}${sessionQueryString(q)}`),
    getSession: (id) => get<ConsoleSession, 'session_not_found'>(CONSOLE_ROUTES.session(id)),
    releaseSession: (id) => http.request<ConsoleSession, 'session_not_found'>('DELETE', CONSOLE_ROUTES.session(id)),
    extendSession: (id, timeoutSeconds) => http.request('POST', CONSOLE_ROUTES.extend(id), { timeoutSeconds }),
    listRecordings: (id) => get(CONSOLE_ROUTES.recordings(id)),
    listFiles: (id) => get(CONSOLE_ROUTES.files(id)),
    recordingHref: (id, rid) => CONSOLE_ROUTES.recording(id, rid),
    fileHref: (id, fid) => CONSOLE_ROUTES.file(id, fid),
    watchEvents: (id, onEvent) => watchSse(options, CONSOLE_ROUTES.events(id), onEvent),
    async openLive(id, mode) {
      const issued = await http.request<LiveUrl, 'session_not_found' | 'forbidden'>('POST', CONSOLE_ROUTES.liveUrl(id), { mode, ttlSeconds: 900, oneTime: true });
      if (!issued.ok) return issued;
      const Socket = options.WebSocket ?? globalThis.WebSocket;
      const socket = new Socket(liveStreamUrl(issued.data.url, options.baseUrl));
      const listeners: ((message: LiveServerMessage) => void)[] = [];
      const queue: string[] = [];
      socket.addEventListener('message', (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        let message: LiveServerMessage;
        try {
          message = JSON.parse(event.data) as LiveServerMessage;
        } catch {
          return;
        }
        for (const listener of listeners) listener(message);
      });
      socket.addEventListener('open', () => {
        for (const raw of queue.splice(0)) socket.send(raw);
      });
      socket.addEventListener('close', () => {
        for (const listener of listeners) listener({ t: 'closed', reason: 'disconnected' });
      });
      const connection: LiveConnection = {
        mode,
        onMessage: (listener) => void listeners.push(listener),
        send: (message: LiveClientMessage) => {
          const raw = JSON.stringify(message);
          if (socket.readyState === socket.OPEN) socket.send(raw);
          else if (socket.readyState === socket.CONNECTING) queue.push(raw);
        },
        close: () => {
          listeners.length = 0;
          socket.close();
        },
      };
      return { ok: true, status: 200, data: connection };
    },
    listNodes: () => get(CONSOLE_ROUTES.nodes),
    drainNode: (id) => http.request<NodeInfo, 'no_node'>('POST', CONSOLE_ROUTES.drain(id)),
    listTenants: () => get(CONSOLE_ROUTES.tenants),
    listKeys: () => get(CONSOLE_ROUTES.keys),
    createKey: (request) => http.request<CreatedKey, 'invalid_option'>('POST', CONSOLE_ROUTES.keys, request),
    revokeKey: (id) => http.request<ApiKey>('DELETE', CONSOLE_ROUTES.key(id)),
    listProfiles: () => get(CONSOLE_ROUTES.profiles),
    exportProfile: (id) => get<StorageState, 'profile_locked'>(CONSOLE_ROUTES.profileState(id)),
    importProfile: (id, state) => http.request<Profile, 'profile_locked' | 'invalid_option'>('POST', CONSOLE_ROUTES.profileImport(id), state),
    listProxyProfiles: () => get(CONSOLE_ROUTES.proxyProfiles),
    testProxyProfile: (id) => http.request<ProxyTestResult, 'proxy_unreachable'>('POST', CONSOLE_ROUTES.proxyTest(id)),
    usage: (q) => get(`${CONSOLE_ROUTES.usage}${usageQueryString(q)}`),
    usageCsvHref: (q) => `${CONSOLE_ROUTES.usageCsv}${usageQueryString(q)}`,
    reconcile: () => http.request<{ started: true }>('POST', CONSOLE_ROUTES.reconcile),
  };
}
