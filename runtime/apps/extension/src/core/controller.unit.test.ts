// SPDX-License-Identifier: AGPL-3.0-only
// Noyau de l'extension (07 § 1-2) avec des API Chrome simulées : consentement avant toute lecture de cookie
// (assert_consent_before_capture), mode tunnel sans cookie transmis (assert_no_cookie_in_tunnel_mode), appairage,
// révocation. Le parcours dans Chromium réel est dans e2e/extension.e2e.ts.
import { describe, expect, test } from 'vitest';
import { ExtensionController, ExtensionError, type BrowserCookie, type Deps } from './controller.ts';

const ORIGIN = 'https://runtime.zz-test.example';
const SHOP = 'zz-test-shop.example';

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown };

function harness(opts: { granted?: string[]; jar?: BrowserCookie[]; statusFor?: (c: Call) => number } = {}) {
  const store = new Map<string, unknown>();
  const granted = new Set(opts.granted ?? []);
  const calls: Call[] = [];
  const events: string[] = [];
  const reads: string[] = [];
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
      getAll: async ({ url }) => {
        reads.push(url);
        events.push('cookies.getAll');
        return jar;
      },
    },
    fetch: async (url, init) => {
      const call: Call = { method: init.method, url, headers: init.headers, ...(init.body ? { body: JSON.parse(init.body) } : {}) };
      calls.push(call);
      const status = opts.statusFor?.(call) ?? defaultStatus(call);
      return {
        status,
        json: async () =>
          call.url.endsWith('/api/extension/pair')
            ? { token: 'sy_ext_zz_test_token', email: 'zz_test_a@example.test', deviceLabel: null, expiresAt: '2027-01-01T00:00:00.000Z' }
            : call.url.endsWith('/api/extension/session')
              ? { email: 'zz_test_a@example.test', deviceLabel: null, sites: [] }
              : {},
      };
    },
    randomId: () => 'zz_test_device_0001',
  };
  return { controller: new ExtensionController(deps), store, granted, calls, events, reads };
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
    expect(put.headers.authorization).toBe('Bearer sy_ext_zz_test_token');
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

  test('ExtensionError porte un code stable', () => {
    expect(new ExtensionError('consent_required', 'x').code).toBe('consent_required');
  });
});
