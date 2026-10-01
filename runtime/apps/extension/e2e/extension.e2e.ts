// SPDX-License-Identifier: AGPL-3.0-only
// E2 (tâche 2.6, 07 § 1-2, § 8) : l'extension construite, chargée dans Chromium, contre une instance réelle.
// assert_optional_hosts, appairage multi-appareils, assert_consent_before_capture (0 lecture de cookie avant le clic,
// même permission d'hôte accordée), assert_no_cookie_in_tunnel_mode, assert_identity_pinned, révocation d'un domaine
// (0 cookie en base) et révocation de l'appareil par un admin.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { kekFor, MasterKey } from '@runtime/core';
import { siteCookiesForRun } from '@runtime/db';
import pg from 'pg';
import { EXTENSION_DIR, fakeInstance, startHarness, type Harness, type User } from './harness.ts';

/** API Chrome du service worker, vue depuis `evaluate` (typage minimal). */
type ChromeApi = {
  cookies: Record<string, (...args: unknown[]) => Promise<unknown>>;
  alarms: { create(name: string, info: { when: number }): Promise<void> };
  tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> };
  debugger: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand(target: { tabId: number }, method: string, params?: object): Promise<{ root: { nodeName: string } }>;
    getTargets(): Promise<{ tabId?: number; attached: boolean }[]>;
  };
  permissions: { getAll(): Promise<{ origins?: string[] }>; contains(p: { origins: string[] }): Promise<boolean> };
  runtime: { getManifest(): Record<string, unknown> };
};
type SpyGlobal = { chrome: ChromeApi; __zzCookieReads?: string[] };

const SHOP = 'zz-test-shop.example';
const FORUM = 'zz-test-forum.example';
const patterns = (d: string) => [`https://${d}/*`, `http://${d}/*`];

let h: Harness;
let alice: User;
let bob: User;
let popup: Page;
const consoleErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  h = await startHarness();
  alice = await h.createMember('zz_test_alice@example.test');
  bob = await h.createMember('zz_test_bob@example.test');
  // Espion sur toute lecture de cookie dans le service worker, posé avant le premier geste de l'utilisateur.
  const sw = await h.serviceWorker();
  await sw.evaluate(() => {
    const g = globalThis as unknown as SpyGlobal;
    g.__zzCookieReads = [];
    for (const method of ['getAll', 'get', 'getAllCookieStores']) {
      const original = g.chrome.cookies[method]!.bind(g.chrome.cookies);
      g.chrome.cookies[method] = (...args: unknown[]) => {
        g.__zzCookieReads!.push(`${method}:${JSON.stringify(args[0] ?? null)}`);
        return original(...args);
      };
    }
  });
});

test.afterAll(async () => {
  await h?.close();
});

/** Lectures de cookies observées ; échoue si le service worker a redémarré (espion perdu : rien ne serait prouvé). */
async function cookieReads(): Promise<string[]> {
  const sw = await h.serviceWorker();
  const reads = await sw.evaluate(() => (globalThis as unknown as SpyGlobal).__zzCookieReads ?? null);
  if (reads === null) throw new Error('service worker redémarré : espion de lecture des cookies perdu');
  return reads;
}

async function openPopup(): Promise<Page> {
  await popup?.close().catch(() => undefined);
  popup = await h.popup();
  popup.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  popup.on('pageerror', (e) => consoleErrors.push(e.message));
  return popup;
}

async function visit(domain: string): Promise<void> {
  const page = await h.context.newPage();
  await page.goto(`http://${domain}:${h.sitePort}/login`);
  await expect(page.locator('h1')).toHaveText(domain);
  await page.bringToFront();
}

async function runFor(owner: User): Promise<string> {
  const [api] = await h.sql<{ id: string }>('INSERT INTO apis (slug, owner_id, requires_session) VALUES ($1, $2, true) RETURNING id', [`zz_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, owner.id]);
  const [run] = await h.sql<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger) VALUES ($1, $2, $2, 'rest') RETURNING id", [api!.id, owner.id]);
  return run!.id;
}

async function cookiesForRun(runId: string, domain: string) {
  const client = new pg.Client({ connectionString: h.dbUrl });
  await client.connect();
  try {
    return await siteCookiesForRun(client, kekFor(MasterKey.parse(h.masterKey), 1, 'site_sessions'), { runId, domain });
  } finally {
    await client.end();
  }
}

test('assert_optional_hosts : manifeste construit et chargé sans <all_urls>, aucun hôte accordé à l’installation', async () => {
  const built = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const sw = await h.serviceWorker();
  const loaded = await sw.evaluate(() => (globalThis as unknown as SpyGlobal).chrome.runtime.getManifest());
  for (const manifest of [built, loaded]) {
    expect(manifest.manifest_version).toBe(3);
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>');
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    expect(manifest).not.toHaveProperty('content_scripts');
  }
  const granted = await sw.evaluate(() => (globalThis as unknown as SpyGlobal).chrome.permissions.getAll());
  expect(granted.origins ?? []).toEqual([]);
});

test('appairage : URL de l’instance + code à usage unique → « Connected as », plusieurs appareils pour un compte', async () => {
  const code = await h.console(alice.cookie, 'POST', '/api/extension/pairing-codes', { currentPassword: alice.password });
  expect(code.status).toBe(201);
  const page = await openPopup();
  await page.fill('#instance-url', h.publicUrl);
  await page.fill('#pairing-code', (code.data as { code: string }).code);
  await page.fill('#device-label', 'zz_test_e2e_browser');
  await h.grantHosts(['http://127.0.0.1/*']); // l'utilisateur accepte l'accès à SON instance
  await page.click('#pair');
  await expect(page.locator('#identity')).toHaveText(`Connected as ${alice.email}`);

  // Un second appareil du même utilisateur (appairé par l'API) : les deux jetons restent actifs.
  const second = await h.console(alice.cookie, 'POST', '/api/extension/pairing-codes', { currentPassword: alice.password });
  const res = await fetch(`${h.publicUrl}/api/extension/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: (second.data as { code: string }).code, deviceId: 'zz_test_e2e_second_device' }),
  });
  expect(res.status).toBe(201);
  const devices = await h.console(alice.cookie, 'GET', '/api/extension/devices');
  expect((devices.data as { items: { revokedAt: string | null }[] }).items.filter((d) => d.revokedAt === null)).toHaveLength(2);
  // Le code déjà utilisé ne sert plus.
  const replay = await fetch(`${h.publicUrl}/api/extension/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: (second.data as { code: string }).code, deviceId: 'zz_test_e2e_third_device' }),
  });
  expect(replay.status).toBe(400);
  await page.reload();
  await expect(page.locator('#identity')).toHaveText(`Connected as ${alice.email}`);
});

test('assert_consent_before_capture : aucune lecture de cookie avant le clic de consentement, même hôte accordé', async () => {
  await visit(SHOP); // le site pose ses cookies de session dans ce navigateur
  const page = await openPopup();
  await expect(page.locator('#site-domain')).toHaveText(SHOP);
  expect(await cookieReads()).toEqual([]);

  await page.click('#connect-site');
  await expect(page.locator('#consent-domain')).toHaveText(SHOP);
  await expect(page.locator('#mode-tunnel')).toBeChecked(); // tunnel par défaut
  await expect(page.locator('#recipient')).toHaveText('Nobody: cookies stay in this browser.');
  await page.check('#mode-server');
  await expect(page.locator('#recipient')).toHaveText(h.publicUrl);
  // Permission d'hôte accordée, consentement pas encore cliqué : toujours 0 lecture, 0 ligne en base.
  await h.grantHosts(patterns(SHOP));
  await page.waitForTimeout(500);
  expect(await cookieReads()).toEqual([]);
  expect(await h.sql('SELECT 1 FROM site_sessions WHERE domain = $1', [SHOP])).toEqual([]);

  await page.click('#consent-accept');
  await expect(page.locator(`#sites li[data-domain="${SHOP}"]`)).toContainText('(server)');
  const reads = await cookieReads();
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((r) => r.includes(SHOP))).toBe(true);
  const rows = await h.sql<{ owner_id: string; server_use_allowed: boolean; has: boolean }>(
    'SELECT owner_id, server_use_allowed, ciphertext IS NOT NULL AS has FROM site_sessions WHERE domain = $1',
    [SHOP],
  );
  expect(rows).toEqual([{ owner_id: alice.id, server_use_allowed: true, has: true }]);
  // Chiffré en base : la valeur du cookie n'y figure pas en clair.
  const raw = await h.sql<{ c: Buffer }>('SELECT ciphertext AS c FROM site_sessions WHERE domain = $1', [SHOP]);
  expect(raw[0]!.c.toString('latin1')).not.toContain('zz_test_shop_session');
});

test('assert_no_cookie_in_tunnel_mode : un domaine en tunnel ne transmet ni ne stocke aucun cookie', async () => {
  const before = (await cookieReads()).length;
  await visit(FORUM);
  const page = await openPopup();
  await expect(page.locator('#site-domain')).toHaveText(FORUM);
  await page.click('#connect-site');
  await h.grantHosts(patterns(FORUM));
  await page.click('#consent-accept'); // mode tunnel (défaut)
  await expect(page.locator(`#sites li[data-domain="${FORUM}"]`)).toContainText('(tunnel)');
  expect((await cookieReads()).slice(before).filter((r) => r.includes(FORUM))).toEqual([]);
  expect(await h.sql('SELECT server_use_allowed, ciphertext FROM site_sessions WHERE domain = $1', [FORUM])).toEqual([{ server_use_allowed: false, ciphertext: null }]);
  expect(await cookiesForRun(await runFor(alice), FORUM)).toEqual({ ok: false, reason: 'tunnel_only' });
});

test('assert_identity_pinned : la session capturée appartient à l’utilisateur du jeton, jamais à un autre', async () => {
  const forAlice = await cookiesForRun(await runFor(alice), SHOP);
  expect(forAlice.ok).toBe(true);
  expect(JSON.stringify(forAlice)).toContain('zz_test_shop_session');
  expect(forAlice).toMatchObject({ ownerId: alice.id });
  // Bob n'a rien connecté : action_requise, jamais la session d'Alice (pas de pool, pas de repli).
  expect(await cookiesForRun(await runFor(bob), SHOP)).toEqual({ ok: false, reason: 'auth_required' });
  // L'admin ne lit que des métadonnées (aucun jeton, aucun cookie).
  const adminView = await h.console(h.owner.cookie, 'GET', '/api/admin/tunnels');
  expect(JSON.stringify(adminView.data)).not.toMatch(/zz_test_shop_session|sy_ext_|token/);
});

test('révocation d’un domaine : « Disconnect » → 0 cookie en base pour ce domaine, permission retirée, run suivant en action_requise', async () => {
  const page = await openPopup();
  await page.locator(`#sites li[data-domain="${SHOP}"] .disconnect`).click();
  await expect(page.locator(`#sites li[data-domain="${SHOP}"]`)).toHaveCount(0);
  expect(await h.sql<{ n: number }>('SELECT count(*)::int AS n FROM site_sessions WHERE domain = $1', [SHOP])).toEqual([{ n: 0 }]);
  const sw = await h.serviceWorker();
  expect(await sw.evaluate((p) => (globalThis as unknown as SpyGlobal).chrome.permissions.contains({ origins: p }), patterns(SHOP))).toBe(false);
  expect(await cookiesForRun(await runFor(alice), SHOP)).toEqual({ ok: false, reason: 'auth_required' });
});

test('révocation de l’appareil par un admin : jeton refusé, l’extension revient à l’écran d’appairage', async () => {
  const devices = (await h.console(h.owner.cookie, 'GET', '/api/admin/tunnels')).data as { items: { id: string; ownerEmail: string; deviceLabel: string | null }[] };
  const mine = devices.items.find((d) => d.ownerEmail === alice.email && d.deviceLabel === 'zz_test_e2e_browser');
  expect(mine).toBeDefined();
  expect((await h.console(h.owner.cookie, 'DELETE', `/api/admin/tunnels/${mine!.id}`)).status).toBe(204);
  const page = await openPopup();
  await expect(page.locator('#pairing')).toBeVisible();
  await expect(page.locator('#error')).toContainText('pair again');
  const sw = await h.serviceWorker();
  expect((await sw.evaluate(() => (globalThis as unknown as SpyGlobal).chrome.permissions.getAll())).origins).not.toEqual(expect.arrayContaining(patterns(FORUM)));
  expect(consoleErrors).toEqual([]);
});

/** Déclenche la resynchronisation horaire maintenant (alarme du service worker, sans limite pour une extension décompressée). */
async function triggerResync(): Promise<void> {
  const sw = await h.serviceWorker();
  await sw.evaluate(() => (globalThis as unknown as SpyGlobal).chrome.alarms.create('scrapyomama-cookie-resync', { when: Date.now() + 50 }));
}

async function hasHosts(origins: string[]): Promise<boolean> {
  const sw = await h.serviceWorker();
  return sw.evaluate((p) => (globalThis as unknown as SpyGlobal).chrome.permissions.contains({ origins: p }), origins);
}

/** Appairage d'Alice depuis le popup, puis connexion de SHOP en usage serveur (cookies capturés). */
async function pairAliceAndConnectShop(): Promise<Page> {
  const code = await h.console(alice.cookie, 'POST', '/api/extension/pairing-codes', { currentPassword: alice.password });
  expect(code.status).toBe(201);
  let page = await openPopup();
  await page.locator('#pairing, #paired').first().waitFor();
  if (await page.locator('#pairing').isVisible()) {
    await page.fill('#instance-url', h.publicUrl);
    await page.fill('#pairing-code', (code.data as { code: string }).code);
    await page.fill('#device-label', 'zz_test_e2e_browser');
    await h.grantHosts(['http://127.0.0.1/*']);
    await page.click('#pair');
    await expect(page.locator('#identity')).toHaveText(`Connected as ${alice.email}`);
  }
  await visit(SHOP);
  page = await openPopup();
  await expect(page.locator('#site-domain')).toHaveText(SHOP);
  await page.click('#connect-site');
  await page.check('#mode-server');
  await h.grantHosts(patterns(SHOP));
  await page.click('#consent-accept');
  await expect(page.locator(`#sites li[data-domain="${SHOP}"]`)).toContainText('(server)');
  return page;
}

test('« Disconnect » depuis la console : permission d’hôte retirée, 0 lecture de cookie au resync suivant', async () => {
  await pairAliceAndConnectShop();
  expect(await hasHosts(patterns(SHOP))).toBe(true);
  const before = (await cookieReads()).length;
  const sites = (await h.console(alice.cookie, 'GET', '/api/sites')).data as { items: { id: string; domain: string }[] };
  const shop = sites.items.find((s) => s.domain === SHOP)!;
  expect((await h.console(alice.cookie, 'DELETE', `/api/sites/${shop.id}`)).status).toBe(204);

  await triggerResync();
  await expect.poll(() => hasHosts(patterns(SHOP)), { timeout: 10_000 }).toBe(false);
  expect((await cookieReads()).length).toBe(before);
  expect(await h.sql<{ n: number }>('SELECT count(*)::int AS n FROM site_sessions WHERE domain = $1', [SHOP])).toEqual([{ n: 0 }]);
  const page = await openPopup();
  await expect(page.locator('#identity')).toHaveText(`Connected as ${alice.email}`);
  await expect(page.locator(`#sites li[data-domain="${SHOP}"]`)).toHaveCount(0);
});

test('domaines connectés ailleurs : la liste de l’instance s’affiche dans l’extension, déconnectable d’ici', async () => {
  const token = await (async () => {
    const code = await h.console(alice.cookie, 'POST', '/api/extension/pairing-codes', { currentPassword: alice.password });
    const res = await fetch(`${h.publicUrl}/api/extension/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: (code.data as { code: string }).code, deviceId: 'zz_test_e2e_other_device' }),
    });
    return ((await res.json()) as { token: string }).token;
  })();
  const other = 'zz-test-elsewhere.example';
  const put = await fetch(`${h.publicUrl}/api/extension/sites/${other}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ serverUseAllowed: false }) });
  expect(put.status).toBe(201);
  const page = await openPopup();
  const item = page.locator(`#sites li[data-domain="${other}"]`);
  await expect(item).toContainText('connected from another browser');
  await item.locator('.disconnect').click();
  await expect(item).toHaveCount(0);
  expect(await h.sql<{ n: number }>('SELECT count(*)::int AS n FROM site_sessions WHERE domain = $1', [other])).toEqual([{ n: 0 }]);
});

test('ré-appairage vers une autre instance : consentements et permissions effacés, 0 lecture, 0 cookie envoyé à B', async () => {
  await pairAliceAndConnectShop();
  const before = (await cookieReads()).length;
  // B prétend que SHOP est connecté chez elle en usage serveur.
  const b = await fakeInstance([{ domain: SHOP, serverUseAllowed: true, hasServerCookies: false }]);
  try {
    // B partage l'hôte de A (127.0.0.1, autre port) : la permission d'hôte de l'instance reste accordée, celle des
    // sites est retirée. (Chromium n'accorde pas `http://localhost/*` par developerPrivate ; le retrait de la
    // permission de l'ancienne instance est couvert par les tests unitaires du noyau.)
    const page = await openPopup();
    const res = await page.evaluate(
      (instanceUrl) => (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<{ ok: boolean }> } } }).chrome.runtime.sendMessage({ type: 'pair', instanceUrl, code: 'ZZZZZ-ZZZZZ', deviceLabel: null }),
      b.origin,
    );
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    await triggerResync();
    await expect.poll(() => b.requests.filter((r) => r.method === 'GET' && r.path === '/api/extension/session').length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(500);
    expect(b.requests.filter((r) => r.path.endsWith('/cookies'))).toEqual([]);
    expect(JSON.stringify(b.requests)).not.toContain('zz_test_shop_session');
    expect((await cookieReads()).length).toBe(before);
    expect(await hasHosts(patterns(SHOP))).toBe(false);
    expect(await hasHosts(['http://127.0.0.1/*'])).toBe(true);
    const popup = await openPopup();
    await expect(popup.locator('#identity')).toHaveText('Connected as zz_test_b@instance-b.test');
    await expect(popup.locator(`#sites li[data-domain="${SHOP}"]`)).toContainText('connected from another browser');
  } finally {
    await b.close();
  }
});

test('assert_revocation_local_first : instance coupée, « Disconnect » et « Sign out » honorés ici d’abord, échec signalé, 0 lecture au retour', async () => {
  // Instance C, qui sera coupée : elle connaît SHOP en usage serveur, et continuera de le lister à son retour.
  const c = await fakeInstance([{ domain: SHOP, serverUseAllowed: true, hasServerCookies: true }]);
  const cookiePuts = () => c.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/cookies')).length;
  const sessionGets = () => c.requests.filter((r) => r.method === 'GET' && r.path === '/api/extension/session').length;
  const connectShop = async (): Promise<Page> => {
    await visit(SHOP);
    const page = await openPopup();
    await expect(page.locator('#site-domain')).toHaveText(SHOP);
    await page.click('#connect-site');
    await page.check('#mode-server');
    await h.grantHosts(patterns(SHOP));
    await page.click('#consent-accept');
    await expect(page.locator(`#sites li[data-domain="${SHOP}"]`)).toContainText('(server)');
    await expect(page.locator(`#sites li[data-domain="${SHOP}"]`)).not.toContainText('another browser');
    return page;
  };
  try {
    let page = await openPopup();
    const res = await page.evaluate(
      (instanceUrl) => (globalThis as unknown as { chrome: { runtime: { sendMessage(m: unknown): Promise<{ ok: boolean }> } } }).chrome.runtime.sendMessage({ type: 'pair', instanceUrl, code: 'ZZZZZ-ZZZZZ', deviceLabel: null }),
      c.origin,
    );
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });

    // 1. « Disconnect », instance coupée : consentement et permission retirés ici, échec distant affiché.
    page = await connectShop();
    expect(cookiePuts()).toBe(1);
    let reads = (await cookieReads()).length;
    c.setDown(true);
    await page.locator(`#sites li[data-domain="${SHOP}"] .disconnect`).click();
    await expect(page.locator('#notice')).toContainText('could not be reached');
    await expect(page.locator('#instance-error')).toBeVisible();
    await expect(page.locator(`#sites li[data-domain="${SHOP}"]`)).toHaveCount(0);
    expect(await hasHosts(patterns(SHOP))).toBe(false);
    // Retour de l'instance, qui liste encore SHOP en usage serveur : la resynchronisation la relit, sans lire un cookie.
    c.setDown(false);
    let gets = sessionGets();
    await triggerResync();
    await expect.poll(sessionGets, { timeout: 10_000 }).toBeGreaterThan(gets);
    await page.waitForTimeout(500);
    expect((await cookieReads()).length).toBe(reads);
    expect(cookiePuts()).toBe(1);
    page = await openPopup();
    await expect(page.locator(`#sites li[data-domain="${SHOP}"]`)).toContainText('connected from another browser');

    // 2. « Sign out », instance coupée : tout est oublié ici (appairage, consentements, permissions), échec affiché.
    page = await connectShop();
    expect(cookiePuts()).toBe(2);
    reads = (await cookieReads()).length;
    c.setDown(true);
    page = await openPopup();
    await expect(page.locator('#instance-error')).toBeVisible();
    await page.click('#unpair');
    await expect(page.locator('#pairing')).toBeVisible();
    await expect(page.locator('#notice')).toContainText('could not be reached');
    expect(await hasHosts(patterns(SHOP))).toBe(false);
    expect(await hasHosts(['http://127.0.0.1/*'])).toBe(false);
    // Retour de l'instance : plus aucune requête vers elle, aucune lecture de cookie.
    c.setDown(false);
    gets = c.requests.length;
    await triggerResync();
    await page.waitForTimeout(1_500);
    expect(c.requests.length).toBe(gets);
    expect((await cookieReads()).length).toBe(reads);
    page = await openPopup();
    await expect(page.locator('#pairing')).toBeVisible();
  } finally {
    await c.close();
  }
});

test('spike chrome.debugger (07 § 4) : attach sur un hôte optionnel accordé ; la session survit à l’arrêt du service worker', async () => {
  await h.grantHosts(patterns(FORUM));
  const forum = await h.context.newPage();
  await forum.goto(`http://${FORUM}:${h.sitePort}/`);
  const shop = await h.context.newPage();
  await shop.goto(`http://${SHOP}:${h.sitePort}/`);
  expect(await hasHosts(patterns(SHOP))).toBe(false);
  const sw = await h.serviceWorker();
  const first = await sw.evaluate(
    async ([f, s]) => {
      const c = (globalThis as unknown as SpyGlobal).chrome;
      const tabs = await c.tabs.query({});
      const tabF = tabs.find((t) => t.url?.includes(f!))!.id!;
      const tabS = tabs.find((t) => t.url?.includes(s!))!.id!;
      await c.debugger.attach({ tabId: tabF }, '1.3');
      const doc = (await c.debugger.sendCommand({ tabId: tabF }, 'DOM.getDocument', { depth: 1 })).root.nodeName;
      // Constat : attach ne dépend PAS de la permission d'hôte (SHOP n'est pas accordé). La garde de domaine
      // (domaines connectés seulement, 07 § 5) doit donc précéder tout attach dans l'exécuteur de la tâche 2.7.
      let withoutHost = 'refused';
      try {
        await c.debugger.attach({ tabId: tabS }, '1.3');
        withoutHost = 'attached';
        await c.debugger.detach({ tabId: tabS });
      } catch {
        /* refus : constat inverse, signalé par l'assertion */
      }
      (globalThis as unknown as { __zzBeforeStop?: boolean }).__zzBeforeStop = true;
      return { tabF, doc, withoutHost };
    },
    [FORUM, SHOP],
  );
  expect(first.doc).toBe('#document');
  expect(first.withoutHost).toBe('attached');

  // Arrêt forcé du service worker (comme l'arrêt après 30 s d'inactivité), puis réveil par le popup.
  const cdp = await h.context.newCDPSession(forum);
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string; url: string }[] };
  const target = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${h.extensionId}/`))!;
  expect((await cdp.send('Target.closeTarget', { targetId: target.targetId })).success).toBe(true);
  await openPopup();
  // Le nouveau service worker (nouveau contexte JS, sans le marqueur) voit la même session, sans nouvel attach.
  const survived = async () => {
    for (const w of h.context.serviceWorkers().filter((x) => x.url().startsWith(`chrome-extension://${h.extensionId}/`))) {
      const r = await Promise.race([
        w.evaluate(async (tabF) => {
          const g = globalThis as unknown as SpyGlobal & { __zzBeforeStop?: boolean };
          if (g.__zzBeforeStop) return null;
          const attached = (await g.chrome.debugger.getTargets()).some((t) => t.tabId === tabF && t.attached);
          const doc = (await g.chrome.debugger.sendCommand({ tabId: tabF }, 'DOM.getDocument', { depth: 1 })).root.nodeName;
          await g.chrome.debugger.detach({ tabId: tabF });
          return { attached, doc };
        }, first.tabF),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
      ]).catch(() => null);
      if (r) return r;
    }
    return null;
  };
  await expect.poll(survived, { timeout: 15_000 }).toEqual({ attached: true, doc: '#document' });
});
