// SPDX-License-Identifier: AGPL-3.0-only
// Service API typé des écrans de la console (tâche 3.6 ; 04 § 2 et § 9, 04c § 4.4 et § 5.1, 04d § 1, § 2.2, § 4.3, § 5.2) :
// routes, chaîne de requête des filtres, liens de téléchargement, lecture SSE, URL du flux de la vue en direct.
import { describe, expect, test } from 'vitest';
import { createHttpClient } from './client.js';
import { CONSOLE_ROUTES, createHttpConsoleApi, liveStreamUrl, parseSse, sessionQueryString, usageQueryString } from './console.js';

function recorder(respond: (url: string, init?: RequestInit) => Response = () => Response.json({ data: [], nextCursor: null })) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const http = createHttpClient({
    baseUrl: 'https://console.example.test',
    fetch: async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
      return respond(url, init);
    },
  });
  return { calls, api: createHttpConsoleApi(http, { baseUrl: 'https://console.example.test' }) };
}

describe('routes des écrans (04 § 2)', () => {
  test('sessions, actions, enregistrements, fichiers, vue en direct ; identifiants encodés', () => {
    expect(CONSOLE_ROUTES.sessions).toBe('/v1/sessions');
    expect(CONSOLE_ROUTES.session('a/b?c')).toBe('/v1/sessions/a%2Fb%3Fc');
    expect(CONSOLE_ROUTES.extend('s1')).toBe('/v1/sessions/s1/extend');
    expect(CONSOLE_ROUTES.events('s1')).toBe('/v1/sessions/s1/events');
    expect(CONSOLE_ROUTES.recordings('s1')).toBe('/v1/sessions/s1/recordings');
    expect(CONSOLE_ROUTES.recording('s1', 'r1')).toBe('/v1/sessions/s1/recordings/r1');
    expect(CONSOLE_ROUTES.files('s1')).toBe('/v1/sessions/s1/files');
    expect(CONSOLE_ROUTES.file('s1', 'f1')).toBe('/v1/sessions/s1/files/f1');
    expect(CONSOLE_ROUTES.liveUrl('s1')).toBe('/v1/sessions/s1/live-url');
  });

  test('admin, profils, proxys, consommation', () => {
    expect(CONSOLE_ROUTES.nodes).toBe('/v1/admin/nodes');
    expect(CONSOLE_ROUTES.drain('n 1')).toBe('/v1/admin/nodes/n%201/drain');
    expect(CONSOLE_ROUTES.tenants).toBe('/v1/admin/tenants');
    expect(CONSOLE_ROUTES.keys).toBe('/v1/admin/keys');
    expect(CONSOLE_ROUTES.key('k1')).toBe('/v1/admin/keys/k1');
    expect(CONSOLE_ROUTES.profiles).toBe('/v1/profiles');
    expect(CONSOLE_ROUTES.profileState('p1')).toBe('/v1/profiles/p1/storage-state');
    expect(CONSOLE_ROUTES.profileImport('p1')).toBe('/v1/profiles/p1/import');
    expect(CONSOLE_ROUTES.proxyProfiles).toBe('/v1/proxy-profiles');
    expect(CONSOLE_ROUTES.proxyTest('x1')).toBe('/v1/proxy-profiles/x1/test');
    expect(CONSOLE_ROUTES.usage).toBe('/v1/usage');
    expect(CONSOLE_ROUTES.usageCsv).toBe('/v1/usage.csv');
    expect(CONSOLE_ROUTES.reconcile).toBe('/v1/admin/usage/reconcile');
  });
});

describe('filtres de la liste des sessions (04 § 9, 04d § 5.2)', () => {
  test('onglet « En cours » : pending et running ; « Passées » : états terminaux', () => {
    expect(sessionQueryString({ tab: 'current' })).toBe('?state=pending%2Crunning&limit=50');
    expect(sessionQueryString({ tab: 'past' })).toBe('?state=ended%2Ctimed_out%2Cfailed&limit=50');
  });

  test('état, type, clé, nœud, période, metadata, curseur', () => {
    const query = new URLSearchParams(
      sessionQueryString({
        tab: 'past',
        state: 'failed',
        type: 'dedicated',
        apiKeyId: 'key_1',
        nodeId: 'node-a',
        createdAfter: '2026-09-01T00:00:00.000Z',
        createdBefore: '2026-10-01T00:00:00.000Z',
        metadata: { key: 'run', value: 'r 42' },
        cursor: 'opaque=+/',
        limit: 20,
      }).slice(1),
    );
    expect(Object.fromEntries(query)).toEqual({
      state: 'failed',
      type: 'dedicated',
      apiKeyId: 'key_1',
      nodeId: 'node-a',
      createdAfter: '2026-09-01T00:00:00.000Z',
      createdBefore: '2026-10-01T00:00:00.000Z',
      'metadata.run': 'r 42',
      cursor: 'opaque=+/',
      limit: '20',
    });
  });

  test('un état hors de l’onglet est refusé (pas de mélange en cours / passées)', () => {
    expect(() => sessionQueryString({ tab: 'current', state: 'ended' })).toThrow(/onglet/);
    expect(() => sessionQueryString({ tab: 'past', limit: 500 })).toThrow(/limit/);
    expect(() => sessionQueryString({ tab: 'past', metadata: { key: 'a=b', value: 'x' } })).toThrow(/metadata/);
  });
});

describe('consommation (04d § 4.3)', () => {
  test('période, regroupement, clé ; lien CSV sur la même origine', () => {
    expect(usageQueryString({ from: '2026-09-01', to: '2026-09-30', groupBy: 'day' })).toBe('?from=2026-09-01&to=2026-09-30&groupBy=day');
    expect(usageQueryString({ from: '2026-09-01', to: '2026-09-30', groupBy: 'key', apiKeyId: 'key_1' })).toBe('?from=2026-09-01&to=2026-09-30&groupBy=key&apiKeyId=key_1');
    const { api } = recorder();
    expect(api.usageCsvHref({ from: '2026-09-01', to: '2026-09-30', groupBy: 'key' })).toBe('/v1/usage.csv?from=2026-09-01&to=2026-09-30&groupBy=key');
    expect(() => usageQueryString({ from: '2026-13-01', to: '2026-09-30', groupBy: 'day' })).toThrow(/période/);
    expect(() => usageQueryString({ from: '2026-09-30', to: '2026-09-01', groupBy: 'day' })).toThrow(/période/);
  });
});

describe('appels HTTP', () => {
  test('liste, détail, libération, prolongation, drainage, clés, profils, proxys, réconciliation', async () => {
    const { api, calls } = recorder(() => Response.json({}));
    await api.listSessions({ tab: 'current' });
    await api.getSession('s1');
    await api.releaseSession('s1');
    await api.extendSession('s1', 120);
    await api.listRecordings('s1');
    await api.listFiles('s1');
    await api.listNodes();
    await api.drainNode('n1');
    await api.listTenants();
    await api.listKeys();
    await api.createKey({ tenantId: 't1', name: 'ci', scopes: ['sessions:read'], expiresAt: null });
    await api.revokeKey('k1');
    await api.listProfiles();
    await api.exportProfile('p1');
    await api.importProfile('p1', { cookies: [], origins: [] });
    await api.listProxyProfiles();
    await api.testProxyProfile('x1');
    await api.usage({ from: '2026-09-01', to: '2026-09-30', groupBy: 'day' });
    await api.reconcile();
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://console.example.test', '')}`)).toEqual([
      'GET /v1/sessions?state=pending%2Crunning&limit=50',
      'GET /v1/sessions/s1',
      'DELETE /v1/sessions/s1',
      'POST /v1/sessions/s1/extend',
      'GET /v1/sessions/s1/recordings',
      'GET /v1/sessions/s1/files',
      'GET /v1/admin/nodes',
      'POST /v1/admin/nodes/n1/drain',
      'GET /v1/admin/tenants',
      'GET /v1/admin/keys',
      'POST /v1/admin/keys',
      'DELETE /v1/admin/keys/k1',
      'GET /v1/profiles',
      'GET /v1/profiles/p1/storage-state',
      'POST /v1/profiles/p1/import',
      'GET /v1/proxy-profiles',
      'POST /v1/proxy-profiles/x1/test',
      'GET /v1/usage?from=2026-09-01&to=2026-09-30&groupBy=day',
      'POST /v1/admin/usage/reconcile',
    ]);
    expect(calls.find((c) => c.url.endsWith('/extend'))?.body).toEqual({ timeoutSeconds: 120 });
    expect(calls.find((c) => c.url.endsWith('/admin/keys') && c.method === 'POST')?.body).toEqual({ tenantId: 't1', name: 'ci', scopes: ['sessions:read'], expiresAt: null });
  });

  test('liens de téléchargement : chemins relatifs de la même origine', () => {
    const { api } = recorder();
    expect(api.recordingHref('s1', 'r/1')).toBe('/v1/sessions/s1/recordings/r%2F1');
    expect(api.fileHref('s1', 'f1')).toBe('/v1/sessions/s1/files/f1');
  });
});

describe('SSE (04 § 2 : `GET /v1/sessions/{id}/events`)', () => {
  test('événements découpés, id et data JSON ; commentaires et lignes inconnues ignorés ; morceaux coupés n’importe où', () => {
    const stream = ': ping\n\nid: 1\nevent: state\ndata: {"type":"state","sessionId":"s1","at":"2026-10-02T10:00:00.000Z",\ndata: "data":{"state":"running"}}\n\nretry: 5000\n\nid: 2\ndata: {"type":"download","sessionId":"s1","at":"2026-10-02T10:00:01.000Z","data":{"id":"f1","name":"a.pdf","state":"completed","bytes":10}}\n\n';
    const parser = parseSse();
    const out: { id?: string; data: string }[] = [];
    for (let i = 0; i < stream.length; i += 7) out.push(...parser.push(stream.slice(i, i + 7)));
    expect(out.map((e) => e.id)).toEqual(['1', '2']);
    expect(JSON.parse(out[0]!.data)).toMatchObject({ type: 'state', data: { state: 'running' } });
    expect(parser.retryMs()).toBe(5000);
  });
});

describe('vue en direct (04d § 1.1)', () => {
  test('URL du flux dérivée de l’URL signée : même jeton, chemin /live/stream, schéma WebSocket de la même origine', () => {
    expect(liveStreamUrl('https://console.example.test/v1/sessions/s1/live?t=abc.def', 'https://console.example.test')).toBe('wss://console.example.test/v1/sessions/s1/live/stream?t=abc.def');
    expect(liveStreamUrl('http://127.0.0.1:4000/v1/sessions/s1/live?t=x', 'http://127.0.0.1:4000')).toBe('ws://127.0.0.1:4000/v1/sessions/s1/live/stream?t=x');
    expect(() => liveStreamUrl('https://autre.example.test/v1/sessions/s1/live?t=x', 'https://console.example.test')).toThrow(/origine/);
    expect(() => liveStreamUrl('https://console.example.test/v1/sessions/s1/live', 'https://console.example.test')).toThrow(/jeton/);
  });
});
