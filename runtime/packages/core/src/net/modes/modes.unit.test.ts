// Tâche 1.4 : définitions de proxys (admin), politique réseau, gabarits fournisseur, décisions d'escalade.
// Le banc avec proxy de test local est dans tests/network/network-modes.unit.test.ts.
import { describe, expect, test } from 'vitest';
import {
  NetworkConfigError,
  parseNetworkPolicy,
  parseProviderParams,
  parseProxyDefinition,
  parseProxyDefinitions,
  renderProxyUsername,
} from './definitions.js';
import { buildNetworkRungs, NetworkLadder, networkDecision } from './ladder.js';
import { proxyCostUsd, proxyGuardFor } from './session.js';

const dc = { id: 'dc1', type: 'dc', url: 'http://proxy.example.net:8080' };
const res = { id: 'res1', type: 'res', url: 'https://res.example.net:9000', username_template: '{username}[-country-{country}]' };

describe('définitions de proxys', () => {
  test('forme normalisée, prix par défaut 0, dérogation privée fausse par défaut', () => {
    expect(parseProxyDefinition(dc)).toEqual({
      id: 'dc1',
      type: 'dc',
      url: 'http://proxy.example.net:8080',
      price: { perGbUsd: 0, perRequestUsd: 0 },
      allowPrivateAddress: false,
    });
  });

  test.each([
    [{ ...dc, url: 'http://user:pass@proxy.example.net:8080' }, 'identifiants interdits'],
    [{ ...dc, url: 'ftp://proxy.example.net' }, 'schéma'],
    [{ ...dc, url: 'http://proxy.example.net/path' }, 'chemin'],
    [{ ...dc, type: 'mobile' }, 'type'],
    [{ ...dc, price: { per_gb_usd: -1 } }, 'prix'],
    [{ ...dc, username_template: '{username}-{password}' }, 'jeton inconnu'],
    [{ ...dc, username_template: '{username}[-a[-b]]' }, 'crochets'],
    [{ ...dc, username_template: '{username}:x' }, '« : »'],
    [{ ...dc, allow_private_address: 'yes' }, 'booléen'],
  ])('refus : %j', (input, message) => {
    expect(() => parseProxyDefinition(input)).toThrow(message);
  });

  test('ids en double refusés', () => {
    expect(() => parseProxyDefinitions([dc, dc])).toThrow(NetworkConfigError);
  });
});

describe('paramètres fournisseur et gabarit', () => {
  test('pays ISO alpha-2, valeurs sans séparateur (aucune injection de gabarit)', () => {
    expect(parseProviderParams({ country: 'FR', session: 'abc_1' })).toEqual({ country: 'fr', session: 'abc_1' });
    expect(() => parseProviderParams({ country: 'fra' })).toThrow();
    expect(() => parseProviderParams({ session: 'a-country-us' })).toThrow();
    expect(() => parseProviderParams({ session: '{username}' })).toThrow();
    expect(() => parseProviderParams({ proxy_url: 'http://x' })).toThrow('inconnu');
  });

  test('segments optionnels rendus seulement si renseignés', () => {
    const t = '{username}[-country-{country}][-city-{city}][-session-{session}]';
    expect(renderProxyUsername(t, 'acme', { country: 'fr', session: 's1' })).toBe('acme-country-fr-session-s1');
    expect(renderProxyUsername(t, 'acme', {})).toBe('acme');
    expect(renderProxyUsername(undefined, 'acme', { country: 'fr' })).toBe('acme');
    // Une valeur insérée n'est jamais réinterprétée.
    expect(renderProxyUsername(t, '{country}', { country: 'fr' })).toBe('{country}-country-fr');
    expect(() => renderProxyUsername('{username}-{country}', 'acme', {})).toThrow(NetworkConfigError);
  });
});

describe('politique réseau et échelle', () => {
  const proxies = parseProxyDefinitions([dc, res]);

  test('défaut : direct seul ; tunnel ignoré ici ; niveau inconnu refusé', () => {
    expect(parseNetworkPolicy(undefined).allow).toEqual(['direct']);
    expect(parseNetworkPolicy({ allow: ['direct', 'tunnel'] }).allow).toEqual(['direct']);
    expect(() => parseNetworkPolicy({ allow: ['mobile_proxy'] })).toThrow();
  });

  test('N3 seulement sur opt-in explicite, même si un proxy résidentiel existe', () => {
    expect(buildNetworkRungs(parseNetworkPolicy({ allow: ['direct', 'dc_proxy'] }), proxies).map((r) => r.mode)).toEqual(['direct', 'dc_proxy']);
    expect(buildNetworkRungs(parseNetworkPolicy({ allow: ['res_proxy', 'direct'] }), proxies).map((r) => r.mode)).toEqual(['direct', 'res_proxy']);
  });

  test('proxy choisi par id : inexistant ou de mauvais type refusé', () => {
    expect(() => buildNetworkRungs(parseNetworkPolicy({ allow: ['dc_proxy'], proxy_ids: { dc_proxy: 'nope' } }), proxies)).toThrow('introuvable');
    expect(() => buildNetworkRungs(parseNetworkPolicy({ allow: ['dc_proxy'], proxy_ids: { dc_proxy: 'res1' } }), proxies)).toThrow('incompatible');
    expect(() => parseNetworkPolicy({ allow: ['dc_proxy'], proxy_ids: { dc_proxy: 'http://evil.example' } })).toThrow();
  });

  test('niveau autorisé sans proxy configuré : sauté ; aucun niveau : erreur de configuration', () => {
    expect(buildNetworkRungs(parseNetworkPolicy({ allow: ['direct', 'dc_proxy'] }), [])).toHaveLength(1);
    expect(() => new NetworkLadder(buildNetworkRungs(parseNetworkPolicy({ allow: ['dc_proxy'] }), []))).toThrow(NetworkConfigError);
  });

  test('seule la classe network fait monter ; jamais de retour en arrière ; échelle épuisée signalée', () => {
    expect(networkDecision('network')).toBe('escalate');
    expect(networkDecision('rate_limited')).toBe('slow_down');
    for (const cls of ['forbidden', 'blocked_by_protection', 'robots_disallowed'] as const) expect(networkDecision(cls)).toBe('stop');
    expect(networkDecision('auth_required')).toBe('action_required');
    const at = new Date('2026-10-01T00:00:00Z');
    const ladder = new NetworkLadder(buildNetworkRungs(parseNetworkPolicy({ allow: ['direct', 'dc_proxy'] }), proxies), { now: () => at });
    expect(ladder.onFailure('network', 'geo_restriction')).toMatchObject({ changed: true, rung: { mode: 'dc_proxy' } });
    expect(ladder.onFailure('network')).toMatchObject({ changed: false, exhausted: true });
    expect(ladder.hops).toEqual([
      { at: at.toISOString(), from: null, to: 'direct', proxyId: null, reason: 'initial', failureClass: null },
      { at: at.toISOString(), from: 'direct', to: 'dc_proxy', proxyId: 'dc1', reason: 'geo_restriction', failureClass: 'network' },
    ]);
  });
});

describe('coût et garde du proxy', () => {
  test('coût : octets × prix/Go + requêtes × prix/requête, 6 décimales', () => {
    expect(proxyCostUsd({ perGbUsd: 10, perRequestUsd: 0 }, 1e9, 3)).toBe(10);
    expect(proxyCostUsd({ perGbUsd: 8, perRequestUsd: 0.0005 }, 250_000, 2)).toBe(0.003);
  });

  test('garde du proxy : port du proxy seulement, privé seulement sur dérogation, classes dures jamais', async () => {
    const [pub] = parseProxyDefinitions([{ id: 'p', type: 'dc', url: 'http://10.1.2.3:3128' }]);
    const [priv] = parseProxyDefinitions([{ id: 'q', type: 'dc', url: 'http://10.1.2.3:3128', allow_private_address: true }]);
    const [meta] = parseProxyDefinitions([{ id: 'm', type: 'dc', url: 'http://169.254.169.254:3128', allow_private_address: true }]);
    await expect(proxyGuardFor(pub!).resolve('10.1.2.3', 3128)).rejects.toMatchObject({ code: 'ssrf_blocked' });
    await expect(proxyGuardFor(priv!).resolve('10.1.2.3', 3128)).resolves.toMatchObject({ address: '10.1.2.3' });
    await expect(proxyGuardFor(priv!).resolve('10.1.2.3', 22)).rejects.toMatchObject({ code: 'ssrf_blocked' });
    await expect(proxyGuardFor(meta!).resolve('169.254.169.254', 3128)).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });
});
