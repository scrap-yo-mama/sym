// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.5 (04c § 1.2, § 1.3) : classement des adresses, garde de résolution unique, politique d'hôtes et de ports,
// arguments figés de Chromium. Sans réseau ni navigateur.
import { describe, expect, test } from 'vitest';
import {
  EgressDeniedError,
  EgressPolicyError,
  FORCED_LOOPBACK_OPT_OUT_ENV,
  assertNavigable,
  classifyAddress,
  compileEgressPolicy,
  createEgressGuard,
  dedicatedChromiumArgs,
  hostMatcher,
  sharedContextOptions,
  sharedLaunchOptions,
  type ResolvedAddress,
} from './index.js';

const resolverOf = (table: Record<string, string[]>, calls: string[] = []) => async (host: string): Promise<ResolvedAddress[]> => {
  calls.push(host);
  const list = table[host];
  if (list === undefined) throw new Error('ENOTFOUND');
  return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

async function denied(promise: Promise<unknown>): Promise<EgressDeniedError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EgressDeniedError);
  return error as EgressDeniedError;
}

describe('classement des adresses (ip)', () => {
  test.each([
    ['93.184.215.14', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['192.168.1.1', false],
    ['100.64.0.1', false],
    ['169.254.169.254', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['64:ff9b::a9fe:a9fe', false],
    ['2002:0a00:0001::', false],
    ['pas-une-ip', false],
  ])('%s → publique : %s', (address, allowed) => {
    expect(classifyAddress(address).allowed).toBe(allowed);
  });

  test('métadonnées cloud, non spécifiée et multicast : classes dures', () => {
    expect(classifyAddress('169.254.169.254')).toMatchObject({ allowed: false, reason: 'cloud_metadata', hard: true });
    expect(classifyAddress('fd00:ec2::254')).toMatchObject({ allowed: false, reason: 'cloud_metadata', hard: true });
    expect(classifyAddress('0.0.0.0')).toMatchObject({ allowed: false, hard: true });
    expect(classifyAddress('239.1.1.1')).toMatchObject({ allowed: false, reason: 'multicast', hard: true });
    expect(classifyAddress('10.0.0.1')).toMatchObject({ allowed: false, reason: 'private', hard: false });
  });
});

describe('garde : résolution unique et contrôle des adresses (04c § 1.2)', () => {
  test('une seule résolution par demande, adresse publique épinglée', async () => {
    const calls: string[] = [];
    const guard = createEgressGuard({ resolver: resolverOf({ 'public.test': ['93.184.215.14', '2606:4700:4700::1111'] }, calls) });
    await expect(guard.resolve('Public.Test.', 443)).resolves.toEqual({ address: '93.184.215.14', family: 4 });
    expect(calls).toEqual(['public.test']);
  });

  test('une seule adresse hors de l’ensemble joignable suffit à refuser le nom (address_not_public)', async () => {
    const guard = createEgressGuard({ resolver: resolverOf({ 'mixte.test': ['93.184.215.14', '10.0.0.5'] }) });
    const error = await denied(guard.resolve('mixte.test', 443));
    expect(error).toMatchObject({ reason: 'address_not_public', host: 'mixte.test', address: '10.0.0.5', detail: 'private' });
  });

  test.each([
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'cloud_metadata'],
    ['192.168.0.10', 'private'],
  ])('nom résolu vers %s → address_not_public (%s)', async (address, detail) => {
    const guard = createEgressGuard({ resolver: resolverOf({ 'piege.test': [address] }) });
    expect(await denied(guard.resolve('piege.test', 80))).toMatchObject({ reason: 'address_not_public', detail });
  });

  test('IP littérales : contrôlées sans résolution', async () => {
    const calls: string[] = [];
    const guard = createEgressGuard({ resolver: resolverOf({}, calls) });
    expect(await denied(guard.resolve('127.0.0.1', 80))).toMatchObject({ reason: 'address_not_public' });
    expect(await denied(guard.resolve('[::ffff:169.254.169.254]', 80))).toMatchObject({ reason: 'address_not_public', detail: 'cloud_metadata' });
    await expect(guard.resolve('93.184.215.14', 80)).resolves.toMatchObject({ address: '93.184.215.14' });
    expect(calls).toEqual([]);
  });

  test('noms réservés refusés avant résolution : localhost, *.localhost, métadonnées', async () => {
    const calls: string[] = [];
    const guard = createEgressGuard({ resolver: resolverOf({ localhost: ['93.184.215.14'] }, calls) });
    for (const host of ['localhost', 'a.b.localhost', 'metadata.google.internal', 'metadata.goog']) {
      expect(await denied(guard.resolve(host, 80))).toMatchObject({ reason: 'address_not_public', detail: 'reserved_name' });
    }
    expect(calls).toEqual([]);
  });

  test('nom introuvable ou sans adresse → unresolvable', async () => {
    const guard = createEgressGuard({ resolver: async (host) => (host === 'vide.test' ? [] : Promise.reject(new Error('ENOTFOUND'))) });
    expect(await denied(guard.resolve('absent.test', 443))).toMatchObject({ reason: 'unresolvable', host: 'absent.test' });
    expect(await denied(guard.resolve('vide.test', 443))).toMatchObject({ reason: 'unresolvable' });
  });

  test('SYMB_PRIVATE_HOSTS : noms exacts et CIDR joignables, jamais les classes dures', async () => {
    const guard = createEgressGuard({
      privateHosts: ['fixtures.internal', '10.1.0.0/16'],
      resolver: resolverOf({ 'fixtures.internal': ['127.0.0.1'], 'interne.test': ['10.1.2.3'], 'autre.test': ['10.2.0.1'], 'meta.internal': ['169.254.169.254'] }),
    });
    await expect(guard.resolve('fixtures.internal', 8080)).resolves.toMatchObject({ address: '127.0.0.1' });
    await expect(guard.resolve('interne.test', 80)).resolves.toMatchObject({ address: '10.1.2.3' });
    expect(await denied(guard.resolve('autre.test', 80))).toMatchObject({ reason: 'address_not_public' });
    const hard = createEgressGuard({ privateHosts: ['meta.internal', '169.254.0.0/16'], resolver: resolverOf({ 'meta.internal': ['169.254.169.254'] }) });
    expect(await denied(hard.resolve('meta.internal', 80))).toMatchObject({ reason: 'address_not_public', detail: 'cloud_metadata' });
  });

  test('drapeau de test (SYMB_TEST_ALLOW_PRIVATE) : privé joignable, classes dures toujours refusées', async () => {
    const guard = createEgressGuard({ testAllowPrivate: true, resolver: resolverOf({ 'fixture.test': ['127.0.0.1'], 'meta.test': ['169.254.169.254'], 'zero.test': ['0.0.0.0'] }) });
    await expect(guard.resolve('fixture.test', 80)).resolves.toMatchObject({ address: '127.0.0.1' });
    expect(await denied(guard.resolve('meta.test', 80))).toMatchObject({ reason: 'address_not_public' });
    expect(await denied(guard.resolve('zero.test', 80))).toMatchObject({ reason: 'address_not_public' });
    expect(await denied(guard.resolve('metadata.google.internal', 80))).toMatchObject({ reason: 'address_not_public' });
  });

  test('adresse distante effective du socket contrôlée à nouveau', () => {
    const guard = createEgressGuard({ privateHosts: ['fixtures.internal'] });
    expect(() => guard.checkAddress('fixtures.internal', '127.0.0.1')).not.toThrow();
    expect(() => guard.checkAddress('public.test', '127.0.0.1')).toThrow(EgressDeniedError);
    expect(() => guard.checkAddress('public.test', '')).toThrow(EgressDeniedError);
  });

  test('SYMB_PRIVATE_HOSTS invalide : refusé à la construction', () => {
    expect(() => createEgressGuard({ privateHosts: ['*.interne'] })).toThrow(TypeError);
    expect(() => createEgressGuard({ privateHosts: ['10.0.0.0/4'] })).toThrow(TypeError);
  });
});

describe('politique de session (04c § 1.3)', () => {
  test('allowedHosts absent : toute destination ; vide : aucune', () => {
    expect(hostMatcher(undefined)('n-importe.test')).toBe(true);
    expect(hostMatcher([])('n-importe.test')).toBe(false);
  });

  test('noms exacts en minuscules sans point final ; *.domaine couvre le domaine et ses sous-domaines', () => {
    const allows = hostMatcher(['site-a.test', '*.exemple.com']);
    expect(allows('site-a.test')).toBe(true);
    expect(allows('SITE-A.TEST.')).toBe(true);
    expect(allows('www.site-a.test')).toBe(false);
    expect(allows('exemple.com')).toBe(true);
    expect(allows('a.b.exemple.com')).toBe(true);
    expect(allows('exemple.com.evil.test')).toBe(false);
    expect(allows('pasexemple.com')).toBe(false);
  });

  test('IDN et IP : comparés sous leur forme normalisée (WHATWG)', () => {
    const allows = hostMatcher(['bücher.example', '[2001:db8::1]']);
    expect(allows('xn--bcher-kva.example')).toBe(true);
    expect(allows('2001:db8::1')).toBe(true);
  });

  test('défauts : ports 80 et 443, onBudgetExceeded cut, dnsViaProxy vrai avec upstream', () => {
    const plain = compileEgressPolicy({});
    expect([...plain.ports]).toEqual([80, 443]);
    expect(plain.onBudgetExceeded).toBe('cut');
    expect(plain.budgetBytes).toBeUndefined();
    const chained = compileEgressPolicy({ upstream: { type: 'http', host: 'proxy.test', port: 8080 } });
    expect(chained.dnsViaProxy).toBe(true);
    expect(compileEgressPolicy({ upstream: { profileId: 'pp_1' }, dnsViaProxy: false }).dnsViaProxy).toBe(false);
  });

  test.each([
    [{ ports: [0] }, 'ports'],
    [{ ports: [70_000] }, 'ports'],
    [{ ports: [1.5] }, 'ports'],
    [{ budgetBytes: -1 }, 'budgetBytes'],
    [{ budgetBytes: 1.5 }, 'budgetBytes'],
    [{ allowedHosts: ['*.com'] }, 'allowedHosts'],
    [{ allowedHosts: ['a b.test'] }, 'allowedHosts'],
    [{ allowedHosts: ['http://a.test/'] }, 'allowedHosts'],
    [{ allowedHosts: ['*'] }, 'allowedHosts'],
    [{ onBudgetExceeded: 'throttle' }, 'onBudgetExceeded'],
  ])('politique invalide %j → invalid_option (%s)', (policy, field) => {
    let error: unknown;
    try {
      compileEgressPolicy(policy as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EgressPolicyError);
    expect(error).toMatchObject({ code: 'invalid_option', field });
  });
});

describe('branchement de Chromium (04c § 1.1)', () => {
  const url = 'http://127.0.0.1:41000';

  test('dedicated : --proxy-server de la session, boucle locale par l’egress, résolution et WebRTC fermés', () => {
    expect(dedicatedChromiumArgs(url, {})).toEqual([
      '--proxy-server=http://127.0.0.1:41000',
      '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]);
  });

  test('shared : Chromium chaud sur le proxy fermé, contexte sur l’egress de la session (valeur du client écrasée)', () => {
    expect(sharedLaunchOptions(url, {})).toEqual({
      proxy: { server: 'http://127.0.0.1:41000' },
      args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    const options = sharedContextOptions({ locale: 'fr-FR', proxy: { server: 'http://tiers.example:3128', username: 'u', password: 'p' } }, 'http://127.0.0.1:41001');
    expect(options).toEqual({ locale: 'fr-FR', proxy: { server: 'http://127.0.0.1:41001' } });
  });

  test('egress hors 127.0.0.1 ou variable de contournement de la boucle locale : refus', () => {
    expect(() => dedicatedChromiumArgs('http://10.0.0.1:41000', {})).toThrow(/127\.0\.0\.1/);
    expect(() => dedicatedChromiumArgs('socks5://127.0.0.1:41000', {})).toThrow(/127\.0\.0\.1/);
    expect(() => dedicatedChromiumArgs(url, { [FORCED_LOOPBACK_OPT_OUT_ENV]: '1' })).toThrow(FORCED_LOOPBACK_OPT_OUT_ENV);
    expect(() => sharedLaunchOptions(url, { [FORCED_LOOPBACK_OPT_OUT_ENV]: '' })).toThrow(FORCED_LOOPBACK_OPT_OUT_ENV);
  });

  test('navigation : http et https seulement, refus avant Chromium', () => {
    expect(assertNavigable('https://site-a.test/page').hostname).toBe('site-a.test');
    expect(assertNavigable('http://site-a.test:8080/').port).toBe('8080');
    for (const bad of ['file:///etc/passwd', 'view-source:https://a.test/', 'chrome://settings', 'data:text/html,<p>x', 'javascript:alert(1)', 'pas une url', 'https://u:p@a.test/']) {
      expect(() => assertNavigable(bad)).toThrow(EgressPolicyError);
    }
  });
});
