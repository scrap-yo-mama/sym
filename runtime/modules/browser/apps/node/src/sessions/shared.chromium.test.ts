// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.3 sur de vrais Chromium 153 : chaque option d'une session shared relue par `page.evaluate`, et
// `assert_session_isolation` (BINV1, partie shared) : cookie, localStorage et IndexedDB d'une session absents des autres,
// même client (même Chromium, autre contexte) ou client différent (autre Chromium). Le proxy de lancement reste fermé :
// les pages de test sont servies par `route.fulfill` (aucune requête ne sort). Utilisateur non root exigé.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BrowserPool, OwnedProcessGroups, PROVISIONAL_CAPACITY, playwrightLauncher, startClosedLaunchProxy, type ClosedLaunchProxy } from '../pool/index.js';
import { SharedSessions, type SharedSession } from './shared.js';

const ORIGIN = 'https://zz-isolation.invalid';

let proxy: ClosedLaunchProxy;
let groups: OwnedProcessGroups;
let pool: BrowserPool;
let sessions: SharedSessions;

beforeAll(async () => {
  if (process.getuid?.() === 0) throw new Error('tests Chromium : lance-les sous un utilisateur non root (le bac à sable de Chromium refuse root, 03 § 7).');
  proxy = await startClosedLaunchProxy();
  groups = new OwnedProcessGroups();
  pool = new BrowserPool({
    slotsTotal: 8,
    warmBrowsers: 1,
    launch: playwrightLauncher({ launchProxyUrl: proxy.url, groups }),
    constants: { ...PROVISIONAL_CAPACITY, contextsPerBrowser: 4 },
    sweep: () => groups.sweep(),
  });
  await pool.start();
  sessions = new SharedSessions({ pool });
});

afterAll(async () => {
  await pool?.close();
  await proxy?.close();
});

/** Page de la session sur l'origine de test, servie sans réseau ; `setCookie` : cookie posé par la réponse HTTP. */
async function openPage(session: SharedSession, setCookie?: string) {
  await session.context.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: setCookie === undefined ? {} : { 'set-cookie': `${setCookie}; Path=/; Secure` },
      body: `<!doctype html><title>zz</title><script>window.__headers = ${JSON.stringify(route.request().headers())};</script>`,
    }),
  );
  const page = await session.context.newPage();
  await page.goto(`${ORIGIN}/`);
  return page;
}

describe('sessions shared sur de vrais Chromium', () => {
  test('shared_context_options : chaque option appliquée est relue par page.evaluate (1.3)', async () => {
    const session = await sessions.create({
      sessionId: 'opts',
      tenantId: 'A',
      options: {
        viewport: { width: 1024, height: 600 },
        locale: 'fr-FR',
        timezoneId: 'Europe/Paris',
        userAgent: 'ZZ-Test-Agent/1.0',
        extraHTTPHeaders: { 'X-ZZ-Test': 'oui' },
        geolocation: { latitude: 48.85, longitude: 2.35, accuracy: 10 },
        colorScheme: 'dark',
      },
    });
    try {
      const page = await openPage(session);
      const seen = await page.evaluate(async () => {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5_000 }));
        const headers = (window as unknown as { __headers: Record<string, string> }).__headers;
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          language: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          userAgent: navigator.userAgent,
          userAgentHeader: headers['user-agent'],
          extraHeader: headers['x-zz-test'],
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          dark: matchMedia('(prefers-color-scheme: dark)').matches,
        };
      });
      expect(seen).toEqual({
        width: 1024,
        height: 600,
        language: 'fr-FR',
        timeZone: 'Europe/Paris',
        userAgent: 'ZZ-Test-Agent/1.0',
        userAgentHeader: 'ZZ-Test-Agent/1.0',
        extraHeader: 'oui',
        latitude: 48.85,
        longitude: 2.35,
        accuracy: 10,
        dark: true,
      });
      const accept = await session.context.newPage().then(async (p) => {
        const download = p.waitForEvent('download', { timeout: 2_000 }).then(
          () => 'download',
          () => 'none',
        );
        await p.setContent('<a id="d" href="data:text/plain,zz" download="zz.txt">d</a>');
        await p.click('#d');
        return download;
      });
      // acceptDownloads non demandé : refusé par défaut (04 § 3).
      expect(accept).toBe('none');
    } finally {
      await session.release();
    }

    const defaults = await sessions.create({ sessionId: 'defaults', tenantId: 'A', options: {} });
    try {
      const page = await openPage(defaults);
      expect(
        await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          language: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          light: matchMedia('(prefers-color-scheme: light)').matches,
        })),
      ).toEqual({ width: 1280, height: 720, language: 'en-US', timeZone: 'UTC', light: true });
    } finally {
      await defaults.release();
    }
  });

  test('assert_session_isolation (BINV1, shared) : cookie, localStorage et IndexedDB de A absents des autres sessions, même client ou non', async () => {
    const state = (page: Awaited<ReturnType<typeof openPage>>) =>
      page.evaluate(async () => ({
        cookie: document.cookie,
        storage: Object.keys(localStorage),
        databases: (await indexedDB.databases()).map((d) => d.name),
      }));
    const plant = (page: Awaited<ReturnType<typeof openPage>>, mark: string) =>
      page.evaluate(async (m) => {
        document.cookie = `js_${m}=1; path=/; Secure`;
        localStorage.setItem(`ls_${m}`, m);
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(`db_${m}`, 1);
          open.onupgradeneeded = () => open.result.createObjectStore('s');
          open.onsuccess = () => {
            open.result.close();
            resolve();
          };
          open.onerror = () => reject(open.error);
        });
      }, mark);

    // Les 4 cas de la recette (étape 8) : même client en parallèle, même client ensuite, autre client en parallèle, ensuite.
    const a1 = await sessions.create({ sessionId: 'a1', tenantId: 'A', options: {} });
    const pageA1 = await openPage(a1, 'http_a1=1');
    await plant(pageA1, 'a1');
    expect(await state(pageA1)).toEqual({ cookie: 'http_a1=1; js_a1=1', storage: ['ls_a1'], databases: ['db_a1'] });

    const a2 = await sessions.create({ sessionId: 'a2', tenantId: 'A', options: {} });
    const b1 = await sessions.create({ sessionId: 'b1', tenantId: 'B', options: {} });
    expect(a2.browserId).toBe(a1.browserId);
    expect(b1.browserId).not.toBe(a1.browserId);
    for (const other of [a2, b1]) {
      const page = await openPage(other);
      expect(await state(page)).toEqual({ cookie: '', storage: [], databases: [] });
      expect(await other.context.cookies()).toEqual([]);
      expect(other.context.pages()).toHaveLength(1);
    }
    await a1.release();
    await a2.release();
    await b1.release();
    expect(a1.context.pages()).toEqual([]);

    const a3 = await sessions.create({ sessionId: 'a3', tenantId: 'A', options: {} });
    const b2 = await sessions.create({ sessionId: 'b2', tenantId: 'B', options: {} });
    for (const later of [a3, b2]) expect(await state(await openPage(later))).toEqual({ cookie: '', storage: [], databases: [] });
    await a3.release();
    await b2.release();

    // Sessions alternées entre deux clients : chaque session voit un état vierge, aucun Chromium ne sert les deux clients.
    const browsersOf = { A: new Set<string>(), B: new Set<string>() };
    for (let i = 0; i < 30; i += 1) {
      const tenantId = i % 2 === 0 ? 'A' : 'B';
      const session = await sessions.create({ sessionId: `alt${i}`, tenantId, options: {} });
      browsersOf[tenantId].add(session.browserId);
      const page = await openPage(session, `http_alt${i}=1`);
      expect(await state(page)).toEqual({ cookie: `http_alt${i}=1`, storage: [], databases: [] });
      await plant(page, `alt${i}`);
      await session.release();
    }
    expect([...browsersOf.A].filter((id) => browsersOf.B.has(id))).toEqual([]);
    expect(proxy.refused()).toBe(0);
  });
});
