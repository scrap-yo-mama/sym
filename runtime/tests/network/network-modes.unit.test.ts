// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.4 (critère du tableau 10) : avec un proxy de test local (CONNECT, IP de sortie annoncée par mode,
// paramètres journalisés), l'IP de sortie vue par la fixture dépend du mode et les paramètres fournisseur sont
// présents ; 401, 403 et 429 → aucun changement de proxy (assert_no_ip_change_after_refusal, X4, INV6).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { Secret, secretValues } from '../../packages/core/src/crypto/index.ts';
import {
  buildNetworkRungs,
  createSsrfPolicy,
  isSsrfBlocked,
  loadProxyCredentials,
  NetworkLadder,
  openNetworkSession,
  parseNetworkPolicy,
  parseProxyDefinitions,
  RunProxyCost,
  SsrfGuard,
  type FailureClassName,
  type NetworkEscalationReason,
  type NetworkHop,
  type NetworkMode,
  type ProxyCredentials,
  type ProxyDefinition,
} from '../../packages/core/src/net/index.ts';
import { startIpFixture, startTestProxy, type ExitRegistry, type IpFixture, type TestProxy } from '../helpers/test-proxy.ts';

const DC_EXIT = '203.0.113.10';
const RES_EXIT = '198.51.100.20';
const DC_PASSWORD = 'zz_test_dc_password_canary';
const RES_PASSWORD = 'zz_test_res_password_canary';

// Cible en boucle locale : seul le drapeau de test (NODE_ENV=test) l'autorise ; les classes dures restent refusées.
const guard = new SsrfGuard({ policy: createSsrfPolicy({ testAllowPrivate: true }) });

let registry: ExitRegistry;
let fixture: IpFixture;
let dc: TestProxy;
let res: TestProxy;
let proxies: ProxyDefinition[];
const credentials = new Map<string, ProxyCredentials>();

beforeAll(async () => {
  registry = new Map();
  fixture = await startIpFixture(registry);
  dc = await startTestProxy({ exitIp: DC_EXIT, registry, password: DC_PASSWORD });
  res = await startTestProxy({ exitIp: RES_EXIT, registry, password: RES_PASSWORD });
  proxies = parseProxyDefinitions([
    {
      id: 'zz_test_dc',
      type: 'dc',
      url: dc.url,
      credentials_secret_id: 'secret-dc',
      username_template: '{username}[-country-{country}][-session-{session}]',
      price: { per_gb_usd: 0, per_request_usd: 0.001 },
      allow_private_address: true, // dérogation admin : proxy de test en boucle locale
    },
    {
      id: 'zz_test_res',
      type: 'res',
      url: res.url,
      credentials_secret_id: 'secret-res',
      username_template: '{username}[-country-{country}][-city-{city}][-session-{session}]',
      price: { per_gb_usd: 8, per_request_usd: 0 },
      allow_private_address: true,
    },
  ]);
  // Dépôt de secrets simulé (le dépôt réel est couvert par tests/network/proxy-credentials.integration.test.ts).
  const store = new Map([
    ['secret-dc', new Secret(JSON.stringify({ username: 'zzdcuser', password: DC_PASSWORD }))],
    ['secret-res', new Secret(JSON.stringify({ username: 'zzresuser', password: RES_PASSWORD }))],
  ]);
  const reader = { get: async (id: string) => store.get(id) as Secret };
  for (const p of proxies) credentials.set(p.id, (await loadProxyCredentials(reader, p)) as ProxyCredentials);
});

afterEach(() => {
  fixture.seen.length = 0;
  dc.log.length = 0;
  res.log.length = 0;
});

afterAll(async () => {
  await Promise.all([fixture.close(), dc.close(), res.close()]);
  secretValues.clear();
});

const policy = (json: unknown) => parseNetworkPolicy(json);
const ALL = { allow: ['direct', 'dc_proxy', 'res_proxy'], dc_proxy_params: { country: 'fr', session: 'zzsticky1' }, res_proxy_params: { country: 'fr', city: 'paris', session: 'zzsticky2' } };

function sessionFor(ladder: NetworkLadder) {
  const rung = ladder.current;
  return openNetworkSession({ rung, guard, ...(rung.mode === 'direct' ? {} : { credentials: credentials.get(rung.proxy.id) as ProxyCredentials }) });
}

/** Classifieur minimal du banc (le vrai est 04 §7) : statut ou erreur → classe et motif réseau. */
function classify(outcome: { status: number } | { error: unknown }): { cls: FailureClassName | null; reason?: NetworkEscalationReason } {
  if ('error' in outcome) return isSsrfBlocked(outcome.error) ? { cls: 'forbidden' } : { cls: 'network', reason: 'connection_error' };
  switch (outcome.status) {
    case 451:
      return { cls: 'network', reason: 'geo_restriction' };
    case 401:
      return { cls: 'auth_required' };
    case 403:
      return { cls: 'forbidden' };
    case 429:
      return { cls: 'rate_limited' };
    default:
      return { cls: outcome.status < 400 ? null : 'transient' };
  }
}

/** Boucle d'essais sur l'échelle : escalade pour `network`, même IP pour 429 (un réessai), arrêt sinon. */
async function runOnLadder(path: string, json: unknown, ladderProxies = proxies) {
  const hops: NetworkHop[] = [];
  const ladder = new NetworkLadder(buildNetworkRungs(policy(json), ladderProxies), { onHop: (h) => hops.push(h) });
  const cost = new RunProxyCost();
  const attempts: { mode: NetworkMode; cls: FailureClassName | null; changed: boolean }[] = [];
  let slowDowns = 0;
  for (let i = 0; i < 6; i++) {
    const session = sessionFor(ladder);
    let outcome: { status: number } | { error: unknown };
    try {
      const response = await session.fetch(`${fixture.origin}${path}`);
      await response.text();
      outcome = { status: response.status };
    } catch (error) {
      outcome = { error };
    }
    await session.close();
    cost.add(session.usage());
    const { cls, reason } = classify(outcome);
    if (cls === null) {
      attempts.push({ mode: session.mode, cls, changed: false });
      break;
    }
    const step = ladder.onFailure(cls, reason);
    attempts.push({ mode: session.mode, cls, changed: step.changed });
    if (step.decision === 'escalate' && step.changed) continue;
    if (step.decision === 'slow_down' && slowDowns++ < 1) continue; // 429 : ralentir, même barreau
    break;
  }
  return { ladder, hops, attempts, cost };
}

describe('modes réseau : IP de sortie et paramètres fournisseur', () => {
  test('l’IP de sortie vue par la fixture dépend du mode ; les paramètres fournisseur arrivent au proxy', async () => {
    const rungs = buildNetworkRungs(policy(ALL), proxies);
    expect(rungs.map((r) => r.mode)).toEqual(['direct', 'dc_proxy', 'res_proxy']);
    const ips: Record<string, string> = {};
    for (const rung of rungs) {
      const session = openNetworkSession({
        rung,
        guard,
        ...(rung.mode === 'direct' ? {} : { credentials: credentials.get(rung.proxy.id) as ProxyCredentials }),
      });
      const body = (await (await session.fetch(`${fixture.origin}/ip`)).json()) as { ip: string };
      ips[rung.mode] = body.ip;
      await session.close();
    }
    expect(ips.direct).toBe('127.0.0.1');
    expect(ips.dc_proxy).toBe(DC_EXIT);
    expect(ips.res_proxy).toBe(RES_EXIT);
    expect(new Set(Object.values(ips)).size).toBe(3);

    expect(dc.log).toHaveLength(1);
    expect(dc.log[0]).toMatchObject({ username: 'zzdcuser-country-fr-session-zzsticky1', password: DC_PASSWORD, params: { country: 'fr', session: 'zzsticky1' } });
    expect(res.log[0]).toMatchObject({ params: { country: 'fr', city: 'paris', session: 'zzsticky2' }, password: RES_PASSWORD });
    // Le proxy reçoit une demande de tunnel vers la cible, jamais l'URL complète.
    expect(dc.log[0]?.target).toBe(new URL(fixture.origin).host);
  });

  test('HTTP simple aussi par CONNECT, et 407 si les identifiants manquent (aucune bascule en direct)', async () => {
    const [, dcRung] = buildNetworkRungs(policy(ALL), proxies);
    const session = openNetworkSession({ rung: dcRung!, guard }); // sans identifiants
    await expect(session.fetch(`${fixture.origin}/ip`)).rejects.toThrow();
    await session.close();
    expect(fixture.seen).toHaveLength(0);
  });
});

describe('escalade : motifs réseau seulement (04 §7, X4)', () => {
  test('géo-restriction (451) en direct → N2 avec le pays de l’API, saut journalisé', async () => {
    const { attempts, hops } = await runOnLadder('/geo', ALL);
    expect(attempts.map((a) => a.mode)).toEqual(['direct', 'dc_proxy']);
    expect(fixture.seen.map((s) => s.ip)).toEqual(['127.0.0.1', DC_EXIT]);
    expect(hops.map((h) => [h.from, h.to, h.reason])).toEqual([
      [null, 'direct', 'initial'],
      ['direct', 'dc_proxy', 'geo_restriction'],
    ]);
    expect(dc.log[0]?.params.country).toBe('fr');
  });

  test('erreur de connexion au proxy N2 → N3, motif connection_error', async () => {
    const broken = parseProxyDefinitions([
      { id: 'zz_test_dc_down', type: 'dc', url: 'http://127.0.0.1:1', allow_private_address: true },
      { id: 'zz_test_res', type: 'res', url: res.url, credentials_secret_id: 'secret-res', allow_private_address: true },
    ]);
    const { attempts, hops } = await runOnLadder('/ip', { allow: ['dc_proxy', 'res_proxy'], res_proxy_params: { country: 'de' } }, broken);
    expect(attempts.map((a) => [a.mode, a.cls])).toEqual([
      ['dc_proxy', 'network'],
      ['res_proxy', null],
    ]);
    expect(hops.at(-1)).toMatchObject({ from: 'dc_proxy', to: 'res_proxy', reason: 'connection_error', failureClass: 'network', proxyId: 'zz_test_res' });
    expect(fixture.seen.map((s) => s.ip)).toEqual([RES_EXIT]);
  });

  test('N3 absent sans opt-in explicite de l’API : l’échelle s’arrête à N2', async () => {
    const rungs = buildNetworkRungs(policy({ allow: ['direct', 'dc_proxy'] }), proxies);
    expect(rungs.map((r) => r.mode)).toEqual(['direct', 'dc_proxy']);
    const { attempts } = await runOnLadder('/status/451', { allow: ['direct', 'dc_proxy'] });
    expect(attempts.map((a) => a.mode)).toEqual(['direct', 'dc_proxy']);
    expect(res.log).toHaveLength(0);
  });

  test.each([
    [401, 'auth_required'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
  ] as const)('assert_no_ip_change_after_refusal : %i → aucun changement de proxy ni d’IP', async (status, cls) => {
    for (const start of [ALL, { ...ALL, allow: ['dc_proxy', 'res_proxy'] }]) {
      fixture.seen.length = 0;
      const dcBefore = dc.log.length;
      const resBefore = res.log.length;
      const { attempts, hops, ladder } = await runOnLadder(`/status/${status}`, start);
      // Aucune montée : un seul barreau journalisé (l'initial), aucune tentative marquée « changed ».
      expect(hops).toHaveLength(1);
      expect(hops[0]?.reason).toBe('initial');
      expect(attempts.every((a) => a.cls === cls && !a.changed)).toBe(true);
      // 429 : un réessai ralenti sur la même IP ; 401 et 403 : arrêt.
      expect(attempts).toHaveLength(status === 429 ? 2 : 1);
      const ips = new Set(fixture.seen.map((s) => s.ip));
      expect(ips.size).toBe(1);
      expect(ladder.current.mode).toBe(start.allow[0]);
      // Le proxy résidentiel n'est jamais contacté après un refus.
      expect(res.log.length).toBe(resBefore);
      if (start.allow[0] === 'direct') expect(dc.log.length).toBe(dcBefore);
    }
  });

  test('défi, forbidden : décision d’arrêt, barreau inchangé', () => {
    const ladder = new NetworkLadder(buildNetworkRungs(policy(ALL), proxies));
    for (const cls of ['blocked_by_protection', 'forbidden', 'auth_required', 'rate_limited', 'payment_required', 'account_limit', 'transient', 'extraction', 'llm_refused'] as const) {
      const step = ladder.onFailure(cls, 'geo_restriction');
      expect(step.changed).toBe(false);
      expect(step.decision).not.toBe('escalate');
      expect(ladder.current.mode).toBe('direct');
    }
    expect(ladder.hops).toHaveLength(1);
  });
});

describe('garde SSRF : le proxy est une destination contrôlée', () => {
  test('proxy en boucle locale sans dérogation admin → ssrf_blocked, 0 connexion au proxy', async () => {
    const [def] = parseProxyDefinitions([{ id: 'zz_test_private', type: 'dc', url: dc.url }]);
    const before = dc.connections();
    const session = openNetworkSession({ rung: { mode: 'dc_proxy', proxy: def!, params: {} }, guard, credentials: credentials.get('zz_test_dc') as ProxyCredentials });
    const error = await session.fetch(`${fixture.origin}/ip`).catch((e: unknown) => e);
    await session.close();
    expect(isSsrfBlocked(error)).toBe(true);
    expect(dc.connections()).toBe(before);
    expect(fixture.seen).toHaveLength(0);
  });

  test('proxy vers les métadonnées cloud : refusé même avec la dérogation', async () => {
    const [def] = parseProxyDefinitions([{ id: 'zz_test_meta', type: 'dc', url: 'http://169.254.169.254:8080', allow_private_address: true }]);
    const session = openNetworkSession({ rung: { mode: 'dc_proxy', proxy: def!, params: {} }, guard });
    const error = await session.fetch(`${fixture.origin}/ip`).catch((e: unknown) => e);
    await session.close();
    expect(isSsrfBlocked(error)).toBe(true);
  });

  test('socks5 : la connexion au proxy passe aussi par la garde', async () => {
    const [def] = parseProxyDefinitions([{ id: 'zz_test_socks', type: 'dc', url: 'socks5://10.0.0.7:1080' }]);
    const session = openNetworkSession({ rung: { mode: 'dc_proxy', proxy: def!, params: {} }, guard });
    const error = await session.fetch(`${fixture.origin}/ip`).catch((e: unknown) => e);
    await session.close();
    expect(isSsrfBlocked(error)).toBe(true);
  });

  test('cible interdite via un proxy autorisé : refus local avant tout CONNECT', async () => {
    const [, dcRung] = buildNetworkRungs(policy(ALL), proxies);
    const before = dc.log.length;
    const session = openNetworkSession({ rung: dcRung!, guard, credentials: credentials.get('zz_test_dc') as ProxyCredentials });
    const error = await session.fetch('http://169.254.169.254/latest/meta-data/').catch((e: unknown) => e);
    await session.close();
    expect(isSsrfBlocked(error)).toBe(true);
    expect(dc.log.length).toBe(before);
  });
});

describe('coût proxy imputé au run', () => {
  test('octets × prix au Go + requêtes × prix par requête ; 0 en direct', async () => {
    const rungs = buildNetworkRungs(policy(ALL), proxies);
    const cost = new RunProxyCost();
    for (const rung of rungs) {
      const session = openNetworkSession({ rung, guard, ...(rung.mode === 'direct' ? {} : { credentials: credentials.get(rung.proxy.id) as ProxyCredentials }) });
      await (await session.fetch(`${fixture.origin}/ip`)).text();
      await (await session.fetch(`${fixture.origin}/ip`)).text();
      await session.close();
      await new Promise((r) => setImmediate(r));
      cost.add(session.usage());
    }
    const [direct, dcUse, resUse] = cost.entries;
    expect(direct).toMatchObject({ mode: 'direct', bytes: 0, requests: 2, costUsd: 0 });
    expect(dcUse).toMatchObject({ mode: 'dc_proxy', proxyId: 'zz_test_dc', requests: 2, costUsd: 0.002 });
    expect(resUse!.bytes).toBeGreaterThan(200);
    expect(resUse!.costUsd).toBeCloseTo(Math.round(((resUse!.bytes * 8) / 1e9) * 1e6) / 1e6, 9);
    expect(cost.totalUsd).toBeCloseTo(0.002 + resUse!.costUsd, 9);
  });

  test('aucun identifiant de proxy dans le journal des sauts ni dans l’usage', async () => {
    const { hops, cost } = await runOnLadder('/geo', ALL);
    const dump = JSON.stringify({ hops, cost: cost.entries });
    expect(dump).not.toContain(DC_PASSWORD);
    expect(dump).not.toContain('zzdcuser');
  });
});
