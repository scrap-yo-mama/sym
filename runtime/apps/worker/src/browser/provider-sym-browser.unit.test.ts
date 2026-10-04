// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur `sym-browser` (tâche 4.2 ; cdc/sym-browser 04e §2.2, 04g §1) : sessions SYM Browser derrière `BrowserProvider`.
import type { Browser } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { createSymBrowserProvider, type SymBrowserLike } from './provider-sym-browser.js';

const VERSION = { product: 'sym-browser', api: '1', contract: '1', playwright: '1.63.0', chromium: '153.0.8010.12', platform: 'linux', minSdk: '1.0.0' } as const;

function fakeClient(over: Partial<{ version: () => Promise<unknown> }> = {}) {
  const release = vi.fn().mockResolvedValue({});
  const browser = { isConnected: () => true } as unknown as Browser;
  const create = vi.fn().mockImplementation((request: { type?: string }) =>
    Promise.resolve({
      id: 'sess_1',
      state: 'running',
      type: request.type ?? 'dedicated',
      connectUrls: { playwright: 'wss://public.example/v1/connect/pw?token=abc', cdp: request.type === 'shared' ? null : 'wss://public.example/v1/connect/cdp?token=def', bidi: null },
      release,
    }),
  );
  const connect = vi.fn().mockResolvedValue(browser);
  const connectCDP = vi.fn().mockResolvedValue(browser);
  const client = { version: over.version ?? (() => Promise.resolve(VERSION)), sessions: { create, release }, connect, connectCDP } as unknown as SymBrowserLike;
  return { client, create, release, connect, connectCDP, browser };
}

const provider = (client: SymBrowserLike) => createSymBrowserProvider({ url: new URL('http://sym-browser:3000'), client, workerId: 'w1', playwrightVersion: '1.63.0', sleep: () => Promise.resolve() });

describe('fournisseur sym-browser', () => {
  it('déclare ses capacités : toutes présentes (04g §1)', () => {
    const p = provider(fakeClient().client);
    expect(p.kind).toBe('sym-browser');
    expect(Object.values(p.capabilities).every((v) => v === true)).toBe(true);
  });

  it('launchShared : session shared explicite à egress fermé, connexion native sur l’origine de BROWSER_URL, close et kill libèrent la session', async () => {
    const f = fakeClient();
    const launched = await provider(f.client).launchShared();
    expect(f.create).toHaveBeenCalledWith({ type: 'shared', egress: { allowedHosts: [] }, metadata: { workerId: 'w1' } });
    const given = f.connect.mock.calls[0]![0] as { connectUrls: { playwright: string } };
    expect(given.connectUrls.playwright).toBe('ws://sym-browser:3000/v1/connect/pw?token=abc');
    expect(launched.browser).toBe(f.browser);
    await launched.close();
    await launched.kill();
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledWith('sess_1');
  });

  it('launchShared : connexion refusée, la session créée est libérée et l’erreur remonte', async () => {
    const f = fakeClient();
    f.connect.mockRejectedValue(new Error('zz_connect_failed'));
    await expect(provider(f.client).launchShared()).rejects.toThrow('zz_connect_failed');
    expect(f.release).toHaveBeenCalledWith('sess_1');
  });

  it('launchDedicated : session dedicated (User-Agent, arguments, egress, métadonnées), connectOverCDP, cdpUrl de la passerelle', async () => {
    const f = fakeClient();
    const launched = await provider(f.client).launchDedicated({
      userAgent: 'zz-robot/1.0',
      egress: { allowedHosts: ['a.example'] },
      egressServer: null,
      launchArgs: [],
      metadata: { runId: 'r1', attemptId: 'a1' },
    });
    expect(f.create).toHaveBeenCalledWith({
      type: 'dedicated',
      userAgent: 'zz-robot/1.0',
      launchArgs: [],
      egress: { allowedHosts: ['a.example'] },
      metadata: { workerId: 'w1', runId: 'r1', attemptId: 'a1' },
    });
    expect(launched.cdpUrl).toBe('ws://sym-browser:3000/v1/connect/cdp?token=def');
    expect(f.connectCDP).toHaveBeenCalledTimes(1);
    await launched.kill();
    expect(f.release).toHaveBeenCalledWith('sess_1');
  });

  it('engineIdentity : version de Chromium et plateforme du nœud (GET /v1/version)', async () => {
    await expect(provider(fakeClient().client).engineIdentity()).resolves.toEqual({ version: '153.0.8010.12', platform: 'linux' });
  });

  it('openEgress distant : pas dans cette tâche (4.3), refus explicite plutôt qu’un proxy local injoignable du nœud', async () => {
    await expect(provider(fakeClient().client).openEgress({})).rejects.toThrow(/4\.3/);
  });
});
