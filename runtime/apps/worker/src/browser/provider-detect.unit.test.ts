// SPDX-License-Identifier: AGPL-3.0-only
// Détection du fournisseur (tâche 4.2 ; cdc/sym-browser 04g §2 et §8, G1 à G3) : `provider_detection` et
// `worker_starts_without_browser`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserProvider } from '@sym/contracts/browser';
import { describe, expect, it, vi } from 'vitest';
import { detectProvider, normalizeBrowserUrl, type DetectDeps } from './provider-detect.js';
import type { SymBrowserLike } from './provider-sym-browser.js';

const VERSION = { product: 'sym-browser', api: '1', contract: '1', playwright: '1.63.0', chromium: '153.0.8010.12', platform: 'linux', minSdk: '1.0.0' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const local = { kind: 'local' } as unknown as BrowserProvider;

function deps(over: Partial<DetectDeps> = {}): DetectDeps {
  return { createLocal: () => local, playwrightVersion: '1.63.0', sleep: () => Promise.resolve(), ...over };
}
const env = { BROWSER_API_KEY: 'zz_key' };

describe('provider_detection', () => {
  it('normalizeBrowserUrl : http:// ajouté sans schéma (fromService de Render), schémas http, https, ws et wss gardés', () => {
    expect(normalizeBrowserUrl('sym-browser:3000').href).toBe('http://sym-browser:3000/');
    expect(normalizeBrowserUrl(' https://browser.example.com ').href).toBe('https://browser.example.com/');
    expect(normalizeBrowserUrl('wss://x.example/y?t=1').protocol).toBe('wss:');
    expect(() => normalizeBrowserUrl('')).toThrow(/BROWSER_URL/);
    expect(() => normalizeBrowserUrl('ftp://x')).toThrow(/BROWSER_URL/);
  });

  it('G1 : BROWSER_URL absente, fournisseur local, aucune requête', async () => {
    const fetchFn = vi.fn();
    const createLocal = vi.fn(() => local);
    await expect(detectProvider({}, fetchFn, deps({ createLocal }))).resolves.toBe(local);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(createLocal).toHaveBeenCalledTimes(1);
  });

  it('G2 : BROWSER_URL=sym-browser:3000, http:// ajouté, /v1/version rend sym-browser, fournisseur sym-browser', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json(VERSION));
    const provider = await detectProvider({ ...env, BROWSER_URL: 'sym-browser:3000' }, fetchFn, deps());
    expect(provider.kind).toBe('sym-browser');
    expect(String(fetchFn.mock.calls[0]![0])).toBe('http://sym-browser:3000/v1/version');
  });

  it('Playwright de majeure.mineure différente : arrêt avec les deux versions (AD2)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ ...VERSION, playwright: '1.62.2' }));
    await expect(detectProvider({ ...env, BROWSER_URL: 'http://b:3000' }, fetchFn, deps())).rejects.toThrow(/1\.63.*1\.62|1\.62.*1\.63/);
  });

  it('une adresse qui ne répond pas comme SYM Browser, ou en ws(s), exige BROWSER_ALLOW_GENERIC_CDP (nommée dans l’erreur)', async () => {
    const notSym = vi.fn().mockResolvedValue(json({ product: 'browserless' }));
    await expect(detectProvider({ ...env, BROWSER_URL: 'http://b:3000' }, notSym, deps())).rejects.toThrow(/BROWSER_ALLOW_GENERIC_CDP/);
    const notFound = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(detectProvider({ ...env, BROWSER_URL: 'http://b:3000' }, notFound, deps())).rejects.toThrow(/BROWSER_ALLOW_GENERIC_CDP/);
    const never = vi.fn();
    await expect(detectProvider({ ...env, BROWSER_URL: 'wss://b.example/x' }, never, deps())).rejects.toThrow(/BROWSER_ALLOW_GENERIC_CDP/);
    expect(never).not.toHaveBeenCalled();
  });

  it('la clé d’API vient de BROWSER_API_KEY ou de BROWSER_API_KEY_FILE ; absente, l’erreur nomme la variable ; jamais dans une erreur', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json(VERSION));
    await expect(detectProvider({ BROWSER_URL: 'http://b:3000' }, fetchFn, deps())).rejects.toThrow(/BROWSER_API_KEY/);
    const dir = mkdtempSync(join(tmpdir(), 'zz_key_'));
    try {
      writeFileSync(join(dir, 'k'), 'zz_from_file\n');
      const apiKeys: string[] = [];
      const createClient = vi.fn((o: { apiKey: string }) => (apiKeys.push(o.apiKey), {} as SymBrowserLike));
      await detectProvider({ BROWSER_URL: 'http://b:3000', BROWSER_API_KEY_FILE: join(dir, 'k') }, fetchFn, deps({ createClient }));
      expect(apiKeys).toEqual(['zz_from_file']);
      await expect(detectProvider({ BROWSER_URL: 'http://b:3000', BROWSER_API_KEY: 'a', BROWSER_API_KEY_FILE: join(dir, 'k') }, fetchFn, deps())).rejects.toThrow(/BROWSER_API_KEY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('worker_starts_without_browser', () => {
  const down = () => Promise.reject(new TypeError('fetch failed'));

  it('SYM Browser arrêté : la détection rend aussitôt un fournisseur sym-browser, sans attendre ni échouer', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const provider = await detectProvider({ ...env, BROWSER_URL: 'http://b:3000' }, down, deps({ sleep }));
    expect(provider.kind).toBe('sym-browser');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('un run navigateur attend SYM Browser (1 s puis doublement) et aboutit une fois le service démarré', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const session = { id: 's', state: 'running', type: 'shared', connectUrls: { playwright: 'ws://b:3000/v1/connect/pw', cdp: null, bidi: null } };
    const client = {
      version: () => (++calls <= 3 ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(VERSION)),
      sessions: { create: () => Promise.resolve({ ...session, release: () => Promise.resolve(session) }), release: () => Promise.resolve(session) },
      connect: () => Promise.resolve({ isConnected: () => true }),
    } as unknown as SymBrowserLike;
    const provider = await detectProvider({ ...env, BROWSER_URL: 'http://b:3000' }, down, deps({ createClient: () => client, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) }));
    const launched = await provider.launchShared();
    expect(launched.browser.isConnected()).toBe(true);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('attente bornée : SYM Browser toujours absent, erreur retryable', async () => {
    let clock = 0;
    const client = { version: () => Promise.reject(new TypeError('fetch failed')) } as unknown as SymBrowserLike;
    const provider = await detectProvider({ ...env, BROWSER_URL: 'http://b:3000' }, down, deps({ createClient: () => client, now: () => clock, sleep: (ms) => ((clock += ms), Promise.resolve()) }));
    const error = (await provider.launchShared().catch((e: unknown) => e)) as Error & { retryable?: boolean };
    expect(error.name).toBe('BrowserUnavailableError');
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/BROWSER_URL/);
  });
});
