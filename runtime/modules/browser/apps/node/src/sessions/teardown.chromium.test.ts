// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
// Tâche 1.7 sur de vrais Chromium 153, chaîne complète du nœud : superviseur (1.2) → hôte des sessions (1.7) → pool (1.1),
// sessions shared (1.3) et dedicated (1.4). Livrable : assert_session_isolation et assert_session_teardown verts sur 500
// sessions alternées entre 2 clients (04c C8, C9 ; 04b P3, P4), plus chaque déclencheur de fin (04c § 3.2 : libération, délai
// total, inactivité, plantage, arrêt du nœud, nœud perdu puis balayeur) et l'ordre de destruction (egress fermé avant SIGKILL).
// L'egress réel est la tâche 1.5 : un egress témoin enregistre ses deux étapes (fermeture, arrêt) et l'état du processus.
// Utilisateur non root exigé. Sécurité des tests : seul le processus principal d'un Chromium lancé ici est signalé, par son
// pid exact (plantage simulé) ; les groupes sont tués par OwnedProcessGroups (groupes enregistrés au lancement seulement).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemorySessionStore, type MemorySessionStore } from '@sym-browser/core';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dedicatedLauncher } from '../dedicated/dedicated.js';
import { BrowserPool, OwnedProcessGroups, PROVISIONAL_CAPACITY, playwrightLauncher, readProcessTable, startClosedLaunchProxy, type BrowserLauncher, type ClosedLaunchProxy, type LaunchedBrowser } from '../pool/index.js';
import { SessionHost, type HostLease, type SessionEgress } from './host.js';
import { SessionSupervisor } from './supervisor.js';

const ORIGIN = 'https://zz-teardown.invalid';
const isRoot = process.getuid?.() === 0;
let proxy: ClosedLaunchProxy;
const roots: string[] = [];
const tmpBefore = new Set(readdirSync(tmpdir()));

beforeAll(async () => {
  if (isRoot) throw new Error('tests Chromium : lance-les sous un utilisateur non root (le bac à sable de Chromium refuse root, 03 § 7).');
  proxy = await startClosedLaunchProxy();
});
afterAll(async () => {
  await proxy?.close();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const alive = (pgid: number) => readProcessTable().filter((p) => p.pgid === pgid && p.state !== 'Z');
const running = (pid: number) => readProcessTable().some((p) => p.pid === pid && p.state !== 'Z');

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 20));
  }
}

type EgressRecord = { closedWhileRunning: boolean | undefined; stoppedAfterDirRemoved: boolean | undefined; closed: number; stopped: number };

function setup(slotsTotal = 6) {
  const groups = new OwnedProcessGroups();
  const dataDir = mkdtempSync(join(tmpdir(), 'symb-1-7-'));
  roots.push(dataDir);
  /** Chromium lancés, par identifiant de navigateur du pool (pid exact du processus principal). */
  const browsers = new Map<string, LaunchedBrowser>();
  const record = (launcher: BrowserLauncher): BrowserLauncher => async (purpose) => {
    const launched = await launcher(purpose);
    browsers.set(launched.id, launched);
    return launched;
  };
  const pool = new BrowserPool({
    slotsTotal,
    warmBrowsers: 1,
    launch: record(playwrightLauncher({ launchProxyUrl: proxy.url, groups })),
    // La destruction de sessions/{id} revient à l'hôte (étape 6, après la copie des objets de l'étape 5).
    launchDedicated: record(dedicatedLauncher({ launchProxyUrl: proxy.url, groups, dataDir, removeSessionDir: false })),
    constants: { ...PROVISIONAL_CAPACITY, contextsPerBrowser: 4 },
    sweep: () => groups.sweep(),
    sweepIntervalMs: 0,
  });
  const egress = new Map<string, EgressRecord>();
  const leases = new Map<string, HostLease>();
  const host = new SessionHost({
    pool,
    dataDir,
    egress: async ({ sessionId }): Promise<SessionEgress> => {
      const rec: EgressRecord = { closedWhileRunning: undefined, stoppedAfterDirRemoved: undefined, closed: 0, stopped: 0 };
      egress.set(sessionId, rec);
      return {
        close: async () => {
          rec.closed += 1;
          const pid = browsers.get(leases.get(sessionId)?.browserId ?? '')?.pid;
          rec.closedWhileRunning = pid !== undefined && running(pid);
        },
        stop: async () => {
          rec.stopped += 1;
          rec.stoppedAfterDirRemoved = !existsSync(join(dataDir, 'sessions', sessionId));
        },
      };
    },
  });
  const realAcquire = host.acquire.bind(host);
  host.acquire = async (request) => {
    const lease = await realAcquire(request);
    leases.set(request.sessionId, lease);
    return lease;
  };
  const store = createMemorySessionStore();
  const errors: unknown[] = [];
  const supervisor = new SessionSupervisor({ nodeId: 'node-1-7', pool: host, store, onError: (e) => errors.push(e), watchdogGraceMs: 60_000 });
  return { groups, dataDir, browsers, pool, host, store, supervisor, egress, leases, errors };
}

type Setup = ReturnType<typeof setup>;

async function start(s: Setup, sessionId: string, tenantId: string, type: 'shared' | 'dedicated', timing: { timeoutMs?: number; idleSeconds?: number } = {}) {
  const now = Date.now();
  const expiresAt = now + (timing.timeoutMs ?? 120_000);
  s.store.create({ sessionId, createdAt: now, expiresAt, maxDurationSeconds: 3600 });
  const outcome = await s.supervisor.start({ sessionId, type, tenantId, expiresAt, maxExpiresAt: now + 3_600_000, idleTimeoutSeconds: timing.idleSeconds ?? 300 });
  expect(outcome, sessionId).toEqual({ ok: true });
  return s.leases.get(sessionId)!;
}

/** Contexte où le client travaille : contexte neuf (shared), contexte par défaut du Chromium, par CDP (dedicated). */
async function clientContext(lease: HostLease): Promise<{ context: BrowserContext; cdp?: Browser }> {
  if (lease.type === 'shared') return { context: lease.context! };
  const cdp = await chromium.connectOverCDP(lease.cdpEndpoint!);
  return { context: cdp.contexts()[0]!, cdp };
}

async function openPage(context: BrowserContext, tag: string): Promise<Page> {
  await context.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'cache-control': 'max-age=3600' },
      body: `<!doctype html><title>${tag}</title><p>${tag}</p>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/${tag}`);
  return page;
}

/** BINV3 : session finie sans reste (processus du Chromium dédié, sessions/{id}, port CDP), egress fermé avant l'arrêt. */
async function expectTornDown(s: Setup, sessionId: string, opts: { egressBeforeKill?: boolean } = {}): Promise<void> {
  const lease = s.leases.get(sessionId)!;
  expect(existsSync(lease.dir.root), `${sessionId} : sessions/{id}`).toBe(false);
  const rec = s.egress.get(sessionId)!;
  expect(rec.closed, `${sessionId} : egress fermé une fois`).toBe(1);
  expect(rec.stopped, `${sessionId} : egress arrêté une fois`).toBe(1);
  expect(rec.stoppedAfterDirRemoved, `${sessionId} : egress arrêté après la suppression du répertoire`).toBe(true);
  if (lease.type === 'dedicated') {
    const pid = s.browsers.get(lease.browserId)!.pid!;
    expect(alive(pid), `${sessionId} : processus du Chromium dédié`).toEqual([]);
    expect(await refused(Number(new URL(lease.cdpEndpoint!).port)), `${sessionId} : port CDP`).toBe(true);
    if (opts.egressBeforeKill ?? true) expect(rec.closedWhileRunning, `${sessionId} : egress fermé avant SIGKILL`).toBe(true);
  }
}

/** Fin globale : 0 processus des Chromium lancés, 0 répertoire de session, 0 fichier temporaire de Playwright. */
async function expectNoResidue(s: Setup): Promise<void> {
  await s.pool.close();
  for (const browser of s.browsers.values()) expect(alive(browser.pid!), browser.id).toEqual([]);
  expect(readdirSync(join(s.dataDir, 'sessions'))).toEqual([]);
  expect(readdirSync(tmpdir()).filter((n) => !tmpBefore.has(n) && /^playwright[_-]/.test(n))).toEqual([]);
  expect(s.errors).toEqual([]);
}

describe('isolation et destruction de bout en bout (tâche 1.7)', () => {
  test('assert_session_isolation + assert_session_teardown : 500 sessions alternées entre 2 clients, shared et dedicated, aucune fuite ni reste', { timeout: 900_000 }, async () => {
    const s = setup(4);
    const seen = { shared: 0, dedicated: 0 };
    for (let i = 0; i < 500; i += 1) {
      const tenant = i % 2 === 0 ? 'A' : 'B';
      const type = Math.floor(i / 2) % 2 === 0 ? 'shared' : 'dedicated';
      seen[type] += 1;
      const sessionId = `iso-${String(i).padStart(3, '0')}-${tenant}`;
      const lease = await start(s, sessionId, tenant, type);
      const { context, cdp } = await clientContext(lease);

      // État de la session précédente (autre client, ou même client) : invisible.
      expect(await context.cookies(ORIGIN), `${sessionId} : cookies`).toEqual([]);
      expect(context.pages().filter((p) => p.url().startsWith(ORIGIN)), `${sessionId} : onglets`).toEqual([]);
      const page = await openPage(context, sessionId);
      expect(await page.evaluate(() => Object.keys(localStorage)), `${sessionId} : localStorage`).toEqual([]);
      expect(await page.evaluate(async () => (await caches.keys()).length), `${sessionId} : Cache Storage`).toBe(0);
      expect(await page.evaluate(() => document.cookie), `${sessionId} : document.cookie`).toBe('');

      // État propre à cette session : cookie, stockage, cache, fichier dans son répertoire.
      await context.addCookies([{ name: 'sid', value: `zz_${sessionId}`, url: ORIGIN }]);
      await page.evaluate(async (tag) => {
        localStorage.setItem(`k-${tag}`, tag);
        await (await caches.open(`c-${tag}`)).put(`/${tag}`, new Response(tag));
      }, sessionId);
      mkdirSync(join(lease.dir.root, 'downloads'), { recursive: true });
      writeFileSync(join(lease.dir.root, 'downloads', 'fichier.txt'), sessionId);

      const outcome = await s.supervisor.end(sessionId, 'released');
      expect(outcome, sessionId).toMatchObject({ ok: true, state: 'ended' });
      await expectTornDown(s, sessionId);
      if (cdp) await waitFor(() => !cdp.isConnected());
    }
    expect(seen).toEqual({ shared: 250, dedicated: 250 });
    expect(s.pool.stats().slotsFree).toBe(4);
    expect(s.host.active()).toEqual([]);
    await expectNoResidue(s);
  });

  test('assert_session_teardown (1.7) : libération, délai total, inactivité, plantage dedicated et shared, arrêt du nœud', { timeout: 300_000 }, async () => {
    const s = setup(8);
    const released = await start(s, 'fin-released', 'A', 'dedicated');
    const timeout = await start(s, 'fin-timeout', 'A', 'dedicated', { timeoutMs: 1_500 });
    const idle = await start(s, 'fin-idle', 'B', 'shared', { idleSeconds: 1 });
    const crashD = await start(s, 'fin-crash-dedicated', 'A', 'dedicated');
    const crashS1 = await start(s, 'fin-crash-shared-1', 'C', 'shared');
    const crashS2 = await start(s, 'fin-crash-shared-2', 'C', 'shared');
    const shutdownD = await start(s, 'fin-shutdown-dedicated', 'B', 'dedicated');
    const shutdownS = await start(s, 'fin-shutdown-shared', 'D', 'shared');
    expect(crashS1.browserId).toBe(crashS2.browserId);
    for (const lease of [released, timeout, idle, crashD, crashS1, crashS2, shutdownD, shutdownS]) {
      mkdirSync(join(lease.dir.root, 'uploads'), { recursive: true });
      writeFileSync(join(lease.dir.root, 'uploads', 'envoi.bin'), lease.sessionId);
    }

    await s.supervisor.end('fin-released', 'released');
    expect(s.store.get('fin-released')).toMatchObject({ state: 'ended', endReason: 'released' });
    await expectTornDown(s, 'fin-released');

    await waitFor(() => s.store.get('fin-timeout')?.state === 'timed_out');
    expect(s.store.get('fin-timeout')?.endReason).toBe('timeout');
    await expectTornDown(s, 'fin-timeout');

    await waitFor(() => s.store.get('fin-idle')?.state === 'timed_out');
    expect(s.store.get('fin-idle')?.endReason).toBe('idle');
    await expectTornDown(s, 'fin-idle');

    // Plantage d'un Chromium dédié : SIGKILL du seul processus principal lancé par ce test (pid exact).
    process.kill(s.browsers.get(crashD.browserId)!.pid!, 'SIGKILL');
    await waitFor(() => s.store.get('fin-crash-dedicated')?.state === 'failed');
    await s.supervisor.idle();
    expect(s.store.get('fin-crash-dedicated')?.endReason).toBe('crash');
    await expectTornDown(s, 'fin-crash-dedicated', { egressBeforeKill: false });

    // Plantage du Chromium chaud de C : ses deux sessions shared finissent `failed` raison `crash`.
    process.kill(s.browsers.get(crashS1.browserId)!.pid!, 'SIGKILL');
    await waitFor(() => s.store.get('fin-crash-shared-1')?.state === 'failed' && s.store.get('fin-crash-shared-2')?.state === 'failed');
    await s.supervisor.idle();
    for (const id of ['fin-crash-shared-1', 'fin-crash-shared-2']) {
      expect(s.store.get(id)?.endReason).toBe('crash');
      await expectTornDown(s, id);
    }

    // Arrêt du nœud (SIGTERM) : `ended` raison `node_shutdown`, puis pool fermé.
    await s.supervisor.shutdown();
    for (const id of ['fin-shutdown-dedicated', 'fin-shutdown-shared']) {
      expect(s.store.get(id)).toMatchObject({ state: 'ended', endReason: 'node_shutdown' });
      await expectTornDown(s, id);
    }
    expect(s.host.active()).toEqual([]);
    await expectNoResidue(s);
  });

  test('assert_session_teardown (1.7) : nœud perdu, puis redémarrage → le balayeur supprime les répertoires orphelins', { timeout: 120_000 }, async () => {
    const s = setup(4);
    const store: MemorySessionStore = s.store;
    const lost = await start(s, 'perdue-1', 'A', 'dedicated');
    // Nœud isolé : sessions détruites sans écriture (la passerelle les déclare `failed` raison `node_lost`).
    await s.supervisor.isolate();
    expect(store.get('perdue-1')?.state).toBe('running');
    await expectTornDown(s, 'perdue-1');
    // Reste d'un nœud planté (aucune destruction n'a pu tourner) : répertoire laissé sur le disque.
    mkdirSync(join(s.dataDir, 'sessions', 'orpheline-du-crash', 'profile'), { recursive: true });
    writeFileSync(join(s.dataDir, 'sessions', 'orpheline-du-crash', 'profile', 'Cookies'), 'zz');
    const restarted = new SessionHost({ pool: s.pool, dataDir: s.dataDir });
    expect(await restarted.sweep()).toEqual(['orpheline-du-crash']);
    expect(existsSync(lost.dir.root)).toBe(false);
    await expectNoResidue(s);
  });
});
