// SPDX-License-Identifier: AGPL-3.0-only
// Noyau de l'extension (07 § 1-2) avec des API Chrome simulées : consentement avant toute lecture de cookie
// (assert_consent_before_capture), mode tunnel sans cookie transmis (assert_no_cookie_in_tunnel_mode), appairage,
// révocation. Le parcours dans Chromium réel est dans e2e/extension.e2e.ts.
import { describe, expect, test } from 'vitest';
import { ExtensionController, ExtensionError, type BrowserCookie, type Deps } from './controller.ts';

const ORIGIN = 'https://runtime.zz-test.example';
const SHOP = 'zz-test-shop.example';

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown };

type RemoteSite = { domain: string; serverUseAllowed: boolean; hasServerCookies: boolean; consentedAt: string };

/** Hôte d'un cookie couvert par `host` (même règle que Chrome pour `getAll({ url })` : hôte ou domaine parent). */
const coversHost = (cookieDomain: string, host: string) => {
  const d = cookieDomain.replace(/^\./, '');
  return host === d || host.endsWith(`.${d}`);
};

function harness(
  opts: {
    granted?: string[];
    jar?: BrowserCookie[];
    statusFor?: (c: Call) => number;
    /** Domaines connectés tels que l'instance les connaît ; par défaut, l'instance suit les PUT/DELETE reçus. */
    remote?: RemoteSite[];
    fetchError?: (c: Call) => boolean;
  } = {},
) {
  const store = new Map<string, unknown>();
  const granted = new Set(opts.granted ?? []);
  const calls: Call[] = [];
  const events: string[] = [];
  const reads: string[] = [];
  const remote: RemoteSite[] = opts.remote ?? [];
  const jar = opts.jar ?? [{ name: 'sid', value: 'zz_test_cookie_value', domain: SHOP, path: '/', secure: true, httpOnly: true, sameSite: 'lax' }];
  const deps: Deps = {
    storage: {
      get: async (k) => structuredClone(store.get(k)),
      set: async (k, v) => {
        events.push(`set:${k}`);
        store.set(k, structuredClone(v));
      },
      remove: async (k) => {
        store.delete(k);
      },
    },
    permissions: {
      contains: async (origins) => origins.every((o) => granted.has(o)),
      remove: async (origins) => {
        for (const o of origins) granted.delete(o);
        events.push(`remove:${origins.join(',')}`);
        return true;
      },
    },
    cookies: {
      getAll: async (details) => {
        reads.push('url' in details ? details.url : `domain:${details.domain}`);
        events.push('cookies.getAll');
        if ('url' in details) {
          // Chrome : cookies de l'hôte et de ses domaines parents dont le chemin couvre l'URL (ici « / »).
          const host = new URL(details.url).hostname;
          return jar.filter((c) => coversHost(c.domain, host) && c.path === '/');
        }
        // Chrome : cookies du domaine et de ses sous-domaines, tous chemins.
        return jar.filter((c) => {
          const d = c.domain.replace(/^\./, '');
          return d === details.domain || d.endsWith(`.${details.domain}`);
        });
      },
    },
    fetch: async (url, init) => {
      const call: Call = { method: init.method, url, headers: init.headers, ...(init.body ? { body: JSON.parse(init.body) } : {}) };
      calls.push(call);
      if (opts.fetchError?.(call)) throw new TypeError('Failed to fetch');
      const status = opts.statusFor?.(call) ?? defaultStatus(call);
      const origin = new URL(url).origin;
      const site = /\/api\/extension\/sites\/([^/]+)$/.exec(new URL(url).pathname)?.[1];
      if (opts.remote === undefined && site && status < 300) {
        const domain = decodeURIComponent(site);
        const i = remote.findIndex((s) => s.domain === domain);
        if (i >= 0) remote.splice(i, 1);
        if (call.method === 'PUT') {
          const server = (call.body as { serverUseAllowed: boolean }).serverUseAllowed;
          remote.push({ domain, serverUseAllowed: server, hasServerCookies: false, consentedAt: NOW });
        }
      }
      return {
        status,
        json: async () =>
          call.url.endsWith('/api/extension/pair')
            ? { token: `sy_ext_zz_test_token_${origin === ORIGIN ? 'a' : 'b'}`, email: 'zz_test_a@example.test', deviceLabel: null, expiresAt: '2027-01-01T00:00:00.000Z' }
            : call.url.endsWith('/api/extension/session')
              ? { email: 'zz_test_a@example.test', deviceLabel: null, sites: structuredClone(remote) }
              : {},
      };
    },
    randomId: () => 'zz_test_device_0001',
  };
  return { controller: new ExtensionController(deps), store, granted, calls, events, reads, remote };
}

function defaultStatus(call: Call): number {
  if (call.url.endsWith('/api/extension/pair')) return 201;
  if (call.method === 'PUT' && call.url.endsWith('/cookies')) return 204;
  if (call.method === 'PUT') return 201;
  if (call.method === 'DELETE') return 204;
  return 200;
}

const patterns = (d: string) => [`https://${d}/*`, `http://${d}/*`];
const NOW = '2026-10-01T00:00:00.000Z';

async function paired(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts);
  await h.controller.pair({ instanceUrl: ORIGIN, code: 'ABCDE-FGHJK', deviceLabel: null });
  return h;
}

describe('appairage (07 § 1)', () => {
  test('HTTPS obligatoire ; HTTP accepté pour une instance locale de développement seulement', async () => {
    const h = harness();
    await expect(h.controller.pair({ instanceUrl: 'http://runtime.zz-test.example', code: 'ABCDE-FGHJK', deviceLabel: null })).rejects.toMatchObject({ code: 'https_required' });
    await expect(h.controller.pair({ instanceUrl: 'ftp://runtime.zz-test.example', code: 'ABCDE-FGHJK', deviceLabel: null })).rejects.toMatchObject({ code: 'invalid_instance' });
    expect(h.calls).toEqual([]);
    await h.controller.pair({ instanceUrl: 'http://127.0.0.1:3000/', code: 'ABCDE-FGHJK', deviceLabel: null });
    expect(h.calls[0]!.url).toBe('http://127.0.0.1:3000/api/extension/pair');
  });

  test('code refusé → aucune donnée gardée ; identifiant d’appareil stable (un jeton par appareil, plusieurs appareils par compte)', async () => {
    const h = harness({ statusFor: (c) => (c.url.endsWith('/pair') ? 400 : 200) });
    await expect(h.controller.pair({ instanceUrl: ORIGIN, code: 'ZZZZZ-ZZZZZ', deviceLabel: null })).rejects.toMatchObject({ code: 'invalid_pairing_code' });
    expect(h.store.get('pairing')).toBeUndefined();
    const ok = await paired();
    await ok.controller.pair({ instanceUrl: ORIGIN, code: 'ABCDE-FGHJ1', deviceLabel: 'zz_test' });
    expect(ok.calls.map((c) => (c.body as { deviceId: string }).deviceId)).toEqual(['zz_test_device_0001', 'zz_test_device_0001']);
    expect(await ok.controller.status()).toMatchObject({ paired: true, email: 'zz_test_a@example.test', origin: ORIGIN });
  });

  test('jeton révoqué ou expiré (401) : appairage, consentements et permissions d’hôte oubliés', async () => {
    let revoked = false;
    const h = await paired({ granted: patterns(SHOP), statusFor: (c) => (revoked ? 401 : defaultStatus(c)) });
    await h.controller.connectSite({ domain: SHOP, mode: 'tunnel', now: NOW });
    revoked = true;
    await expect(h.controller.status()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(h.store.get('pairing')).toBeUndefined();
    expect(h.store.get('consents')).toBeUndefined();
    expect([...h.granted]).toEqual([]);
    expect(await h.controller.status()).toEqual({ paired: false });
  });
});

describe('assert_consent_before_capture : aucune lecture de cookie avant le clic de consentement', () => {
  test('sans consentement : refus et 0 lecture, même avec la permission d’hôte accordée', async () => {
    const h = await paired({ granted: patterns(SHOP) });
    await expect(h.controller.capture(SHOP)).rejects.toMatchObject({ code: 'consent_required' });
    expect(await h.controller.resyncAll()).toBe(0);
    expect(h.reads).toEqual([]);
    expect(h.controller.cookieReads).toBe(0);
    expect(h.calls.filter((c) => c.url.includes('/cookies'))).toEqual([]);
  });

  test('consentement donné mais permission d’hôte refusée : rien n’est lu ni enregistré', async () => {
    const h = await paired();
    await expect(h.controller.connectSite({ domain: SHOP, mode: 'server', now: NOW })).rejects.toMatchObject({ code: 'permission_required' });
    expect(h.reads).toEqual([]);
    expect(h.store.get('consents')).toBeUndefined();
  });

  test('usage serveur : consentement enregistré AVANT la première lecture, cookies envoyés à l’instance appairée seulement', async () => {
    const h = await paired({ granted: patterns(SHOP) });
    const site = await h.controller.connectSite({ domain: SHOP, mode: 'server', now: NOW });
    expect(site).toMatchObject({ domain: SHOP, mode: 'server', recipient: ORIGIN, grantedAt: NOW, serverHasCookies: true });
    expect(h.events.indexOf('set:consents')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('set:consents')).toBeLessThan(h.events.indexOf('cookies.getAll'));
    const put = h.calls.find((c) => c.url.endsWith('/cookies'))!;
    expect(put.url).toBe(`${ORIGIN}/api/extension/sites/${SHOP}/cookies`);
    expect(put.headers.authorization).toBe('Bearer sy_ext_zz_test_token_a');
    expect(put.body).toEqual({ cookies: [{ name: 'sid', value: 'zz_test_cookie_value', domain: SHOP, path: '/', secure: true, httpOnly: true, sameSite: 'lax' }] });
    // Aucun champ ne désigne un propriétaire : l'instance le déduit du jeton (INV5).
    expect(JSON.stringify(h.calls.map((c) => c.body))).not.toMatch(/owner|user_?id/i);
  });

  test('assert_no_cookie_in_tunnel_mode : mode tunnel (défaut) → 0 lecture, 0 cookie transmis, destinataire « aucun »', async () => {
    const h = await paired({ granted: patterns(SHOP) });
    const site = await h.controller.connectSite({ domain: SHOP, mode: 'tunnel', now: NOW });
    expect(site).toMatchObject({ mode: 'tunnel', recipient: null, serverHasCookies: false });
    expect(h.calls.find((c) => c.method === 'PUT')!.body).toEqual({ serverUseAllowed: false });
    await expect(h.controller.capture(SHOP)).rejects.toMatchObject({ code: 'consent_required' });
    expect(await h.controller.resyncAll()).toBe(0);
    expect(h.reads).toEqual([]);
    expect(h.calls.filter((c) => c.url.endsWith('/cookies'))).toEqual([]);
  });

  test('domaine privé ou interne refusé avant toute requête (INV10)', async () => {
    const h = await paired({ granted: [...patterns('localhost'), ...patterns('10.0.0.1')] });
    for (const domain of ['localhost', '10.0.0.1', '169.254.169.254', 'nas.local', 'metadata.google.internal']) {
      await expect(h.controller.connectSite({ domain, mode: 'server', now: NOW })).rejects.toMatchObject({ code: 'domain_not_allowed' });
    }
    expect(h.calls.filter((c) => c.method !== 'POST')).toEqual([]);
    expect(h.reads).toEqual([]);
  });
});

describe('révocation (07 § 2)', () => {
  test('« Déconnecter ce site » : DELETE sur l’instance, consentement et permission d’hôte retirés, plus aucune lecture', async () => {
    const h = await paired({ granted: patterns(SHOP) });
    await h.controller.connectSite({ domain: SHOP, mode: 'server', now: NOW });
    const readsBefore = h.reads.length;
    await h.controller.disconnectSite(SHOP);
    expect(h.calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${ORIGIN}/api/extension/sites/${SHOP}` });
    expect(h.store.get('consents')).toEqual({});
    expect([...h.granted]).toEqual([]);
    expect(await h.controller.resyncAll()).toBe(0);
    expect(h.reads.length).toBe(readsBefore);
  });

  test('déconnexion de l’instance : jeton révoqué côté serveur, tout est oublié localement', async () => {
    const h = await paired({ granted: patterns(SHOP) });
    await h.controller.connectSite({ domain: SHOP, mode: 'tunnel', now: NOW });
    await h.controller.unpair();
    expect(h.calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${ORIGIN}/api/extension/session` });
    expect(await h.controller.status()).toEqual({ paired: false });
    expect([...h.granted]).toEqual([]);
  });

  test('assert_revocation_local_first : instance coupée, « Sign out » efface tout ici d’abord, l’échec distant est signalé, 0 lecture au retour', async () => {
    let down = false;
    const h = await paired({ granted: [...patterns(SHOP), instance(ORIGIN)], fetchError: () => down });
    await h.controller.connectSite({ domain: SHOP, mode: 'server', now: NOW });
    const readsBefore = h.reads.length;
    down = true;
    const result = await h.controller.unpair();
    expect(result).toMatchObject({ remoteRevoked: false, warning: expect.stringMatching(/could not be reached/i) });
    expect(h.store.get('pairing')).toBeUndefined();
    expect(h.store.get('consents')).toBeUndefined();
    expect([...h.granted]).toEqual([]);
    expect(await h.controller.status()).toEqual({ paired: false });
    down = false; // l'instance revient
    const callsBefore = h.calls.length;
    expect(await h.controller.resyncAll()).toBe(0);
    expect(h.reads.length).toBe(readsBefore);
    expect(h.calls.length).toBe(callsBefore);
    // Une réponse d'erreur (5xx) est signalée de même ; un jeton déjà refusé (401) vaut révocation.
    const h5 = await paired({ statusFor: (c) => (c.method === 'DELETE' ? 503 : defaultStatus(c)) });
    expect(await h5.controller.unpair()).toMatchObject({ remoteRevoked: false, warning: expect.stringContaining('503') });
    expect(h5.store.get('pairing')).toBeUndefined();
    const h401 = await paired({ statusFor: (c) => (c.method === 'DELETE' ? 401 : defaultStatus(c)) });
    expect(await h401.controller.unpair()).toEqual({ remoteRevoked: true });
    expect(await h401.controller.status()).toEqual({ paired: false });
  });

  test('assert_revocation_local_first : instance coupée, « Disconnect » retire consentement et permission d’abord, 0 lecture au retour', async () => {
    let down = false;
    const h = await paired({ granted: patterns(SHOP), fetchError: () => down });
    await h.controller.connectSite({ domain: SHOP, mode: 'server', now: NOW });
    const readsBefore = h.reads.length;
    const putsBefore = h.calls.filter((c) => c.url.endsWith('/cookies')).length;
    down = true;
    const result = await h.controller.disconnectSite(SHOP);
    expect(result).toMatchObject({ remoteRevoked: false, warning: expect.stringMatching(/could not be reached/i) });
    expect(h.store.get('consents')).toEqual({});
    expect([...h.granted]).toEqual([]);
    expect(h.store.get('pairing')).toBeDefined(); // l'appareil reste appairé : seul le site est retiré
    down = false; // l'instance revient, elle connaît encore le domaine
    expect(await h.controller.resyncAll()).toBe(0);
    expect(h.reads.length).toBe(readsBefore);
    expect(h.calls.filter((c) => c.url.endsWith('/cookies')).length).toBe(putsBefore);
    // Le domaine reste visible « connecté ailleurs » et déconnectable d'ici, sans aucune lecture.
    expect(await h.controller.status()).toMatchObject({ paired: true, sites: [{ domain: SHOP, onThisBrowser: false }] });
    expect(await h.controller.disconnectSite(SHOP)).toEqual({ remoteRevoked: true });
    expect(h.reads.length).toBe(readsBefore);
    const h5 = await paired({ granted: patterns(SHOP), statusFor: (c) => (c.method === 'DELETE' ? 500 : defaultStatus(c)) });
    await h5.controller.connectSite({ domain: SHOP, mode: 'tunnel', now: NOW });
    expect(await h5.controller.disconnectSite(SHOP)).toMatchObject({ remoteRevoked: false, warning: expect.stringContaining('500') });
    expect(h5.store.get('consents')).toEqual({});
    expect([...h5.granted]).toEqual([]);
  });

  test('ExtensionError porte un code stable', () => {
    expect(new ExtensionError('consent_required', 'x').code).toBe('consent_required');
  });
});

const ORIGIN_B = 'https://other-instance.zz-test.example';
const instance = (origin: string) => `${new URL(origin).protocol}//${new URL(origin).hostname}/*`;

describe('domaines connectés : la liste de l’instance fait foi (07 § 1.4)', () => {
  test('« Disconnect » depuis la console : consentement et permission retirés, 0 lecture de cookie au resync suivant', async () => {
    const h = await paired({ granted: patterns(SHOP) });
    await h.controller.connectSite({ domain: SHOP, mode: 'server', now: NOW });
    const readsBefore = h.reads.length;
    const putsBefore = h.calls.filter((c) => c.url.endsWith('/cookies')).length;
    // DELETE /api/sites/:id depuis la console : l'instance ne connaît plus le domaine.
    h.remote.splice(0, h.remote.length);
    expect(await h.controller.resyncAll()).toBe(0);
    expect(h.reads.length).toBe(readsBefore);
    expect(h.calls.filter((c) => c.url.endsWith('/cookies')).length).toBe(putsBefore);
    expect(h.store.get('consents')).toEqual({});
    expect([...h.granted]).toEqual([]);
    const status = await h.controller.status();
    expect(status).toMatchObject({ paired: true, sites: [] });
  });

  test('status() rapproche aussi : un domaine retiré par la console disparaît et sa permission est rendue', async () => {
    const h = await paired({ granted: patterns(SHOP) });
    await h.controller.connectSite({ domain: SHOP, mode: 'tunnel', now: NOW });
    h.remote.splice(0, h.remote.length);
    expect(await h.controller.status()).toMatchObject({ paired: true, sites: [] });
    expect(h.store.get('consents')).toEqual({});
    expect([...h.granted]).toEqual([]);
  });

  test('domaines connectés ailleurs (autre appareil, avant un nouvel appairage) : affichés et déconnectables, jamais capturés ici', async () => {
    const remote: RemoteSite[] = [{ domain: SHOP, serverUseAllowed: true, hasServerCookies: true, consentedAt: NOW }];
    const h = await paired({ granted: patterns(SHOP), remote });
    const status = await h.controller.status();
    expect(status).toMatchObject({ paired: true, sites: [{ domain: SHOP, mode: 'server', serverHasCookies: true, onThisBrowser: false }] });
    expect(await h.controller.resyncAll()).toBe(0);
    await expect(h.controller.capture(SHOP)).rejects.toMatchObject({ code: 'consent_required' });
    expect(h.reads).toEqual([]);
    await h.controller.disconnectSite(SHOP);
    expect(h.calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${ORIGIN}/api/extension/sites/${SHOP}` });
  });

  test('usage serveur repassé en tunnel sur l’instance : le consentement local suit, aucune lecture', async () => {
    const h = await paired({ granted: patterns(SHOP) });
    await h.controller.connectSite({ domain: SHOP, mode: 'server', now: NOW });
    const readsBefore = h.reads.length;
    h.remote[0]!.serverUseAllowed = false;
    expect(await h.controller.resyncAll()).toBe(0);
    expect(h.reads.length).toBe(readsBefore);
    expect(h.store.get('consents')).toMatchObject({ [SHOP]: { mode: 'tunnel', recipient: null } });
    expect([...h.granted].sort()).toEqual(patterns(SHOP).sort());
  });

  test('instance injoignable ou en erreur : resync sans aucune lecture ; status reste appairé, avec l’erreur', async () => {
    let down = false;
    const h = await paired({ granted: patterns(SHOP), fetchError: () => down });
    await h.controller.connectSite({ domain: SHOP, mode: 'server', now: NOW });
    const readsBefore = h.reads.length;
    down = true;
    expect(await h.controller.resyncAll()).toBe(0);
    expect(h.reads.length).toBe(readsBefore);
    expect(await h.controller.status()).toMatchObject({ paired: true, origin: ORIGIN, email: 'zz_test_a@example.test', instanceError: expect.any(String), sites: [{ domain: SHOP, onThisBrowser: true }] });
    const h5 = await paired({ statusFor: (c) => (c.url.endsWith('/session') ? 503 : defaultStatus(c)) });
    expect(await h5.controller.status()).toMatchObject({ paired: true, instanceError: expect.stringContaining('503') });
    expect(h5.store.get('pairing')).toBeDefined();
  });
});

describe('destinataire des cookies = instance appairée (07 § 2, assert_consent_before_capture)', () => {
  test('ré-appairage vers une autre origine → 0 lecture, 0 cookie vers B ; consentements et permissions effacés', async () => {
    // B (malveillante) prétend que le domaine est connecté en usage serveur.
    const remote: RemoteSite[] = [{ domain: SHOP, serverUseAllowed: true, hasServerCookies: false, consentedAt: NOW }];
    const h = await paired({ granted: [...patterns(SHOP), instance(ORIGIN), instance(ORIGIN_B)], remote });
    await h.controller.connectSite({ domain: SHOP, mode: 'server', now: NOW });
    const readsBefore = h.reads.length;
    await h.controller.pair({ instanceUrl: ORIGIN_B, code: 'ABCDE-FGHJK', deviceLabel: null });
    expect(h.store.get('consents')).toBeUndefined();
    expect([...h.granted]).toEqual([instance(ORIGIN_B)]);
    expect(await h.controller.resyncAll()).toBe(0);
    await expect(h.controller.capture(SHOP)).rejects.toMatchObject({ code: 'consent_required' });
    expect(h.reads.length).toBe(readsBefore);
    const toB = h.calls.filter((c) => c.url.startsWith(ORIGIN_B));
    expect(toB.filter((c) => c.url.endsWith('/cookies'))).toEqual([]);
    expect(JSON.stringify(toB)).not.toContain('zz_test_cookie_value');
  });

  test('consentement dont le destinataire n’est pas l’instance appairée : refus sans aucune lecture', async () => {
    const remote: RemoteSite[] = [{ domain: SHOP, serverUseAllowed: true, hasServerCookies: false, consentedAt: NOW }];
    const h = await paired({ granted: patterns(SHOP), remote });
    h.store.set('consents', { [SHOP]: { domain: SHOP, mode: 'server', recipient: ORIGIN_B, grantedAt: NOW } });
    await expect(h.controller.capture(SHOP)).rejects.toMatchObject({ code: 'consent_required' });
    expect(await h.controller.resyncAll()).toBe(0);
    expect(h.reads).toEqual([]);
    expect(h.calls.filter((c) => c.url.endsWith('/cookies'))).toEqual([]);
  });

  test('oubli de l’appairage (401, déconnexion) : la permission d’hôte de l’instance est aussi rendue', async () => {
    const h = await paired({ granted: [...patterns(SHOP), instance(ORIGIN)] });
    await h.controller.connectSite({ domain: SHOP, mode: 'tunnel', now: NOW });
    await h.controller.unpair();
    expect([...h.granted]).toEqual([]);
  });
});

describe('capture : tous les cookies de session du domaine', () => {
  test('cookies de chemin ≠ « / » et du domaine parent capturés ; cookies d’un sous-domaine écartés', async () => {
    const base = { secure: true, httpOnly: true } as const;
    const site = `www.${SHOP}`;
    const jar: BrowserCookie[] = [
      { ...base, name: 'sid', value: 'zz_test_root', domain: site, path: '/' },
      { ...base, name: 'app_sid', value: 'zz_test_app', domain: site, path: '/app' },
      { ...base, name: 'parent', value: 'zz_test_parent', domain: `.${SHOP}`, path: '/' },
      { ...base, name: 'sub', value: 'zz_test_sub', domain: `api.${site}`, path: '/' },
      { ...base, name: 'tld', value: 'zz_test_tld', domain: '.example', path: '/' },
    ];
    const h = await paired({ granted: patterns(site), jar });
    await h.controller.connectSite({ domain: site, mode: 'server', now: NOW });
    const put = h.calls.find((c) => c.url.endsWith('/cookies'))!;
    const names = (put.body as { cookies: { name: string }[] }).cookies.map((c) => c.name).sort();
    expect(names).toEqual(['app_sid', 'parent', 'sid']);
  });
});
