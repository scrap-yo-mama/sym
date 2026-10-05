// SPDX-License-Identifier: AGPL-3.0-only
// Détection du fournisseur (tâche 4.2 ; cdc/sym-browser 04g §2 et §8, G1 à G3) : `provider_detection` et
// `worker_starts_without_browser`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretValues } from '@runtime/core';
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
    const fetchFn = vi.fn(() => Promise.resolve(json(VERSION)));
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
    const session = { id: 's', state: 'running', type: 'dedicated', connectUrls: { playwright: 'ws://b:3000/v1/connect/pw', cdp: 'ws://b:3000/v1/connect/cdp', bidi: null } };
    const client = {
      version: () => (++calls <= 3 ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(VERSION)),
      sessions: { create: () => Promise.resolve({ ...session, release: () => Promise.resolve(session) }), release: () => Promise.resolve(session) },
      connectCDP: () => Promise.resolve({ isConnected: () => true }),
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

describe('cdp_requires_explicit_opt_in', () => {
  const never = () => vi.fn();
  const optIn = { BROWSER_ALLOW_GENERIC_CDP: 'true' };

  it('G4 : wss:// sans activation, l’erreur nomme la variable et donne les capacités absentes', async () => {
    const error = await detectProvider({ BROWSER_URL: 'wss://b.example/x' }, never(), deps()).catch((e: unknown) => e);
    const message = String((error as Error).message);
    expect(message).toContain('BROWSER_ALLOW_GENERIC_CDP');
    expect(message).toMatch(/egress/i);
    expect(message).toMatch(/bac à sable/i);
  });

  it('seule la valeur `true` active : `1`, `yes`, `TRUE` restent refusées', async () => {
    for (const value of ['1', 'yes', 'TRUE', '']) {
      await expect(detectProvider({ BROWSER_URL: 'wss://b.example/x', BROWSER_ALLOW_GENERIC_CDP: value }, never(), deps()), value).rejects.toThrow(/BROWSER_ALLOW_GENERIC_CDP/);
    }
  });

  it('G5 : avec l’activation, wss:// donne le fournisseur cdp (aucune requête de détection) ; le jeton est facultatif', async () => {
    const fetchFn = vi.fn();
    const provider = await detectProvider({ ...optIn, BROWSER_URL: 'wss://b.example/x?token=zz_in_url' }, fetchFn, deps());
    expect(provider.kind).toBe('cdp');
    expect(Object.values(provider.capabilities).every((v) => v === false)).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('une adresse http qui ne répond pas comme SYM Browser : cdp avec l’activation, refus sans', async () => {
    const notSym = () => vi.fn().mockResolvedValue(json({ product: 'browserless' }));
    await expect(detectProvider({ BROWSER_URL: 'http://b:9222' }, notSym(), deps())).rejects.toThrow(/BROWSER_ALLOW_GENERIC_CDP/);
    expect((await detectProvider({ ...optIn, BROWSER_URL: 'http://b:9222' }, notSym(), deps())).kind).toBe('cdp');
  });

  it('une adresse SYM Browser reste sym-browser, même avec l’activation', async () => {
    const provider = await detectProvider({ ...optIn, ...env, BROWSER_URL: 'http://b:3000' }, vi.fn().mockResolvedValue(json(VERSION)), deps());
    expect(provider.kind).toBe('sym-browser');
  });

  it('l’activation seule, sans BROWSER_URL : fournisseur local', async () => {
    await expect(detectProvider(optIn, never(), deps())).resolves.toBe(local);
  });

  it('adaptateur : BROWSER_CDP_ADAPTER exige l’activation, une clé, un nom connu ; BROWSER_URL est alors l’API du fournisseur (aucune détection)', async () => {
    const adapterEnv = { ...optIn, BROWSER_URL: 'https://api.browserbase.com', BROWSER_CDP_ADAPTER: 'browserbase', BROWSER_API_KEY: 'zz_bb' };
    const fetchFn = vi.fn();
    expect((await detectProvider(adapterEnv, fetchFn, deps())).kind).toBe('cdp');
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(detectProvider({ ...adapterEnv, BROWSER_ALLOW_GENERIC_CDP: undefined }, fetchFn, deps())).rejects.toThrow(/BROWSER_ALLOW_GENERIC_CDP/);
    await expect(detectProvider({ ...adapterEnv, BROWSER_API_KEY: undefined }, fetchFn, deps())).rejects.toThrow(/BROWSER_API_KEY/);
    await expect(detectProvider({ ...adapterEnv, BROWSER_CDP_ADAPTER: 'browserless' }, fetchFn, deps())).rejects.toThrow(/BROWSER_CDP_ADAPTER/);
  });

  it('liste fermée des paramètres : une variable BROWSER_CDP_* inconnue est refusée par son nom ; durée hors bornes refusée', async () => {
    const base = { ...optIn, BROWSER_URL: 'wss://b.example/x' };
    await expect(detectProvider({ ...base, BROWSER_CDP_STEALTH: 'true' }, never(), deps())).rejects.toThrow(/BROWSER_CDP_STEALTH/);
    await expect(detectProvider({ ...base, BROWSER_CDP_SESSION_TIMEOUT_SECONDS: '5' }, never(), deps())).rejects.toThrow(/BROWSER_CDP_SESSION_TIMEOUT_SECONDS/);
    expect((await detectProvider({ ...base, BROWSER_CDP_SESSION_TIMEOUT_SECONDS: '900', BROWSER_CDP_ACCOUNT_PROXY: 'true' }, never(), deps())).kind).toBe('cdp');
    await expect(detectProvider({ ...base, BROWSER_CDP_ACCOUNT_PROXY: 'yes' }, never(), deps())).rejects.toThrow(/BROWSER_CDP_ACCOUNT_PROXY/);
  });
});

describe('browser_provider_secrets_masked', () => {
  it('G6 : clé et projet lus par _FILE, absents des erreurs, des capacités journalisées et du fournisseur sérialisé ; enregistrés au masquage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zz_cdp_'));
    try {
      writeFileSync(join(dir, 'key'), 'zz_secret_api_key_value\n');
      writeFileSync(join(dir, 'proj'), 'zz_secret_project_value\n');
      const base = { BROWSER_ALLOW_GENERIC_CDP: 'true', BROWSER_URL: 'https://api.browserbase.com', BROWSER_CDP_ADAPTER: 'browserbase', BROWSER_API_KEY_FILE: join(dir, 'key'), BROWSER_CDP_PROJECT_ID_FILE: join(dir, 'proj') };
      const provider = await detectProvider(base, vi.fn(), deps());
      const serialized = JSON.stringify({ kind: provider.kind, capabilities: provider.capabilities, provider });
      for (const secret of ['zz_secret_api_key_value', 'zz_secret_project_value']) {
        expect(serialized).not.toContain(secret);
        expect(secretValues.values().includes(secret)).toBe(true);
      }
      const both = detectProvider({ ...base, BROWSER_API_KEY: 'zz_other' }, vi.fn(), deps());
      await expect(both).rejects.toThrow(/BROWSER_API_KEY/);
      await expect(detectProvider({ ...base, BROWSER_CDP_PROJECT_ID_FILE: join(dir, 'absent') }, vi.fn(), deps())).rejects.toThrow(/BROWSER_CDP_PROJECT_ID_FILE/);
      const failure = await detectProvider({ ...base, BROWSER_CDP_ADAPTER: 'unknown' }, vi.fn(), deps()).catch((e: unknown) => e);
      expect(String((failure as Error).message)).not.toContain('zz_secret_api_key_value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('jeton dans l’URL fixe : enregistré au masquage, jamais dans les capacités journalisées', async () => {
    const provider = await detectProvider({ BROWSER_ALLOW_GENERIC_CDP: 'true', BROWSER_URL: 'wss://b.example/x?token=zz_url_token_value' }, vi.fn(), deps());
    expect(secretValues.values().includes('zz_url_token_value')).toBe(true);
    expect(JSON.stringify({ kind: provider.kind, capabilities: provider.capabilities })).not.toContain('zz_url_token_value');
  });
});
