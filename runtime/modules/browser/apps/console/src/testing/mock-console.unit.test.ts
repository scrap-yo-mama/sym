// SPDX-License-Identifier: AGPL-3.0-only
// Simulation de l'API des écrans (tâche 3.6) : réponses conformes à la spec en attendant 2.2 (REST), 2.5 (SSE), 2.6
// (comptage) et 3.2 (vue en direct). Elle sert la console sous `vite`, les tests et le faux serveur des E2E.
import { describe, expect, test } from 'vitest';
import type { SessionEvent } from '@sym/contracts/browser';
import { CONSOLE_FIXTURE_NOW, createMockConsoleApi, csvCell } from './mock-console.js';

const ok = <T>(result: { ok: boolean; data?: T }): T => {
  if (!result.ok) throw new Error(`échec inattendu : ${JSON.stringify(result)}`);
  return result.data as T;
};

describe('sessions', () => {
  test('onglets : en cours = pending et running, passées = états terminaux ; tri par création décroissante', async () => {
    const api = createMockConsoleApi();
    const current = ok(await api.listSessions({ tab: 'current', limit: 200 }));
    const past = ok(await api.listSessions({ tab: 'past', limit: 200 }));
    expect(current.data.length).toBeGreaterThan(0);
    expect(current.data.every((s) => s.state === 'pending' || s.state === 'running')).toBe(true);
    expect(past.data.every((s) => ['ended', 'timed_out', 'failed'].includes(s.state))).toBe(true);
    for (const page of [current, past]) {
      const dates = page.data.map((s) => Date.parse(s.createdAt));
      expect(dates).toEqual([...dates].sort((a, b) => b - a));
    }
    const states = new Set([...current.data, ...past.data].map((s) => s.state));
    expect([...states].sort()).toEqual(['ended', 'failed', 'pending', 'running', 'timed_out']);
  });

  test('pagination par curseur : pages disjointes qui couvrent toute la liste, curseur nul à la fin', async () => {
    const api = createMockConsoleApi();
    const all = ok(await api.listSessions({ tab: 'past', limit: 200 })).data.map((s) => s.id);
    expect(all.length).toBeGreaterThan(50);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = ok(await api.listSessions({ tab: 'past', limit: 20, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.data.map((s) => s.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all);
    expect((await api.listSessions({ tab: 'past', cursor: 'faux' })).ok).toBe(false);
  });

  test('filtres : état, type, clé, nœud, période, metadata', async () => {
    const api = createMockConsoleApi();
    const list = async (q: Parameters<typeof api.listSessions>[0]) => ok(await api.listSessions({ limit: 200, ...q })).data;
    expect((await list({ tab: 'past', state: 'failed' })).every((s) => s.state === 'failed')).toBe(true);
    expect((await list({ tab: 'past', type: 'shared' })).every((s) => s.type === 'shared')).toBe(true);
    const byKey = await list({ tab: 'past', apiKeyId: 'key_ci' });
    expect(byKey.length).toBeGreaterThan(0);
    expect(byKey.every((s) => s.apiKeyId === 'key_ci')).toBe(true);
    expect((await list({ tab: 'current', nodeId: 'node-b' })).every((s) => s.nodeId === 'node-b')).toBe(true);
    const after = new Date(CONSOLE_FIXTURE_NOW - 2 * 86_400_000).toISOString();
    expect((await list({ tab: 'past', createdAfter: after })).every((s) => s.createdAt >= after)).toBe(true);
    const tagged = await list({ tab: 'past', metadata: { key: 'run', value: 'nightly' } });
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((s) => s.metadata?.run === 'nightly')).toBe(true);
    expect(await list({ tab: 'past', metadata: { key: 'run', value: 'absent' } })).toEqual([]);
  });

  test('détail, libération (rejouable), prolongation plafonnée ; session inconnue : 404', async () => {
    const api = createMockConsoleApi();
    const running = ok(await api.listSessions({ tab: 'current', state: 'running', limit: 1 })).data[0]!;
    expect((await api.getSession('inconnue')).ok).toBe(false);
    expect(await api.getSession('inconnue')).toMatchObject({ status: 404, code: 'session_not_found' });
    const extended = ok(await api.extendSession(running.id, 120));
    expect(Date.parse(extended.expiresAt)).toBe(Date.parse(running.expiresAt) + 120_000);
    const capped = ok(await api.extendSession(running.id, 999_999));
    expect(Date.parse(capped.expiresAt)).toBeLessThanOrEqual(Date.parse(running.createdAt) + 3_600_000);
    const released = ok(await api.releaseSession(running.id));
    expect(released).toMatchObject({ state: 'ended', endReason: 'released' });
    expect(ok(await api.releaseSession(running.id))).toMatchObject({ state: 'ended', endReason: 'released' });
    expect(await api.extendSession(running.id, 60)).toMatchObject({ ok: false, status: 409, code: 'invalid_option' });
  });

  test('événements : historique puis nouveaux événements (libération) ; désabonnement', async () => {
    const api = createMockConsoleApi();
    const running = ok(await api.listSessions({ tab: 'current', state: 'running', limit: 1 })).data[0]!;
    const events: SessionEvent[] = [];
    const stop = api.watchEvents(running.id, (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 0));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ type: 'state', sessionId: running.id, data: { state: 'running' } });
    const before = events.length;
    await api.releaseSession(running.id);
    expect(events.slice(before)).toEqual([expect.objectContaining({ type: 'state', data: { state: 'ended', endReason: 'released' } })]);
    stop();
    await api.releaseSession(running.id);
    expect(events).toHaveLength(before + 1);
  });

  test('enregistrements et fichiers de la session', async () => {
    const api = createMockConsoleApi();
    const withRecordings = ok(await api.listSessions({ tab: 'past', limit: 200 })).data.find((s) => s.id === 'ses_recorded')!;
    const recordings = ok(await api.listRecordings(withRecordings.id)).data;
    expect(recordings.map((r) => r.type).sort()).toEqual(['console', 'har', 'trace', 'video']);
    const files = ok(await api.listFiles(withRecordings.id)).data;
    expect(files[0]).toMatchObject({ name: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});

describe('vue en direct (04d § 1)', () => {
  test('lecture seule : métadonnées et trames reçues, toute entrée écartée ; interactif refusé sans l’option', async () => {
    const api = createMockConsoleApi();
    const live = ok(await api.openLive('ses_live', 'ro'));
    const kinds: string[] = [];
    live.onMessage((m) => kinds.push(m.t));
    await new Promise((r) => setTimeout(r, 30));
    expect(kinds).toContain('meta');
    expect(kinds).toContain('frame');
    live.send({ t: 'key', type: 'keyDown', key: 'a' });
    live.send({ t: 'ping' });
    expect(api.liveStats('ses_live')).toEqual({ forwarded: 0, dropped: 1 });
    live.close();
    expect(await api.openLive('ses_live_ro_only', 'rw')).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
  });

  test('interactif : entrées transmises ; session finie : fermeture annoncée', async () => {
    const api = createMockConsoleApi();
    const live = ok(await api.openLive('ses_live', 'rw'));
    const closed: string[] = [];
    live.onMessage((m) => {
      if (m.t === 'closed') closed.push(m.reason);
    });
    live.send({ t: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left' });
    live.send({ t: 'text', text: 'bonjour' });
    expect(api.liveStats('ses_live')).toEqual({ forwarded: 2, dropped: 0 });
    await api.releaseSession('ses_live');
    expect(closed).toEqual(['session_ended']);
  });
});

describe('nœuds', () => {
  test('états ready, draining, down ; drainage', async () => {
    const api = createMockConsoleApi();
    const nodes = ok(await api.listNodes()).data;
    expect(new Set(nodes.map((n) => n.state))).toEqual(new Set(['ready', 'draining', 'down']));
    for (const n of nodes) expect(n.slotsFree).toBeLessThanOrEqual(n.slotsTotal);
    const ready = nodes.find((n) => n.state === 'ready')!;
    expect(ok(await api.drainNode(ready.id))).toMatchObject({ id: ready.id, state: 'draining' });
    expect(await api.drainNode('absent')).toMatchObject({ ok: false, status: 404, code: 'no_node' });
  });
});

describe('clés et quotas', () => {
  test('création : clé affichée une seule fois, jamais relue ; révocation', async () => {
    const api = createMockConsoleApi();
    const tenants = ok(await api.listTenants()).data;
    expect(tenants[0]).toMatchObject({ quotas: { concurrentSessions: expect.any(Number), minutesPerMonth: expect.any(Number), bytesPerMonth: expect.any(Number), maxSessionSeconds: expect.any(Number) } });
    const created = ok(await api.createKey({ tenantId: tenants[0]!.id, name: 'e2e', scopes: ['sessions:read', 'sessions:write'], expiresAt: null }));
    expect(created.secret.startsWith(created.key.prefix)).toBe(true);
    expect(created.secret.length).toBeGreaterThan(created.key.prefix.length + 20);
    const listed = ok(await api.listKeys()).data;
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    expect(listed.find((k) => k.id === created.key.id)).toMatchObject({ name: 'e2e', revokedAt: null });
    expect(ok(await api.revokeKey(created.key.id)).revokedAt).not.toBeNull();
    expect(await api.createKey({ tenantId: tenants[0]!.id, name: '', scopes: [], expiresAt: null })).toMatchObject({ ok: false, status: 400, code: 'invalid_option' });
    expect(await api.createKey({ tenantId: tenants[0]!.id, name: 'x', scopes: ['root' as never], expiresAt: null })).toMatchObject({ ok: false, code: 'invalid_option' });
  });
});

describe('profils et proxys', () => {
  test('profil verrouillé par une session (import refusé 409), export storageState, import', async () => {
    const api = createMockConsoleApi();
    const profiles = ok(await api.listProfiles()).data;
    const locked = profiles.find((p) => p.lockedBySession !== null)!;
    const free = profiles.find((p) => p.lockedBySession === null)!;
    expect(await api.importProfile(locked.id, { cookies: [], origins: [] })).toMatchObject({ ok: false, status: 409, code: 'profile_locked' });
    const state = ok(await api.exportProfile(free.id));
    expect(state).toMatchObject({ cookies: expect.any(Array), origins: expect.any(Array) });
    const imported = ok(await api.importProfile(free.id, { cookies: [{ name: 'zz', value: 'test', domain: 'fixture.test', path: '/' }], origins: [] }));
    expect(imported.version).toBe(free.version + 1);
    expect(await api.importProfile(free.id, { cookies: 'non' } as never)).toMatchObject({ ok: false, status: 400, code: 'invalid_option' });
  });

  test('profils de proxy : mot de passe jamais rendu, utilisateur masqué ; test de connectivité', async () => {
    const api = createMockConsoleApi();
    const proxies = ok(await api.listProxyProfiles()).data;
    for (const p of proxies) {
      expect(p.passwordSet).toBe(true);
      expect(p.username).toMatch(/\*\*\*$/);
      expect(Object.keys(p)).not.toContain('password');
    }
    const good = proxies.find((p) => p.name.includes('ISP'))!;
    expect(ok(await api.testProxyProfile(good.id))).toMatchObject({ ok: true, exitIp: expect.stringMatching(/^(\d+\.){3}\d+$/), latencyMs: expect.any(Number) });
    const bad = proxies.find((p) => !p.name.includes('ISP'))!;
    expect(await api.testProxyProfile(bad.id)).toMatchObject({ ok: false, status: 502, code: 'proxy_unreachable' });
  });
});

describe('consommation (04d § 4)', () => {
  test('par jour et par clé : totaux = somme des lignes ; écart de réconciliation ; réconciliation', async () => {
    const api = createMockConsoleApi();
    const from = new Date(CONSOLE_FIXTURE_NOW - 29 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(CONSOLE_FIXTURE_NOW).toISOString().slice(0, 10);
    for (const groupBy of ['day', 'key'] as const) {
      const report = ok(await api.usage({ from, to, groupBy }));
      expect(report.period).toEqual({ from, to });
      expect(report.items.length).toBeGreaterThan(0);
      for (const field of ['sessions', 'billedSeconds', 'bytesIn', 'bytesOut'] as const) {
        expect(report.totals[field]).toBe(report.items.reduce((sum, i) => sum + i[field], 0));
      }
      if (groupBy === 'day') expect(report.items.every((i) => typeof i.day === 'string')).toBe(true);
      else expect(report.items.every((i) => typeof i.apiKeyPrefix === 'string')).toBe(true);
    }
    const before = ok(await api.usage({ from, to, groupBy: 'day' }));
    expect(before.drift.seconds).toBeGreaterThan(0);
    expect(ok(await api.reconcile())).toEqual({ started: true });
    expect(ok(await api.usage({ from, to, groupBy: 'day' })).drift.seconds).toBe(0);
  });

  test('CSV : colonnes de 04d § 4.3, cellules dangereuses neutralisées', async () => {
    const api = createMockConsoleApi();
    const csv = api.usageCsv({ from: '2026-09-01', to: '2026-09-30', groupBy: 'key' });
    expect(csv.split('\n')[0]).toBe('period,api_key_prefix,sessions,billed_seconds,bytes_in,bytes_out');
    for (const [raw, safe] of [
      ['=1+1', "'=1+1"],
      ['+cmd', "'+cmd"],
      ['-2', "'-2"],
      ['@x', "'@x"],
      ['a,b', '"a,b"'],
      ['dit "oui"', '"dit ""oui"""'],
      ['symb_live_', 'symb_live_'],
    ]) {
      expect(csvCell(raw!), raw).toBe(safe);
    }
  });
});
