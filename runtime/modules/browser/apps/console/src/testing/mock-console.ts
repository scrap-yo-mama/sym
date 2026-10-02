// SPDX-License-Identifier: AGPL-3.0-only
// Simulation de `ConsoleApi` (tâche 3.6) : réponses conformes au CDC (04 § 2 à § 9, 04b § 5, 04c § 2.2, § 4.4, § 5.1,
// 04d § 1, § 2.2, § 4) en attendant 2.2 (REST), 2.5 (SSE), 2.6 (comptage) et 3.2 (vue en direct). Elle sert la console sous
// `vite`, les tests unitaires et le faux serveur des E2E ; elle n'entre jamais dans la console construite (test E2E).
// Données factices et déterministes (date de référence fixe) : aucune clé, aucun identifiant réel.
import type { EndReason, SessionEvent, SessionState, StorageState } from '@sym/contracts/browser';
import type { ApiFailure, ApiResult } from '../api/client.js';
import { CURRENT_STATES, PAST_STATES, usageQueryString, type ConsoleApi } from '../api/console.js';
import {
  API_KEY_SCOPES,
  type ApiKey,
  type ConsoleSession,
  type LiveClientMessage,
  type LiveConnection,
  type LiveMode,
  type LiveServerMessage,
  type NodeInfo,
  type Profile,
  type ProxyProfile,
  type Recording,
  type SessionFile,
  type Tenant,
  type UsageItem,
  type UsageQuery,
  type UsageReport,
} from '../api/types.js';

/** Repère de la simulation : sa présence dans dist/ ferait échouer le test E2E de construction. */
export const MOCK_CONSOLE_MARKER = 'sym-browser-console:mock-console';
/**
 * Date de référence des données : début de l'heure courante. Les données restent ainsi « récentes » quel que soit le jour où
 * tournent les tests (sessions des 3 dernières semaines, consommation des 60 derniers jours), et fixes pendant un run.
 */
export const CONSOLE_FIXTURE_NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();
const fail = <C extends string>(status: number, code: C): ApiFailure<C> => ({ ok: false, status, code, requestId: `req_mock_${code}` });
const done = <T>(data: T, status = 200): ApiResult<T, never> => ({ ok: true, status, data });
const clone = <T>(value: T): T => structuredClone(value);

/** Petit générateur pseudo-aléatoire déterministe (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cellule CSV (04d § 4.3) : valeurs commençant par `=`, `+`, `-`, `@` préfixées d'une apostrophe ; guillemets si besoin. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Trame JPEG factice (64 × 40 px, carré bleu sur crème, produite par Chromium) en base64. */
const FRAME =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAoAEADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAUHBv/EACcQAAEDAQgBBQEAAAAAAAAAAAABAgQFAwYREhZUo9ExEzZRYYKy/8QAGgEBAAIDAQAAAAAAAAAAAAAAAAIDAQQFBv/EACgRAAIBAQQKAwAAAAAAAAAAAAABAgMEESFRBRMUFUFScZGh0RIxsf/aAAwDAQACEQMRAD8A0QA4e8d4KrCrkmNFlZLJmXK302rhi1F8qnypbZrNO0T+EOuJlu47gGaaqrm94mdDVVc3vEzo3d0V8159ENYjSwZpqqub3iZ0NVVze8TOhuivmvPoaxGlgmXcl282hxpMp+e1fmzOwRMcHKnhPpCmc2pBwm4PhgTWIM0vf7ml/j+GmlnD3ju/VZtckyYsXPZPy5Xeo1McGonhV+UOhoqpCFZubuw49URmr0ckC1pWubLlZ2NK1zZcrOzvbVQ513RVcyKC1pWubLlZ2NK1zZcrOxtVDnXdC5nZXQ9sxP3/AG4sky7kS3hUONGlMyWrM2ZuKLhi5V8p9KUzylpadabWb/S9fQABSZAAAAAAAAAP/9k=';

type MockState = {
  sessions: Map<string, ConsoleSession & { maxDurationSeconds: number }>;
  events: Map<string, SessionEvent[]>;
  recordings: Map<string, Recording[]>;
  files: Map<string, SessionFile[]>;
  nodes: NodeInfo[];
  tenants: Tenant[];
  keys: ApiKey[];
  profiles: Profile[];
  profileStates: Map<string, StorageState>;
  proxies: (ProxyProfile & { reachable: boolean; exitIp: string })[];
  usage: (UsageItem & { day: string; apiKeyId: string; apiKeyPrefix: string })[];
  drift: { seconds: number; bytes: number };
};

const KEYS: ApiKey[] = [
  { id: 'key_prod', tenantId: 't_acme', name: 'Production', prefix: 'symb_live_Pr0d', scopes: ['sessions:read', 'sessions:write', 'profiles:write'], expiresAt: null, lastUsedAt: iso(CONSOLE_FIXTURE_NOW - 5 * MIN), createdAt: iso(CONSOLE_FIXTURE_NOW - 90 * DAY), revokedAt: null },
  { id: 'key_ci', tenantId: 't_acme', name: 'CI', prefix: 'symb_live_C1ci', scopes: ['sessions:read', 'sessions:write'], expiresAt: iso(CONSOLE_FIXTURE_NOW + 60 * DAY), lastUsedAt: iso(CONSOLE_FIXTURE_NOW - HOUR), createdAt: iso(CONSOLE_FIXTURE_NOW - 30 * DAY), revokedAt: null },
  { id: 'key_globex', tenantId: 't_globex', name: 'Globex', prefix: 'symb_live_G1bx', scopes: ['sessions:read', 'sessions:write', 'admin'], expiresAt: null, lastUsedAt: iso(CONSOLE_FIXTURE_NOW - 2 * DAY), createdAt: iso(CONSOLE_FIXTURE_NOW - 60 * DAY), revokedAt: null },
  { id: 'key_old', tenantId: 't_acme', name: 'Ancienne', prefix: 'symb_live_0ld0', scopes: ['sessions:read'], expiresAt: null, lastUsedAt: null, createdAt: iso(CONSOLE_FIXTURE_NOW - 200 * DAY), revokedAt: iso(CONSOLE_FIXTURE_NOW - 100 * DAY) },
];
const ACTIVE_KEYS = KEYS.filter((k) => k.revokedAt === null);

function seed(): MockState {
  const rnd = random(36);
  const now = CONSOLE_FIXTURE_NOW;
  const state: MockState = {
    sessions: new Map(),
    events: new Map(),
    recordings: new Map(),
    files: new Map(),
    nodes: [
      { id: 'node-a', region: 'eu-west', state: 'ready', slotsTotal: 10, slotsFree: 1, rssBytes: 6.1e9, limitBytes: 8e9, playwright: '1.63.0', chromium: '153.0.8010.12', lastHeartbeatAt: iso(now - 3_000) },
      { id: 'node-b', region: 'eu-west', state: 'draining', slotsTotal: 8, slotsFree: 0, rssBytes: 5.2e9, limitBytes: 6e9, playwright: '1.63.0', chromium: '153.0.8010.12', lastHeartbeatAt: iso(now - 4_000) },
      { id: 'node-c', region: 'us-east', state: 'down', slotsTotal: 4, slotsFree: 0, rssBytes: 0, limitBytes: 4e9, playwright: '1.63.0', chromium: '153.0.8010.12', lastHeartbeatAt: iso(now - 9 * MIN) },
    ],
    tenants: [
      { id: 't_acme', name: 'Acme', quotas: { concurrentSessions: 10, minutesPerMonth: 30_000, bytesPerMonth: 50e9, maxSessionSeconds: 3600 }, createdAt: iso(now - 200 * DAY) },
      { id: 't_globex', name: 'Globex', quotas: { concurrentSessions: 4, minutesPerMonth: 5_000, bytesPerMonth: 10e9, maxSessionSeconds: 1800 }, createdAt: iso(now - 60 * DAY) },
    ],
    keys: clone(KEYS),
    profiles: [
      { id: 'prof_login', tenantId: 't_acme', name: 'Connexion boutique', sizeBytes: 18_400_000, version: 7, lockedBySession: 'ses_live', updatedAt: iso(now - DAY) },
      { id: 'prof_shop', tenantId: 't_acme', name: 'Panier de test', sizeBytes: 4_200_000, version: 3, lockedBySession: null, updatedAt: iso(now - 3 * DAY) },
      { id: 'prof_globex', tenantId: 't_globex', name: 'Globex SSO', sizeBytes: 9_800_000, version: 1, lockedBySession: null, updatedAt: iso(now - 10 * DAY) },
    ],
    profileStates: new Map([
      ['prof_shop', { cookies: [{ name: 'cart', value: 'zz-factice', domain: 'fixture.test', path: '/' }], origins: [] }],
      ['prof_globex', { cookies: [], origins: [{ origin: 'https://fixture.test', localStorage: [{ name: 'theme', value: 'sombre' }] }] }],
    ]),
    proxies: [
      { id: 'px_isp', tenantId: 't_acme', name: 'Proxy ISP Paris', type: 'http', host: 'isp.proxy.test', port: 8080, username: 'paris***', passwordSet: true, reachable: true, exitIp: '203.0.113.24' },
      { id: 'px_dc', tenantId: 't_acme', name: 'Datacenter Francfort', type: 'socks5', host: 'dc.proxy.test', port: 1080, username: 'fra***', passwordSet: true, reachable: false, exitIp: '' },
    ],
    usage: [],
    drift: { seconds: 42, bytes: 1_024 },
  };

  const add = (s: ConsoleSession & { maxDurationSeconds: number }, extra: SessionEvent[] = []): void => {
    state.sessions.set(s.id, s);
    const events: SessionEvent[] = [{ type: 'state', sessionId: s.id, at: s.createdAt, data: { state: 'pending' } }];
    if (s.startedAt) events.push({ type: 'state', sessionId: s.id, at: s.startedAt, data: { state: 'running' } });
    events.push(...extra);
    if (s.endedAt) events.push({ type: 'state', sessionId: s.id, at: s.endedAt, data: { state: s.state, ...(s.endReason ? { endReason: s.endReason } : {}) } });
    state.events.set(s.id, events);
  };
  const base = (id: string, created: number, key: ApiKey, over: Partial<ConsoleSession>): ConsoleSession & { maxDurationSeconds: number } => ({
    id,
    state: 'running',
    type: 'dedicated',
    createdAt: iso(created),
    expiresAt: iso(created + 30 * MIN),
    apiKeyId: key.id,
    apiKeyPrefix: key.prefix,
    interactiveLiveView: false,
    maxDurationSeconds: 3600,
    metadata: {},
    usage: { seconds: 0, bytesIn: 0, bytesOut: 0 },
    ...over,
  });

  add(base('ses_live', now - 5 * MIN, KEYS[0]!, { startedAt: iso(now - 5 * MIN + 1_200), nodeId: 'node-a', interactiveLiveView: true, metadata: { run: 'live' }, usage: { seconds: 300, bytesIn: 8_400_000, bytesOut: 310_000 } }));
  add(base('ses_live_ro_only', now - 12 * MIN, KEYS[1]!, { type: 'shared', startedAt: iso(now - 12 * MIN + 400), nodeId: 'node-b', usage: { seconds: 720, bytesIn: 2_100_000, bytesOut: 90_000 } }));
  add(base('ses_pending', now - 20_000, KEYS[2]!, { state: 'pending', expiresAt: iso(now + 10 * MIN) }));
  add(
    base('ses_recorded', now - HOUR, KEYS[1]!, {
      state: 'ended',
      endReason: 'released',
      startedAt: iso(now - HOUR + 900),
      endedAt: iso(now - HOUR + 7 * MIN),
      nodeId: 'node-a',
      metadata: { run: 'nightly' },
      usage: { seconds: 412, bytesIn: 15_300_000, bytesOut: 620_000 },
    }),
    [
      { type: 'download', sessionId: 'ses_recorded', at: iso(now - HOUR + 3 * MIN), data: { id: 'file_1', name: 'facture-2026-09.pdf', state: 'completed', bytes: 184_320 } },
      { type: 'egress.blocked', sessionId: 'ses_recorded', at: iso(now - HOUR + 4 * MIN), data: { host: 'tracker.example', reason: 'domain_not_allowed', count: 3 } },
      ...(['trace', 'har', 'video', 'console'] as const).map((type, i): SessionEvent => ({
        type: 'recording.ready',
        sessionId: 'ses_recorded',
        at: iso(now - HOUR + 7 * MIN + i * 1000),
        data: { recordingId: `rec_${type}`, type, size: 1_000_000 * (i + 1), expiresAt: iso(now + 7 * DAY) },
      })),
    ],
  );
  state.recordings.set(
    'ses_recorded',
    (['trace', 'har', 'video', 'console'] as const).map((type, i) => ({ id: `rec_${type}`, type, size: 1_000_000 * (i + 1), createdAt: iso(now - HOUR + 7 * MIN), expiresAt: iso(now + 7 * DAY) })),
  );
  state.files.set('ses_recorded', [{ id: 'file_1', name: 'facture-2026-09.pdf', size: 184_320, sha256: 'a3f1c2d4e5b6978899aabbccddeeff00112233445566778899aabbccddeeff00', createdAt: iso(now - HOUR + 3 * MIN), expiresAt: iso(now + 23 * HOUR) }]);

  const ends: [SessionState, EndReason][] = [
    ['ended', 'released'],
    ['timed_out', 'timeout'],
    ['ended', 'released'],
    ['failed', 'crash'],
    ['timed_out', 'idle'],
  ];
  for (let i = 0; i < 70; i += 1) {
    const created = now - 2 * HOUR - i * 7 * HOUR - Math.floor(rnd() * HOUR);
    const [endState, reason] = ends[i % ends.length]!;
    const seconds = 30 + Math.floor(rnd() * 1500);
    const key = ACTIVE_KEYS[i % ACTIVE_KEYS.length]!;
    add(
      base(`ses_${String(i + 1).padStart(4, '0')}`, created, key, {
        state: endState,
        endReason: reason,
        type: i % 3 === 0 ? 'shared' : 'dedicated',
        startedAt: iso(created + 800),
        endedAt: iso(created + 800 + seconds * 1000),
        nodeId: ['node-a', 'node-b', 'node-c'][i % 3]!,
        metadata: i % 5 === 0 ? { run: 'nightly' } : { run: `r${i}` },
        usage: { seconds, bytesIn: Math.floor(rnd() * 40e6), bytesOut: Math.floor(rnd() * 2e6) },
      }),
    );
  }

  for (let d = 0; d < 60; d += 1) {
    const day = iso(now - d * DAY).slice(0, 10);
    for (const key of ACTIVE_KEYS) {
      const sessions = Math.floor(rnd() * 40);
      state.usage.push({ day, apiKeyId: key.id, apiKeyPrefix: key.prefix, sessions, billedSeconds: sessions * (60 + Math.floor(rnd() * 300)), bytesIn: Math.floor(sessions * rnd() * 25e6), bytesOut: Math.floor(sessions * rnd() * 1e6) });
    }
  }
  return state;
}

type LiveViewer = { sessionId: string; mode: LiveMode; listeners: ((m: LiveServerMessage) => void)[]; timer: ReturnType<typeof setInterval> | undefined; closed: boolean };

export type MockConsoleApi = ConsoleApi & {
  readonly [Symbol.toStringTag]: string;
  /** Entrées de la vue en direct : transmises au navigateur (mode `rw`) ou écartées au relais (mode `ro`). */
  liveStats(sessionId: string): { forwarded: number; dropped: number };
  /** Corps de `GET /v1/usage.csv` (faux serveur). */
  usageCsv(q: UsageQuery): string;
  /** Historique des événements (faux serveur SSE). */
  eventsOf(sessionId: string): SessionEvent[];
};

export function createMockConsoleApi(options: { now?: () => number } = {}): MockConsoleApi {
  const started = Date.now();
  const now = options.now ?? (() => CONSOLE_FIXTURE_NOW + (Date.now() - started));
  const state = seed();
  const watchers = new Map<string, Set<(e: SessionEvent) => void>>();
  const viewers = new Set<LiveViewer>();
  const stats = new Map<string, { forwarded: number; dropped: number }>();
  let keySequence = 0;

  const publicSession = (s: ConsoleSession & { maxDurationSeconds: number }): ConsoleSession => {
    const { maxDurationSeconds: _ignored, ...rest } = s;
    return clone(rest);
  };
  const emit = (event: SessionEvent): void => {
    state.events.get(event.sessionId)?.push(event);
    for (const listener of watchers.get(event.sessionId) ?? []) listener(clone(event));
  };
  const closeViewer = (viewer: LiveViewer, reason: string): void => {
    if (viewer.closed) return;
    viewer.closed = true;
    clearInterval(viewer.timer);
    for (const listener of viewer.listeners) listener({ t: 'closed', reason });
    viewers.delete(viewer);
  };

  const api: MockConsoleApi = {
    [Symbol.toStringTag]: MOCK_CONSOLE_MARKER,

    async listSessions(q) {
      const tabStates = q.tab === 'current' ? CURRENT_STATES : PAST_STATES;
      if (q.state !== undefined && !tabStates.includes(q.state)) return fail(400, 'invalid_option');
      const limit = q.limit ?? 50;
      let list = [...state.sessions.values()]
        .filter((s) => (q.state ? s.state === q.state : tabStates.includes(s.state)))
        .filter((s) => !q.type || s.type === q.type)
        .filter((s) => !q.apiKeyId || s.apiKeyId === q.apiKeyId)
        .filter((s) => !q.nodeId || s.nodeId === q.nodeId)
        .filter((s) => !q.createdAfter || s.createdAt >= q.createdAfter)
        .filter((s) => !q.createdBefore || s.createdAt < q.createdBefore)
        .filter((s) => !q.metadata || s.metadata?.[q.metadata.key] === q.metadata.value)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
      if (q.cursor !== undefined) {
        // Curseur opaque : identifiant de la dernière session rendue (stable : tri par création puis identifiant).
        let after: string;
        try {
          after = atob(q.cursor);
        } catch {
          return fail(400, 'invalid_option');
        }
        const index = list.findIndex((s) => s.id === after);
        if (index < 0) return fail(400, 'invalid_option');
        list = list.slice(index + 1);
      }
      const page = list.slice(0, limit);
      const nextCursor = list.length > limit ? btoa(page.at(-1)!.id) : null;
      return done({ data: page.map(publicSession), nextCursor });
    },

    async getSession(id) {
      const s = state.sessions.get(id);
      return s ? done(publicSession(s)) : fail(404, 'session_not_found');
    },

    async releaseSession(id) {
      const s = state.sessions.get(id);
      if (!s) return fail(404, 'session_not_found');
      if (s.state === 'pending' || s.state === 'running') {
        s.state = 'ended';
        s.endReason = 'released';
        s.endedAt = iso(now());
        emit({ type: 'state', sessionId: id, at: s.endedAt, data: { state: 'ended', endReason: 'released' } });
        for (const viewer of [...viewers]) if (viewer.sessionId === id) closeViewer(viewer, 'session_ended');
        const node = state.nodes.find((n) => n.id === s.nodeId);
        if (node && node.slotsFree < node.slotsTotal) node.slotsFree += 1;
      }
      return done(publicSession(s));
    },

    async extendSession(id, timeoutSeconds) {
      const s = state.sessions.get(id);
      if (!s) return fail(404, 'session_not_found');
      if (s.state !== 'running' && s.state !== 'pending') return fail(409, 'invalid_option');
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) return fail(400, 'invalid_option');
      const ceiling = Date.parse(s.createdAt) + s.maxDurationSeconds * 1000;
      s.expiresAt = iso(Math.min(Date.parse(s.expiresAt) + timeoutSeconds * 1000, ceiling));
      return done(publicSession(s));
    },

    async listRecordings(id) {
      return state.sessions.has(id) ? done({ data: clone(state.recordings.get(id) ?? []) }) : fail(404, 'session_not_found');
    },
    async listFiles(id) {
      return state.sessions.has(id) ? done({ data: clone(state.files.get(id) ?? []) }) : fail(404, 'session_not_found');
    },
    recordingHref: (id, rid) => `/v1/sessions/${encodeURIComponent(id)}/recordings/${encodeURIComponent(rid)}`,
    fileHref: (id, fid) => `/v1/sessions/${encodeURIComponent(id)}/files/${encodeURIComponent(fid)}`,

    watchEvents(id, onEvent) {
      let active = true;
      const set = watchers.get(id) ?? new Set();
      watchers.set(id, set);
      const listener = (e: SessionEvent): void => {
        if (active) onEvent(e);
      };
      setTimeout(() => {
        if (!active) return;
        for (const e of state.events.get(id) ?? []) onEvent(clone(e));
        set.add(listener);
      }, 0);
      return () => {
        active = false;
        set.delete(listener);
      };
    },

    async openLive(id, mode) {
      const s = state.sessions.get(id);
      if (!s || s.state !== 'running') return fail(404, 'session_not_found');
      if (mode === 'rw' && !s.interactiveLiveView) return fail(403, 'forbidden');
      const viewer: LiveViewer = { sessionId: id, mode, listeners: [], timer: undefined, closed: false };
      viewers.add(viewer);
      const counters = stats.get(id) ?? { forwarded: 0, dropped: 0 };
      stats.set(id, counters);
      const broadcast = (m: LiveServerMessage): void => {
        for (const listener of viewer.listeners) listener(m);
      };
      let ts = 0;
      const frame = (): void => broadcast({ t: 'frame', data: FRAME, ts: (ts += 100), w: 1280, h: 800, tab: 'tab_1' });
      setTimeout(() => {
        if (viewer.closed) return;
        broadcast({ t: 'meta', url: 'https://fixture.test/panier', title: 'Panier — fixture', tabs: [{ id: 'tab_1', title: 'Panier — fixture', url: 'https://fixture.test/panier' }] });
        frame();
        viewer.timer = setInterval(frame, 1_000);
      }, 0);
      const connection: LiveConnection = {
        mode,
        onMessage: (listener) => void viewer.listeners.push(listener),
        send(message: LiveClientMessage) {
          if (viewer.closed || message.t === 'ping' || message.t === 'tab') return;
          // Lecture seule : le relais du nœud n'accepte que `tab` et `ping` (04d § 1.3) ; toute entrée est écartée.
          if (viewer.mode === 'ro') counters.dropped += 1;
          else counters.forwarded += 1;
        },
        close: () => closeViewer(viewer, 'viewer_closed'),
      };
      return done(connection);
    },

    async listNodes() {
      return done({ data: clone(state.nodes) });
    },
    async drainNode(id) {
      const node = state.nodes.find((n) => n.id === id);
      if (!node) return fail(404, 'no_node');
      if (node.state === 'ready') node.state = 'draining';
      return done(clone(node), 202);
    },

    async listTenants() {
      return done({ data: clone(state.tenants) });
    },
    async listKeys() {
      return done({ data: clone(state.keys) });
    },
    async createKey(request) {
      const name = request.name.trim();
      if (!state.tenants.some((t) => t.id === request.tenantId)) return fail(400, 'invalid_option');
      if (name.length < 1 || name.length > 64) return fail(400, 'invalid_option');
      if (request.scopes.length === 0 || request.scopes.some((s) => !(API_KEY_SCOPES as readonly string[]).includes(s))) return fail(400, 'invalid_option');
      if (request.expiresAt !== null && !(Date.parse(request.expiresAt) > now())) return fail(400, 'invalid_option');
      keySequence += 1;
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const rnd = random(1000 + keySequence);
      const body = Array.from({ length: 32 }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      const prefix = `symb_live_${body.slice(0, 4)}`;
      const key: ApiKey = { id: `key_new_${keySequence}`, tenantId: request.tenantId, name, prefix, scopes: [...request.scopes], expiresAt: request.expiresAt, lastUsedAt: null, createdAt: iso(now()), revokedAt: null };
      state.keys.push(key);
      return done({ key: clone(key), secret: `${prefix}${body.slice(4)}` }, 201);
    },
    async revokeKey(id) {
      const key = state.keys.find((k) => k.id === id);
      if (!key) return fail(404, 'not_found');
      key.revokedAt ??= iso(now());
      return done(clone(key));
    },

    async listProfiles() {
      return done({ data: clone(state.profiles) });
    },
    async exportProfile(id) {
      const profile = state.profiles.find((p) => p.id === id);
      if (!profile) return fail(404, 'not_found' as 'profile_locked');
      return done(clone(state.profileStates.get(id) ?? { cookies: [], origins: [] }));
    },
    async importProfile(id, storage) {
      const profile = state.profiles.find((p) => p.id === id);
      if (!profile) return fail(404, 'not_found' as 'invalid_option');
      if (profile.lockedBySession !== null) return fail(409, 'profile_locked');
      if (typeof storage !== 'object' || storage === null || !Array.isArray(storage.cookies) || !Array.isArray(storage.origins)) return fail(400, 'invalid_option');
      state.profileStates.set(id, clone(storage));
      profile.version += 1;
      profile.updatedAt = iso(now());
      return done(clone(profile));
    },

    async listProxyProfiles() {
      return done({ data: state.proxies.map(({ reachable: _r, exitIp: _e, ...p }) => clone(p)) });
    },
    async testProxyProfile(id) {
      const proxy = state.proxies.find((p) => p.id === id);
      if (!proxy) return fail(404, 'not_found' as 'proxy_unreachable');
      if (!proxy.reachable) return fail(502, 'proxy_unreachable');
      return done({ ok: true as const, exitIp: proxy.exitIp, latencyMs: 84 });
    },

    async usage(q) {
      try {
        usageQueryString(q);
      } catch {
        return fail(400, 'invalid_option');
      }
      const rows = state.usage.filter((u) => u.day >= q.from && u.day <= q.to && (!q.apiKeyId || u.apiKeyId === q.apiKeyId));
      const groups = new Map<string, UsageItem>();
      for (const row of rows) {
        const key = q.groupBy === 'day' ? row.day : row.apiKeyId;
        const item = groups.get(key) ?? (q.groupBy === 'day' ? { day: row.day, sessions: 0, billedSeconds: 0, bytesIn: 0, bytesOut: 0 } : { apiKeyId: row.apiKeyId, apiKeyPrefix: row.apiKeyPrefix, sessions: 0, billedSeconds: 0, bytesIn: 0, bytesOut: 0 });
        item.sessions += row.sessions;
        item.billedSeconds += row.billedSeconds;
        item.bytesIn += row.bytesIn;
        item.bytesOut += row.bytesOut;
        groups.set(key, item);
      }
      const items = [...groups.values()].sort((a, b) => ((a.day ?? a.apiKeyPrefix ?? '') < (b.day ?? b.apiKeyPrefix ?? '') ? -1 : 1));
      const totals = items.reduce((t, i) => ({ sessions: t.sessions + i.sessions, billedSeconds: t.billedSeconds + i.billedSeconds, bytesIn: t.bytesIn + i.bytesIn, bytesOut: t.bytesOut + i.bytesOut }), { sessions: 0, billedSeconds: 0, bytesIn: 0, bytesOut: 0 });
      const report: UsageReport = { period: { from: q.from, to: q.to }, items, totals, drift: { ...state.drift, checkedAt: iso(now() - 20 * MIN) } };
      return done(report);
    },
    usageCsvHref: (q) => `/v1/usage.csv${usageQueryString(q)}`,
    async reconcile() {
      state.drift = { seconds: 0, bytes: 0 };
      return done({ started: true as const }, 202);
    },

    liveStats: (sessionId) => ({ ...(stats.get(sessionId) ?? { forwarded: 0, dropped: 0 }) }),
    eventsOf: (sessionId) => clone(state.events.get(sessionId) ?? []),
    usageCsv(q) {
      const rows = state.usage.filter((u) => u.day >= q.from && u.day <= q.to && (!q.apiKeyId || u.apiKeyId === q.apiKeyId));
      const lines = ['period,api_key_prefix,sessions,billed_seconds,bytes_in,bytes_out'];
      const groups = new Map<string, { period: string; prefix: string; s: number; b: number; i: number; o: number }>();
      for (const r of rows) {
        const period = q.groupBy === 'day' ? r.day : `${q.from}/${q.to}`;
        const id = `${period}|${r.apiKeyPrefix}`;
        const g = groups.get(id) ?? { period, prefix: r.apiKeyPrefix, s: 0, b: 0, i: 0, o: 0 };
        g.s += r.sessions;
        g.b += r.billedSeconds;
        g.i += r.bytesIn;
        g.o += r.bytesOut;
        groups.set(id, g);
      }
      for (const g of groups.values()) lines.push([g.period, g.prefix, g.s, g.b, g.i, g.o].map((v) => csvCell(String(v))).join(','));
      return `${lines.join('\n')}\n`;
    },
  };
  return api;
}
