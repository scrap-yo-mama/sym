// SPDX-License-Identifier: AGPL-3.0-only
// Faux serveur de la console (tâches 3.5 et 3.6) : expose une `AuthApi` (la simulation) sur les routes HTTP prévues pour la
// tâche 2.1 (`AUTH_ROUTES`) et, si elle est fournie, la simulation des écrans (`MockConsoleApi`) sur les routes de 04 § 2
// (`CONSOLE_ROUTES`), avec les statuts et la forme d'erreur du contrat (`{ error: { code, message, retryable, what_to_do,
// requestId } }`, 04 § 6). Les routes des écrans exigent une session admin ouverte (401 sinon). Fonction `Request →
// Response` : branchée telle quelle sur `fetch` (tests unitaires) ou derrière un serveur HTTP local (e2e/harness.ts). Elle
// fixe ce que la passerelle (2.1, 2.2, 2.5, 2.6, 3.2) devra répondre. Le flux SSE rend l'historique puis se ferme (le
// client reprend avec `Last-Event-ID`) ; la vue en direct émet une URL signée dont le jeton est échangé par le banc E2E.
import { SESSION_STATES, SESSION_TYPES, type SessionState, type SessionType, type StorageState } from '@sym/contracts/browser';
import type { ApiResult } from '../api/client.js';
import { AUTH_ROUTES, type AuthApi } from '../api/auth.js';
import { CURRENT_STATES, PAST_STATES } from '../api/console.js';
import type { CreateKeyRequest, LiveMode, SessionQuery, UsageGroupBy, UsageQuery } from '../api/types.js';
import type { MockConsoleApi } from './mock-console.js';

type Handler = (body: Record<string, unknown>, match: string[], url: URL, request: Request) => Promise<ApiResult<unknown> | Response>;

const errorResponse = (status: number, code: string, requestId = 'req_fake'): Response =>
  Response.json(
    { error: { code, message: code, retryable: status === 429 || status >= 500, what_to_do: code, requestId } },
    { status, headers: status === 429 ? { 'retry-after': '60' } : {} },
  );

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export type FakeConsoleServer = ((request: Request) => Promise<Response>) & {
  /** Jeton de vue en direct émis par `POST …/live-url` → session et mode (banc E2E : relais WebSocket). */
  redeemLiveToken(token: string): { sessionId: string; mode: LiveMode } | undefined;
};

function sessionQuery(url: URL): SessionQuery | undefined {
  const p = url.searchParams;
  const states = (p.get('state') ?? '').split(',').filter(Boolean) as SessionState[];
  if (states.some((s) => !SESSION_STATES.includes(s))) return undefined;
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((s) => b.includes(s));
  let tab: SessionQuery['tab'];
  let state: SessionState | undefined;
  if (same(states, CURRENT_STATES)) tab = 'current';
  else if (same(states, PAST_STATES)) tab = 'past';
  else if (states.length === 1) {
    state = states[0]!;
    tab = CURRENT_STATES.includes(state) ? 'current' : 'past';
  } else return undefined;
  const q: SessionQuery = { tab, limit: Number(p.get('limit') ?? 50) };
  if (state) q.state = state;
  const type = p.get('type');
  if (type) {
    if (!SESSION_TYPES.includes(type as SessionType)) return undefined;
    q.type = type as SessionType;
  }
  for (const name of ['apiKeyId', 'nodeId', 'createdAfter', 'createdBefore', 'cursor'] as const) {
    const value = p.get(name);
    if (value) q[name] = value;
  }
  for (const [name, value] of p) if (name.startsWith('metadata.')) q.metadata = { key: name.slice('metadata.'.length), value };
  return q;
}

function usageQuery(url: URL): UsageQuery {
  const p = url.searchParams;
  const q: UsageQuery = { from: p.get('from') ?? '', to: p.get('to') ?? '', groupBy: (p.get('groupBy') === 'key' ? 'key' : 'day') as UsageGroupBy };
  const key = p.get('apiKeyId');
  if (key) q.apiKeyId = key;
  return q;
}

export function createFakeConsoleServer(api: AuthApi, screens?: MockConsoleApi): FakeConsoleServer {
  const liveTokens = new Map<string, { sessionId: string; mode: LiveMode }>();
  let tokenSequence = 0;

  const auth: Record<string, Handler> = {
    [`GET ${AUTH_ROUTES.status}`]: () => api.status(),
    [`POST ${AUTH_ROUTES.login}`]: (b) => api.login({ email: text(b.email), password: text(b.password) }),
    [`POST ${AUTH_ROUTES.totp}`]: (b) => api.verifyTotp({ code: text(b.code) }),
    [`POST ${AUTH_ROUTES.logout}`]: () => api.logout(),
    [`POST ${AUTH_ROUTES.setup}`]: (b) => api.setup({ token: text(b.token), email: text(b.email), password: text(b.password) }),
  };

  const s = screens;
  const screenRoutes: [string, RegExp, Handler][] = s
    ? [
        ['GET', /^\/v1\/sessions$/, async (_b, _m, url) => {
          const q = sessionQuery(url);
          return q ? s.listSessions(q) : errorResponse(400, 'invalid_option');
        }],
        ['GET', /^\/v1\/sessions\/([^/]+)$/, (_b, m) => s.getSession(m[1]!)],
        ['DELETE', /^\/v1\/sessions\/([^/]+)$/, (_b, m) => s.releaseSession(m[1]!)],
        ['POST', /^\/v1\/sessions\/([^/]+)\/extend$/, (b, m) => s.extendSession(m[1]!, Number(b.timeoutSeconds))],
        ['GET', /^\/v1\/sessions\/([^/]+)\/recordings$/, (_b, m) => s.listRecordings(m[1]!)],
        ['GET', /^\/v1\/sessions\/([^/]+)\/files$/, (_b, m) => s.listFiles(m[1]!)],
        ['GET', /^\/v1\/sessions\/([^/]+)\/(recordings|files)\/([^/]+)$/, async (_b, m) =>
          new Response(`contenu factice ${m[2]}/${m[3]}`, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${m[3]}"` } })],
        ['GET', /^\/v1\/sessions\/([^/]+)\/events$/, async (_b, m) => {
          const lines = s.eventsOf(m[1]!).map((e, i) => `id: ${m[1]}-${i}\ndata: ${JSON.stringify(e)}\n\n`);
          return new Response(`retry: 2000\n\n${lines.join('')}`, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
        }],
        ['POST', /^\/v1\/sessions\/([^/]+)\/live-url$/, async (b, m, _url, request) => {
          const id = m[1]!;
          const mode: LiveMode = b.mode === 'rw' ? 'rw' : 'ro';
          const session = await s.getSession(id);
          if (!session.ok) return session;
          if (session.data.state !== 'running') return errorResponse(404, 'session_not_found');
          if (mode === 'rw' && !session.data.interactiveLiveView) return errorResponse(403, 'forbidden');
          tokenSequence += 1;
          const token = `live_${tokenSequence}_${mode}`;
          liveTokens.set(token, { sessionId: id, mode });
          const origin = `http://${request.headers.get('host') ?? '127.0.0.1'}`;
          return { ok: true, status: 200, data: { url: `${origin}/v1/sessions/${encodeURIComponent(id)}/live?t=${token}`, mode, expiresAt: new Date(Date.now() + 900_000).toISOString() } };
        }],
        ['GET', /^\/v1\/admin\/nodes$/, () => s.listNodes()],
        ['POST', /^\/v1\/admin\/nodes\/([^/]+)\/drain$/, (_b, m) => s.drainNode(m[1]!)],
        ['GET', /^\/v1\/admin\/tenants$/, () => s.listTenants()],
        ['GET', /^\/v1\/admin\/keys$/, () => s.listKeys()],
        ['POST', /^\/v1\/admin\/keys$/, (b) => s.createKey(b as unknown as CreateKeyRequest)],
        ['DELETE', /^\/v1\/admin\/keys\/([^/]+)$/, (_b, m) => s.revokeKey(m[1]!)],
        ['GET', /^\/v1\/profiles$/, () => s.listProfiles()],
        ['GET', /^\/v1\/profiles\/([^/]+)\/storage-state$/, (_b, m) => s.exportProfile(m[1]!)],
        ['POST', /^\/v1\/profiles\/([^/]+)\/import$/, (b, m) => s.importProfile(m[1]!, b as unknown as StorageState)],
        ['GET', /^\/v1\/proxy-profiles$/, () => s.listProxyProfiles()],
        ['POST', /^\/v1\/proxy-profiles\/([^/]+)\/test$/, (_b, m) => s.testProxyProfile(m[1]!)],
        ['GET', /^\/v1\/usage$/, (_b, _m, url) => s.usage(usageQuery(url))],
        ['GET', /^\/v1\/usage\.csv$/, async (_b, _m, url) => {
          const q = usageQuery(url);
          return new Response(s.usageCsv(q), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="usage-${q.from}-${q.to}.csv"` } });
        }],
        ['POST', /^\/v1\/admin\/usage\/reconcile$/, () => s.reconcile()],
      ]
    : [];

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname } = url;
    let route: Handler | undefined = auth[`${request.method} ${pathname}`];
    let match: string[] = [];
    if (!route) {
      for (const [method, pattern, h] of screenRoutes) {
        const m = method === request.method ? pattern.exec(pathname) : null;
        if (m) {
          route = h;
          match = m.map((part) => decodeURIComponent(part));
          break;
        }
      }
      if (route) {
        const status = await api.status();
        if (!status.ok || status.data.admin === null) return errorResponse(401, 'unauthorized');
      }
    }
    if (!route) return errorResponse(404, 'not_found');
    let body: Record<string, unknown> = {};
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      const raw = await request.text();
      try {
        const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return errorResponse(400, 'invalid_option');
        body = parsed as Record<string, unknown>;
      } catch {
        return errorResponse(400, 'invalid_option');
      }
    }
    const result = await route(body, match, url, request);
    if (result instanceof Response) return result;
    if (!result.ok) return errorResponse(result.status, result.code, result.requestId);
    return result.status === 204 || result.data === undefined ? new Response(null, { status: result.status }) : Response.json(result.data, { status: result.status });
  };
  return Object.assign(handler, {
    // Jeton à usage unique (`oneTime`, 04d § 1.1).
    redeemLiveToken: (token: string) => {
      const ticket = liveTokens.get(token);
      liveTokens.delete(token);
      return ticket;
    },
  });
}
