// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur `cdp` générique (tâche 4.7 ; cdc/sym-browser 04g §3 et §8) : adaptateurs de création de session `browserbase` et
// `steel`, URL fixe avec jeton, capacités déclarées absentes, egress local réservé aux requêtes de Node.
import { createSsrfPolicy, SsrfGuard } from '@runtime/core/net';
import type { Browser } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { browserbaseAdapter, CDP_CAPABILITIES, CdpAdapterError, createCdpProvider, steelAdapter, type CdpSessionMeta } from './provider-cdp.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const META: CdpSessionMeta = { runId: 'run_1', attemptId: 'att_1', workerId: 'w1', timeoutSeconds: 600, accountProxy: false };

function fakeBrowser() {
  const send = vi.fn().mockResolvedValue({});
  const close = vi.fn().mockResolvedValue(undefined);
  const browser = { close, newBrowserCDPSession: vi.fn().mockResolvedValue({ send }), contexts: () => [] } as unknown as Browser;
  return { browser, send, close };
}

describe('adaptateur browserbase', () => {
  it('crée la session (clé en en-tête, projet, durée, métadonnées de corrélation) et rend l’URL CDP fournie', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ id: 'bb_1', connectUrl: 'wss://connect.browserbase.example/?signature=zz' }, 201));
    const adapter = browserbaseAdapter({ apiKey: 'zz_bb_key', projectId: 'proj_1', fetch: fetchFn });
    const session = await adapter.create(META);
    expect(session.cdpUrl).toBe('wss://connect.browserbase.example/?signature=zz');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.browserbase.com/v1/sessions');
    expect((init.headers as Record<string, string>)['x-bb-api-key']).toBe('zz_bb_key');
    expect(JSON.parse(init.body as string)).toEqual({ projectId: 'proj_1', timeout: 600, userMetadata: { runId: 'run_1', attemptId: 'att_1', workerId: 'w1' } });
  });

  it('proxy du compte : `proxies: true` seulement quand l’admin l’active', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ id: 'bb_1', connectUrl: 'wss://c/' }, 201));
    await browserbaseAdapter({ apiKey: 'k', fetch: fetchFn }).create({ ...META, accountProxy: true });
    expect(JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({ proxies: true });
  });

  it('release : demande de libération de la session par l’API', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ id: 'bb_1', connectUrl: 'wss://c/' }, 201)).mockResolvedValueOnce(json({}));
    const session = await browserbaseAdapter({ apiKey: 'k', projectId: 'p', fetch: fetchFn, baseUrl: 'https://bb.internal' }).create(META);
    await session.release();
    const [url, init] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://bb.internal/v1/sessions/bb_1');
    expect(JSON.parse(init.body as string)).toEqual({ projectId: 'p', status: 'REQUEST_RELEASE' });
  });

  it('browser_provider_secrets_masked : refus du fournisseur, l’erreur ne porte ni la clé ni le corps de la réponse', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{"error":"bad key zz_bb_key"}', { status: 401 }));
    const error = await browserbaseAdapter({ apiKey: 'zz_bb_key', fetch: fetchFn }).create(META).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CdpAdapterError);
    expect(String((error as Error).message)).toMatch(/401/);
    expect(String((error as Error).message)).not.toContain('zz_bb_key');
  });
});

describe('adaptateur steel', () => {
  it('crée la session (durée en ms), URL CDP = websocketUrl + clé', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ id: 'st_1', websocketUrl: 'wss://connect.steel.example?sessionId=st_1' }));
    const session = await steelAdapter({ apiKey: 'zz_steel_key', fetch: fetchFn }).create({ ...META, accountProxy: true });
    expect(session.cdpUrl).toBe('wss://connect.steel.example?sessionId=st_1&apiKey=zz_steel_key');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.steel.dev/v1/sessions');
    expect((init.headers as Record<string, string>)['steel-api-key']).toBe('zz_steel_key');
    expect(JSON.parse(init.body as string)).toEqual({ timeout: 600_000, useProxy: true });
  });

  it('release : POST /v1/sessions/{id}/release', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ id: 'st_1', websocketUrl: 'wss://c' })).mockResolvedValueOnce(json({}));
    await (await steelAdapter({ apiKey: 'k', fetch: fetchFn }).create(META)).release();
    expect(fetchFn.mock.calls[1]![0]).toBe('https://api.steel.dev/v1/sessions/st_1/release');
  });
});

describe('fournisseur cdp', () => {
  it('capacités côté navigateur toutes absentes, déclarées (04g §1)', () => {
    const provider = createCdpProvider({ mode: { kind: 'url', url: 'wss://b.example/x' }, workerId: 'w1' });
    expect(provider.kind).toBe('cdp');
    expect(provider.capabilities).toEqual(CDP_CAPABILITIES);
    expect(Object.values(provider.capabilities).every((v) => v === false)).toBe(true);
  });

  it('URL fixe avec jeton : connectOverCDP(BROWSER_URL) avec le jeton en en-tête ; kill = Browser.close puis détachement', async () => {
    const f = fakeBrowser();
    const connect = vi.fn().mockResolvedValue(f.browser);
    const provider = createCdpProvider({ mode: { kind: 'url', url: 'wss://b.example/x', token: 'zz_token' }, workerId: 'w1', connect });
    const launched = await provider.launchShared();
    expect(connect).toHaveBeenCalledWith('wss://b.example/x', { headers: { authorization: 'Bearer zz_token' } });
    await launched.kill();
    expect(f.send).toHaveBeenCalledWith('Browser.close');
    expect(f.close).toHaveBeenCalled();
  });

  it('URL fixe sans jeton : aucun en-tête', async () => {
    const f = fakeBrowser();
    const connect = vi.fn().mockResolvedValue(f.browser);
    await createCdpProvider({ mode: { kind: 'url', url: 'ws://127.0.0.1:9222/devtools/browser/x' }, workerId: 'w1', connect }).launchShared();
    expect(connect).toHaveBeenCalledWith('ws://127.0.0.1:9222/devtools/browser/x', {});
  });

  it('adaptateur : une session fournisseur par ouverture (corrélation runId et attemptId), libération par l’API puis détachement', async () => {
    const f = fakeBrowser();
    const release = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({ cdpUrl: 'wss://p/s1', release });
    const connect = vi.fn().mockResolvedValue(f.browser);
    const provider = createCdpProvider({ mode: { kind: 'adapter', adapter: { create }, timeoutSeconds: 300, accountProxy: true }, workerId: 'w1', connect });
    const launched = await provider.launchDedicated({ userAgent: 'zz', egress: { allowedHosts: ['a'] }, egressServer: null, launchArgs: [], metadata: { runId: 'r1', attemptId: 'a1' } });
    expect(create).toHaveBeenCalledWith({ runId: 'r1', attemptId: 'a1', workerId: 'w1', timeoutSeconds: 300, accountProxy: true });
    expect(launched.cdpUrl).toBe('wss://p/s1');
    await launched.kill();
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalled();
  });

  it('adaptateur : connexion refusée, la session créée est libérée', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const provider = createCdpProvider({
      mode: { kind: 'adapter', adapter: { create: vi.fn().mockResolvedValue({ cdpUrl: 'wss://p/s1', release }) }, timeoutSeconds: 60, accountProxy: false },
      workerId: 'w1',
      connect: vi.fn().mockRejectedValue(new Error('zz_connect_failed')),
    });
    await expect(provider.launchShared()).rejects.toThrow('zz_connect_failed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('openEgress : egress local pour les seules requêtes de Node (server null pour le navigateur), capacités absentes déclarées', async () => {
    const provider = createCdpProvider({ mode: { kind: 'url', url: 'wss://b.example/x' }, workerId: 'w1' });
    const egress = await provider.openEgress({ rung: { mode: 'direct' }, guard: new SsrfGuard({ policy: createSsrfPolicy() }), allowedHosts: ['a.example'] });
    try {
      expect(egress.server).toBeNull();
      expect(egress.capabilities).toEqual(CDP_CAPABILITIES);
      expect(egress.budgetExceeded()).toBe(false);
    } finally {
      await egress.close();
    }
  });
});
