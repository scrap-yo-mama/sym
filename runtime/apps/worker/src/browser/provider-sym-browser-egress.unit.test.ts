// SPDX-License-Identifier: AGPL-3.0-only
// Egress distant du fournisseur `sym-browser` (tâche 4.3 ; cdc/sym-browser 04e §3, 08.2 E5 à E7) :
// `toEgressPolicy` (une ligne de 04e §3.1 par test) et `openRemoteEgress` (attach, événements, état final, fermeture).
import { Secret } from '@runtime/core';
import { createSsrfPolicy, SsrfGuard, type BrowserEgressOptions, type ProxyDefinition } from '@runtime/core/net';
import type { EgressPolicy, EgressState, SessionEvent } from '@sym/contracts/browser';
import type { Browser } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { openRemoteEgress, toEgressPolicy, type RemoteEgressClient } from './provider-sym-browser-egress.js';

const guard = new SsrfGuard({ policy: createSsrfPolicy({ allowedPorts: [80, 443, 8443] }) });
const proxy = (over: Partial<ProxyDefinition> = {}): ProxyDefinition => ({
  id: 'zz_dc',
  type: 'dc',
  url: 'http://proxy.example:3128',
  price: { perGbUsd: 2, perRequestUsd: 0 },
  allowPrivateAddress: false,
  usernameTemplate: '{username}[-country-{country}]',
  ...over,
});
const credentials = { username: new Secret('zz_user'), password: new Secret('zz_pass_secret') };

describe('toEgressPolicy (04e §3.1)', () => {
  it('allowedHosts : noms exacts ; ports de la garde ; sortie directe sans proxy amont ni budget', () => {
    const policy = toEgressPolicy({ rung: { mode: 'direct' }, guard, allowedHosts: ['a.example'] });
    expect(policy).toEqual({ allowedHosts: ['a.example'], ports: [80, 443, 8443] });
  });

  it('allowedHostSuffixes : `*.suffixe` (domaine et sous-domaines)', () => {
    const policy = toEgressPolicy({ rung: { mode: 'direct' }, guard, allowedHosts: ['a.example'], allowedHostSuffixes: ['site.example'] });
    expect(policy.allowedHosts).toEqual(['a.example', '*.site.example']);
  });

  it('sans verrou de domaines : allowedHosts absent (toute destination publique, garde du nœud)', () => {
    expect(toEgressPolicy({ rung: { mode: 'direct' }, guard }).allowedHosts).toBeUndefined();
  });

  it('dc_proxy : upstream {type, host, port, username rendu, password} depuis les identifiants du dépôt de secrets', () => {
    const policy = toEgressPolicy({ rung: { mode: 'dc_proxy', proxy: proxy(), params: { country: 'fr' } }, guard, credentials, allowedHosts: ['a.example'] });
    expect(policy.upstream).toEqual({ type: 'http', host: 'proxy.example', port: 3128, username: 'zz_user-country-fr', password: 'zz_pass_secret' });
  });

  it('res_proxy socks5 sans port : port par défaut du schéma', () => {
    const policy = toEgressPolicy({ rung: { mode: 'res_proxy', proxy: proxy({ type: 'res', url: 'socks5://res.example' }), params: {} }, guard, credentials });
    expect(policy.upstream).toMatchObject({ type: 'socks5', host: 'res.example', port: 1080 });
  });

  it('resolveSecret : lecture des secrets par la fonction fournie', () => {
    const policy = toEgressPolicy({ rung: { mode: 'dc_proxy', proxy: proxy(), params: {} }, guard, credentials }, () => 'zz_revealed');
    expect(policy.upstream).toMatchObject({ username: 'zz_revealed', password: 'zz_revealed' });
  });

  it('costCeiling : budgetBytes = (plafond - autres coûts) / prix au Go, moins COST_BYTE_MARGIN', () => {
    const options: BrowserEgressOptions = {
      rung: { mode: 'dc_proxy', proxy: proxy(), params: {} },
      guard,
      credentials,
      costCeiling: { maxUsd: 1, otherUsd: () => 0.5 },
    };
    // (1 - 0.5) / 2 $ par Go = 0,25 Go
    expect(toEgressPolicy(options).budgetBytes).toBe(250_000_000 - 128 * 1024);
  });

  it('costCeiling sans prix (sortie directe) : pas de budget ; plafond déjà consommé : budget 0', () => {
    expect(toEgressPolicy({ rung: { mode: 'direct' }, guard, costCeiling: { maxUsd: 1 } }).budgetBytes).toBeUndefined();
    const spent: BrowserEgressOptions = { rung: { mode: 'dc_proxy', proxy: proxy(), params: {} }, guard, credentials, costCeiling: { maxUsd: 1, otherUsd: () => 5 } };
    expect(toEgressPolicy(spent).budgetBytes).toBe(0);
  });
});

const STATE: EgressState = { epoch: 2, requests: 7, blocked: 1, bytesIn: 400_000_000, bytesOut: 100_000_000, budgetExceeded: false };

function fakeClient(events: SessionEvent[] = [], state: EgressState = STATE) {
  const put = vi.fn<(id: string, policy: EgressPolicy) => Promise<EgressState>>().mockResolvedValue(state);
  const get = vi.fn<(id: string) => Promise<EgressState>>().mockResolvedValue(state);
  let release: () => void = () => undefined;
  const events$ = vi.fn((_id: string, options?: { signal?: AbortSignal }) =>
    (async function* () {
      for (const event of events) yield event;
      await new Promise<void>((resolve) => {
        release = resolve;
        options?.signal?.addEventListener('abort', () => resolve());
      });
    })(),
  );
  const client: RemoteEgressClient = { sessions: { egress: { put, get } }, events: events$ as unknown as RemoteEgressClient['events'] };
  return { client, put, get, events: events$, release: () => release() };
}

const browser = {} as Browser;
const at = () => new Date(Date.now() + 1000).toISOString();
const blocked = (reason: string, host: string, count = 1): SessionEvent => ({ type: 'egress.blocked', sessionId: 'sess_1', at: at(), data: { host, reason: reason as never, count } });
const opened = async (f: ReturnType<typeof fakeClient>, over: Partial<BrowserEgressOptions> = {}) =>
  openRemoteEgress({ client: f.client, sessionOf: (b) => (b === browser ? 'sess_1' : undefined) }, { rung: { mode: 'dc_proxy', proxy: proxy(), params: {} }, guard, credentials, allowedHosts: ['site-a.example'], ...over });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('assert_browser_egress_chained : egress distant (sym-browser)', () => {
  it('server null ; attach pose la politique de l’essai sur la session du navigateur (PUT)', async () => {
    const f = fakeClient();
    const egress = await opened(f);
    expect(egress.server).toBeNull();
    expect(f.put).not.toHaveBeenCalled();
    await egress.attach(browser);
    expect(f.put).toHaveBeenCalledWith('sess_1', expect.objectContaining({ allowedHosts: ['site-a.example'], upstream: expect.objectContaining({ host: 'proxy.example' }) }));
    await egress.close();
  });

  it('attach sur un navigateur qui n’est pas une session du fournisseur : refus', async () => {
    const egress = await opened(fakeClient());
    await expect(egress.attach({} as Browser)).rejects.toThrow(/session/);
  });

  it('E5 : egress.blocked domain_not_allowed → onDomainBlocked et domainBlockedCount', async () => {
    const f = fakeClient([blocked('domain_not_allowed', 'site-b.example'), blocked('domain_not_allowed', 'site-b.example', 3)]);
    const egress = await opened(f);
    const seen: string[] = [];
    egress.onDomainBlocked((t) => seen.push(t.host));
    await egress.attach(browser);
    await tick();
    expect(seen).toEqual(['site-b.example', 'site-b.example']);
    expect(egress.domainBlockedCount()).toBe(4);
    expect(egress.domainBlocked.map((t) => t.host)).toEqual(['site-b.example', 'site-b.example']);
    expect(egress.blocked).toEqual([]);
    await egress.close();
  });

  it('autre motif : ajouté à blocked (SsrfDenyDetail), pas au verrou de domaines', async () => {
    const f = fakeClient([blocked('address_not_public', '169.254.169.254'), blocked('port_not_allowed', 'a.example')]);
    const egress = await opened(f);
    await egress.attach(browser);
    await tick();
    expect(egress.blocked.map((b) => [b.reason, b.host])).toEqual([
      ['private', '169.254.169.254'],
      ['port', 'a.example'],
    ]);
    expect(egress.domainBlockedCount()).toBe(0);
    await egress.close();
  });

  it('un événement antérieur à l’attache (rejeu de l’histoire de la session partagée) est ignoré', async () => {
    const old: SessionEvent = { type: 'egress.blocked', sessionId: 'sess_1', at: new Date(Date.now() - 60_000).toISOString(), data: { host: 'old.example', reason: 'domain_not_allowed', count: 1 } };
    const f = fakeClient([old]);
    const egress = await opened(f);
    await egress.attach(browser);
    await tick();
    expect(egress.domainBlockedCount()).toBe(0);
    await egress.close();
  });

  it('E6 : egress.budget_exceeded → budgetExceeded() vrai', async () => {
    const f = fakeClient([{ type: 'egress.budget_exceeded', sessionId: 'sess_1', at: at(), data: { budgetBytes: 10, bytesIn: 8, bytesOut: 5, action: 'cut' } }]);
    const egress = await opened(f);
    expect(egress.budgetExceeded()).toBe(false);
    await egress.attach(browser);
    await tick();
    expect(egress.budgetExceeded()).toBe(true);
    await egress.close();
  });

  it('settle : état final de l’époque → usage (octets, demandes, coût proxyCostUsd côté worker) et dépassement', async () => {
    const f = fakeClient([], { ...STATE, budgetExceeded: true });
    const egress = await opened(f);
    await egress.attach(browser);
    expect(egress.usage()).toMatchObject({ mode: 'dc_proxy', proxyId: 'zz_dc', bytes: 0, requests: 0, costUsd: 0 });
    await egress.settle();
    // 500 Mo à 2 $ le Go
    expect(egress.usage()).toMatchObject({ mode: 'dc_proxy', proxyId: 'zz_dc', bytes: 500_000_000, requests: 7, costUsd: 1 });
    expect(egress.budgetExceeded()).toBe(true);
    await egress.close();
  });

  it('sortie directe : aucun coût proxy, demandes de l’époque', async () => {
    const f = fakeClient();
    const egress = await opened(f, { rung: { mode: 'direct' } });
    await egress.attach(browser);
    await egress.settle();
    expect(egress.usage()).toMatchObject({ mode: 'direct', proxyId: null, bytes: 0, costUsd: 0, requests: 7 });
    await egress.close();
  });

  it('close : lit l’état final puis referme la politique (allowedHosts vide), flux d’événements arrêté ; rejouable', async () => {
    const f = fakeClient();
    const egress = await opened(f);
    await egress.attach(browser);
    await egress.close();
    expect(f.get).toHaveBeenCalledWith('sess_1');
    expect(f.put).toHaveBeenLastCalledWith('sess_1', { allowedHosts: [] });
    const calls = f.put.mock.calls.length;
    await egress.close();
    expect(f.put.mock.calls.length).toBe(calls);
  });

  it('close : session déjà libérée (erreurs du nœud) : aucune erreur, dernier état connu gardé', async () => {
    const f = fakeClient();
    const egress = await opened(f);
    await egress.attach(browser);
    await egress.settle();
    f.get.mockRejectedValue(new Error('gone'));
    f.put.mockRejectedValue(new Error('gone'));
    await expect(egress.close()).resolves.toBeUndefined();
    expect(egress.usage().requests).toBe(7);
  });

  it('E7 : le mot de passe du proxy n’apparaît jamais dans l’objet d’egress ni dans ses erreurs', async () => {
    const f = fakeClient();
    f.put.mockRejectedValue(new Error('boom'));
    const egress = await opened(f);
    const error = await egress.attach(browser).catch((e: unknown) => e);
    expect(String(error)).not.toContain('zz_pass_secret');
    expect(JSON.stringify(egress.usage())).not.toContain('zz_pass_secret');
    expect(JSON.stringify(Object.keys(egress))).not.toContain('zz_pass_secret');
  });
});
