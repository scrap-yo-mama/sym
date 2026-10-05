// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur `sym-browser` (tâche 4.2 ; cdc/sym-browser 04e §2.2, 04g §1) : sessions SYM Browser derrière `BrowserProvider`.
import type { Browser } from 'playwright-core';
import { SsrfGuard } from '@runtime/core/net';
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
  const put = vi.fn().mockResolvedValue({ epoch: 1, requests: 0, blocked: 0, bytesIn: 0, bytesOut: 0, budgetExceeded: false });
  const get = vi.fn().mockResolvedValue({ epoch: 1, requests: 0, blocked: 0, bytesIn: 0, bytesOut: 0, budgetExceeded: false });
  const events = vi.fn(() => (async function* () {})());
  const client = { version: over.version ?? (() => Promise.resolve(VERSION)), sessions: { create, release, egress: { put, get } }, events, connect, connectCDP } as unknown as SymBrowserLike;
  return { client, create, release, connect, connectCDP, browser, put, get };
}

const provider = (client: SymBrowserLike) => createSymBrowserProvider({ url: new URL('http://sym-browser:3000'), client, workerId: 'w1', playwrightVersion: '1.63.0', sleep: () => Promise.resolve() });

describe('fournisseur sym-browser', () => {
  it('déclare ses capacités : toutes présentes (04g §1)', () => {
    const p = provider(fakeClient().client);
    expect(p.kind).toBe('sym-browser');
    expect(Object.values(p.capabilities).every((v) => v === true)).toBe(true);
  });

  it('launchShared : session dedicated à egress fermé (les gardes du run exigent le CDP, refusé aux sessions shared), connectOverCDP sur l’origine de BROWSER_URL, close et kill libèrent la session', async () => {
    const f = fakeClient();
    const launched = await provider(f.client).launchShared();
    expect(f.create).toHaveBeenCalledWith({ type: 'dedicated', egress: { allowedHosts: [] }, metadata: { workerId: 'w1' } });
    expect(f.connect).not.toHaveBeenCalled();
    const given = f.connectCDP.mock.calls[0]![0] as { connectUrls: { cdp: string } };
    expect(given.connectUrls.cdp).toBe('ws://sym-browser:3000/v1/connect/cdp?token=def');
    expect(launched.browser).toBe(f.browser);
    await launched.close();
    await launched.kill();
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledWith('sess_1');
  });

  it('launchShared : connexion refusée, la session créée est libérée et l’erreur remonte', async () => {
    const f = fakeClient();
    f.connectCDP.mockRejectedValue(new Error('zz_connect_failed'));
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

  it('openEgress distant : server null, politique de l’essai posée sur la session du navigateur partagé (attach)', async () => {
    const f = fakeClient();
    const p = provider(f.client);
    const egress = await p.openEgress({ rung: { mode: 'direct' }, guard: new SsrfGuard(), allowedHosts: ['site-a.example'] });
    expect(egress.server).toBeNull();
    const launched = await p.launchShared();
    await egress.attach!(launched.browser);
    expect(f.put).toHaveBeenCalledWith('sess_1', { allowedHosts: ['site-a.example'], ports: [80, 443] });
    await egress.close();
    expect(f.put).toHaveBeenLastCalledWith('sess_1', { allowedHosts: [] });
  });

  it('openEgress distant : attach sur le navigateur dedicated d’un essai agentique', async () => {
    const f = fakeClient();
    const p = provider(f.client);
    const egress = await p.openEgress({ rung: { mode: 'direct' }, guard: new SsrfGuard(), allowedHosts: ['a.example'] });
    const launched = await p.launchDedicated({ userAgent: 'zz', egress: (egress as unknown as { policy: never }).policy, egressServer: null, launchArgs: [] });
    await egress.attach!(launched.browser);
    expect(f.put).toHaveBeenCalledWith('sess_1', { allowedHosts: ['a.example'], ports: [80, 443] });
    await egress.close();
  });
});
