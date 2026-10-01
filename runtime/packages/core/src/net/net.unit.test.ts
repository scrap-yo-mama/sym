// SPDX-License-Identifier: AGPL-3.0-only
// Garde SSRF (tâche 0.7, INV10) : classification des adresses, politique, résolution unique, épinglage.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, test } from 'vitest';
import type { buildConnector } from 'undici';
import { assertNavigable, chromiumEgressLaunchOptions, guardedGoto } from './chromium.js';
import { parseAuthority } from './egress-proxy.js';
import { createGuardedConnector, createIssuerScopedFetch, createOperatorConfigDispatcher, sharedGuardedDispatcher } from './fetch.js';
import {
  createSsrfPolicy,
  SsrfBlockedError,
  SsrfGuard,
  ssrfPolicyFromEnv,
  TEST_ALLOW_PRIVATE_ENV,
  type Resolver,
} from './guard.js';
import { classifyAddress, embeddedIPv4, ipv6ToBytes } from './ip.js';

const PUBLIC_V4 = '93.184.215.14';
const PUBLIC_V6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';

describe('classification des adresses', () => {
  test.each([
    ['169.254.169.254', 'cloud_metadata'],
    ['169.254.170.2', 'cloud_metadata'],
    ['100.100.100.200', 'cloud_metadata'],
    ['fd00:ec2::254', 'cloud_metadata'],
    ['::ffff:169.254.169.254', 'cloud_metadata'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['::1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'shared_cgnat'],
    ['169.254.1.1', 'link_local'],
    ['fe80::1', 'link_local'],
    ['fe80::1%lo0', 'link_local'],
    ['fc00::1', 'unique_local'],
    ['fd12:3456::1', 'unique_local'],
    ['224.0.0.1', 'multicast'],
    ['ff02::1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.10', 'documentation'],
    ['2001:db8::1', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['2001::1', 'protocol_assignments'], // Teredo
    ['::ffff:127.0.0.1', 'loopback'], // IPv4 mappée
    ['::ffff:7f00:1', 'loopback'], // IPv4 mappée, forme hexadécimale
    ['::ffff:10.0.0.1', 'private'],
    ['64:ff9b::a00:1', 'private'], // NAT64 → 10.0.0.1
    ['64:ff9b::7f00:1', 'loopback'], // NAT64 → 127.0.0.1
    ['2002:7f00:1::', 'loopback'], // 6to4 → 127.0.0.1
    ['2002:a9fe:a9fe::1', 'cloud_metadata'], // 6to4 → 169.254.169.254
    ['::127.0.0.1', 'reserved'], // IPv4-compatible (déprécié)
    ['[::1]', 'loopback'],
  ])('%s → %s', (address, reason) => {
    const verdict = classifyAddress(address);
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed ? undefined : verdict.reason).toBe(reason);
  });

  test.each([PUBLIC_V4, '8.8.8.8', '1.1.1.1', PUBLIC_V6, '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])(
    '%s est publique',
    (address) => expect(classifyAddress(address).allowed).toBe(true),
  );

  test('les encodages décimal, octal et hexadécimal ne sont jamais interprétés comme des IP (net.isIP)', () => {
    for (const raw of ['2130706433', '0177.0.0.1', '0x7f.0.0.1', '0x7f000001', '127.1', 'localhost', '']) {
      const verdict = classifyAddress(raw);
      expect(verdict.allowed ? 'allowed' : verdict.reason).toBe('invalid');
    }
  });

  test('IPv6 : octets et IPv4 intégrée', () => {
    expect([...ipv6ToBytes('::ffff:1.2.3.4')].slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect([...ipv6ToBytes('1::2')]).toEqual([0, 1, ...Array<number>(12).fill(0), 0, 2]);
    expect(embeddedIPv4('::ffff:c0a8:101')).toBe('192.168.1.1');
    expect(embeddedIPv4(PUBLIC_V6)).toBeUndefined();
  });
});

describe('politique', () => {
  test('ALLOWED_PRIVATE_HOSTS vide par défaut, ports 80 et 443, drapeau de test faux', () => {
    const policy = ssrfPolicyFromEnv({});
    expect(policy.allowedPrivateNames.size).toBe(0);
    expect(policy.allowedPrivateCidrs.size).toBe(0);
    expect([...policy.allowedPorts]).toEqual([80, 443]);
    expect(policy.testAllowPrivate).toBe(false);
  });

  test('noms exacts et CIDR ; joker refusé', () => {
    const policy = ssrfPolicyFromEnv({ ALLOWED_PRIVATE_HOSTS: 'Ollama.Internal., 10.0.0.0/8, fd00::/16, 192.168.1.5' });
    expect([...policy.allowedPrivateNames]).toEqual(['ollama.internal']);
    expect(policy.allowedPrivateCidrs.size).toBe(3);
    expect(() => createSsrfPolicy({ allowedPrivateHosts: ['*.internal'] })).toThrow(/nom exact ou CIDR/);
    expect(() => createSsrfPolicy({ allowedPrivateHosts: ['10.0.0.0/33'] })).toThrow(/CIDR invalide/);
  });

  test(`drapeau de test ${TEST_ALLOW_PRIVATE_ENV} : faux par défaut, refusé hors NODE_ENV=test, absent de l'image`, () => {
    expect(ssrfPolicyFromEnv({ NODE_ENV: 'test' }).testAllowPrivate).toBe(false);
    expect(ssrfPolicyFromEnv({ NODE_ENV: 'test', [TEST_ALLOW_PRIVATE_ENV]: '1' }).testAllowPrivate).toBe(true);
    for (const NODE_ENV of ['production', 'development', undefined]) {
      expect(() => ssrfPolicyFromEnv({ NODE_ENV, [TEST_ALLOW_PRIVATE_ENV]: '0' })).toThrow(/réservé aux tests/);
    }
    // L'image de production fixe NODE_ENV=production et ne mentionne jamais le drapeau.
    const dockerfile = readFileSync(new URL('../../../../deploy/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/^ENV NODE_ENV=production$/m);
    expect(dockerfile).not.toContain(TEST_ALLOW_PRIVATE_ENV);
    expect(readFileSync(new URL('../../../../deploy/entrypoint.sh', import.meta.url), 'utf8')).not.toContain(
      TEST_ALLOW_PRIVATE_ENV,
    );
  });
});

function fixedResolver(table: Record<string, string[]>): Resolver {
  return async (host) => (table[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'allowed';
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      expect(error.message).toBe('ssrf_blocked');
      return error.detail.reason;
    }
    throw error;
  }
}

describe('garde : résolution unique, dérogations', () => {
  const resolver = fixedResolver({
    'public.zz-test': [PUBLIC_V4, PUBLIC_V6],
    'mixed.zz-test': [PUBLIC_V4, '10.0.0.5'],
    'mixed6.zz-test': [PUBLIC_V4, 'fd00::5'],
    'ollama.zz-test': ['10.0.0.7'],
    'imds.zz-test': ['169.254.169.254'],
    'railway.internal': ['fd12::1'],
  });

  test('un seul enregistrement interdit (A ou AAAA) suffit à refuser', async () => {
    const guard = new SsrfGuard({ resolver });
    expect(await reason(guard.resolve('public.zz-test', 443))).toBe('allowed');
    expect(await reason(guard.resolve('mixed.zz-test', 443))).toBe('private');
    expect(await reason(guard.resolve('mixed6.zz-test', 443))).toBe('unique_local');
    expect(await reason(guard.resolve('railway.internal', 443))).toBe('unique_local');
    expect(await reason(guard.resolve('unknown.zz-test', 443))).toBe('unresolvable');
  });

  test('noms refusés avant résolution, schémas, ports, identifiants', async () => {
    const guard = new SsrfGuard({ resolver });
    for (const host of ['localhost', 'LOCALHOST.', 'api.localhost', 'metadata.google.internal', 'metadata.goog']) {
      expect(await reason(guard.resolve(host, 80))).toBe('blocked_hostname');
    }
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'view-source:http://public.zz-test/', 'javascript:alert(1)', 'ftp://public.zz-test/', 'gopher://public.zz-test/']) {
      expect(await reason(guard.checkUrl(url))).toBe('scheme');
    }
    expect(await reason(guard.checkUrl('http://public.zz-test:8080/'))).toBe('port');
    expect(await reason(guard.checkUrl('http://user:pw@public.zz-test/'))).toBe('credentials');
  });

  test('les encodages d’IP de l’URL sont normalisés par le parseur WHATWG puis refusés', async () => {
    const guard = new SsrfGuard({ resolver });
    for (const url of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/', 'http://0x7f000001/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/', 'http://[::1]/', 'http://0/']) {
      expect(await reason(guard.checkUrl(url)), url).toMatch(/^(loopback|unspecified)$/);
    }
    expect(await reason(guard.checkUrl('http://0xa9fea9fe/'))).toBe('cloud_metadata');
  });

  test('ALLOWED_PRIVATE_HOSTS ouvre le privé, jamais les métadonnées cloud', async () => {
    const guard = new SsrfGuard({
      resolver,
      policy: createSsrfPolicy({ allowedPrivateHosts: ['ollama.zz-test', 'imds.zz-test', '169.254.0.0/16', '192.168.0.0/16'] }),
    });
    expect(await reason(guard.resolve('ollama.zz-test', 443))).toBe('allowed');
    expect(await reason(guard.resolve('192.168.3.4', 443))).toBe('allowed');
    expect(await reason(guard.resolve('169.254.1.1', 443))).toBe('allowed');
    expect(await reason(guard.resolve('imds.zz-test', 443))).toBe('cloud_metadata');
    expect(await reason(guard.resolve('169.254.169.254', 80))).toBe('cloud_metadata');
    expect(await reason(guard.resolve('10.0.0.1', 443))).toBe('private');
  });

  test('drapeau de test : ouvre le privé et les ports, jamais les métadonnées ni 0.0.0.0', async () => {
    const guard = new SsrfGuard({ resolver, policy: createSsrfPolicy({ testAllowPrivate: true }) });
    expect(await reason(guard.resolve('127.0.0.1', 51234))).toBe('allowed');
    expect(await reason(guard.resolve('localhost', 51234))).not.toBe('blocked_hostname');
    expect(await reason(guard.resolve('169.254.169.254', 80))).toBe('cloud_metadata');
    expect(await reason(guard.resolve('0.0.0.0', 80))).toBe('unspecified');
    expect(await reason(guard.resolve('metadata.google.internal', 80))).toBe('blocked_hostname');
  });
});

describe('connecteur undici : contrôle à la connexion et épinglage', () => {
  function spyBase() {
    const calls: buildConnector.Options[] = [];
    const base: buildConnector.connector = (options, callback) => {
      calls.push(options);
      callback(new Error('zz_test_no_network'), null);
    };
    return { calls, base };
  }

  function connect(connector: buildConnector.connector, options: Partial<buildConnector.Options>): Promise<Error | null> {
    return new Promise((resolve) =>
      connector({ protocol: 'https:', port: '', hostname: 'x', ...options }, (...args) => resolve(args[0])),
    );
  }

  test('résolution unique par connexion, socket ouvert sur l’adresse validée, SNI sur le nom', async () => {
    let calls = 0;
    const answers = [[PUBLIC_V4], ['127.0.0.1']];
    const resolver: Resolver = async () => (answers[calls++] ?? []).map((address) => ({ address, family: 4 }));
    const { calls: baseCalls, base } = spyBase();
    const connector = createGuardedConnector(new SsrfGuard({ resolver }), base);

    // 1re connexion : public, épinglé.
    const first = await connect(connector, { hostname: 'rebind.zz-test' });
    expect(first?.message).toBe('zz_test_no_network');
    expect(calls).toBe(1);
    expect(baseCalls[0]).toMatchObject({ hostname: PUBLIC_V4, servername: 'rebind.zz-test' });

    // 2e connexion : le même nom résout désormais vers la boucle locale (rebinding) → refus, aucun socket.
    const second = await connect(connector, { hostname: 'rebind.zz-test' });
    expect(second).toBeInstanceOf(SsrfBlockedError);
    expect((second as SsrfBlockedError).detail).toMatchObject({ reason: 'loopback', address: '127.0.0.1' });
    expect(calls).toBe(2);
    expect(baseCalls).toHaveLength(1);
  });

  test('littéral IP : pas de DNS, contrôle direct', async () => {
    const { calls, base } = spyBase();
    const connector = createGuardedConnector(new SsrfGuard({ resolver: async () => [] }), base);
    expect(await connect(connector, { hostname: '[::1]', protocol: 'http:' })).toBeInstanceOf(SsrfBlockedError);
    expect(await connect(connector, { hostname: '169.254.169.254', protocol: 'http:' })).toBeInstanceOf(SsrfBlockedError);
    expect(calls).toHaveLength(0);
  });
});

describe('options de lancement de Chromium', () => {
  test('proxy figé sur 127.0.0.1, DNS local coupé, pas de contournement de la boucle locale', () => {
    const options = chromiumEgressLaunchOptions('http://127.0.0.1:41234', {});
    expect(options.proxy).toEqual({ server: 'http://127.0.0.1:41234' });
    expect(options.proxy).not.toHaveProperty('bypass');
    expect(options.args).toContain('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
    expect(Object.isFrozen(options.args)).toBe(true);
    expect(() => chromiumEgressLaunchOptions('http://127.0.0.1:1', { PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: '1' })).toThrow();
    expect(() => chromiumEgressLaunchOptions('http://10.0.0.1:3128', {})).toThrow();
  });
});

// Correctifs de la relecture sécurité de 0.7 (chaque bloc : test rouge puis vert).
describe('relecture sécurité 0.7', () => {
  test('#1 CONNECT : le port 80 (et 443) explicite est conservé, IPv6 entre crochets compris', () => {
    expect(parseAuthority('example.zz-test:80')).toEqual({ host: 'example.zz-test', port: 80 });
    expect(parseAuthority('example.zz-test:443')).toEqual({ host: 'example.zz-test', port: 443 });
    expect(parseAuthority('[::1]:80')).toEqual({ host: '[::1]', port: 80 });
    expect(parseAuthority('0x7f.1:8080')).toEqual({ host: '127.0.0.1', port: 8080 });
    for (const bad of ['example.zz-test', 'a/b:80', 'u@h:80', 'h:0', 'h:65536', 'h:80x', ':80', undefined]) {
      expect(parseAuthority(bad), String(bad)).toBeUndefined();
    }
  });

  test('#2 navigation Chromium : http(s) seulement', async () => {
    const guard = new SsrfGuard();
    for (const url of ['file:///proc/self/environ', 'view-source:http://example.zz-test/', 'chrome://settings', 'data:text/html,x', 'javascript:1', 'about:blank', 'blob:http://a/b', 'ws://example.zz-test/']) {
      expect(() => assertNavigable(url, guard), url).toThrow(SsrfBlockedError);
    }
    expect(() => assertNavigable('https://example.zz-test/', guard)).not.toThrow();
    const visited: string[] = [];
    const page = { goto: async (url: string) => void visited.push(url) };
    await expect(guardedGoto(page, 'file:///etc/passwd', guard)).rejects.toThrow(SsrfBlockedError);
    await guardedGoto(page, 'https://example.zz-test/', guard);
    expect(visited).toEqual(['https://example.zz-test/']);
  });

  test('#5 SIIT (::ffff:0:0:0/96) : IPv4 intégrée classée', () => {
    expect(embeddedIPv4('::ffff:0:7f00:1')).toBe('127.0.0.1');
    const verdict = classifyAddress('::ffff:0:7f00:1');
    expect(verdict.allowed ? 'allowed' : verdict.reason).toBe('loopback');
    expect(classifyAddress('::ffff:0:808:808').allowed).toBe(true);
  });

  test('#6 ALLOWED_PRIVATE_HOSTS : pas de préfixe plus large que /8 (IPv4) ou /16 (IPv6)', () => {
    for (const cidr of ['0.0.0.0/0', '10.0.0.0/7', '::/0', 'fc00::/7', 'fd00::/15']) {
      expect(() => createSsrfPolicy({ allowedPrivateHosts: [cidr] }), cidr).toThrow(/trop large/);
    }
    expect(() => createSsrfPolicy({ allowedPrivateHosts: ['10.0.0.0/8', 'fd00::/16'] })).not.toThrow();
  });

  test('#8 dispatcher partagé par garde (pas de fuite d’Agent)', () => {
    const guard = new SsrfGuard();
    expect(sharedGuardedDispatcher(guard)).toBe(sharedGuardedDispatcher(guard));
    expect(sharedGuardedDispatcher(new SsrfGuard())).not.toBe(sharedGuardedDispatcher(guard));
  });

  test('#8 adresse distante inconnue après connexion → refus (échec fermé)', async () => {
    let destroyed = false;
    const base: buildConnector.connector = (_options, callback) =>
      callback(null, { remoteAddress: undefined, destroy: () => (destroyed = true) } as unknown as Socket);
    const connector = createGuardedConnector(new SsrfGuard(), base);
    const error = await new Promise<Error | null>((resolve) =>
      connector({ protocol: 'https:', port: '', hostname: '93.184.215.14' }, (...args) => resolve(args[0])),
    );
    expect(error).toBeInstanceOf(SsrfBlockedError);
    expect(destroyed).toBe(true);
  });
});

describe('fournisseur OIDC : operator-config limité à l’origine de l’issuer (08b § 1)', () => {
  test('assert_oidc_endpoints_issuer_origin : l’issuer (boucle locale permise) passe ; un point d’entrée d’une autre origine suit la politique des cibles', async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const other = createServer((req, res) => {
      hits.push(`other ${req.method} ${req.url}`);
      res.end();
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const guard = new SsrfGuard({ resolver: async (host) => (host === 'idp-cdn.zz-test' ? [{ address: '127.0.0.1', family: 4 }] : []) });
    const operator = createOperatorConfigDispatcher(guard);
    const idpFetch = createIssuerScopedFetch(issuer, guard, operator);
    try {
      expect((await idpFetch(`${issuer}/.well-known/openid-configuration`, {})).status).toBe(200);
      // Même hôte, autre port : autre origine, refusée (POST de formulaire vers un service interne).
      const blocked = await idpFetch(`${otherOrigin}/token`, { method: 'POST', body: 'code=zz' }).catch((e: unknown) => e);
      expect(blocked).toBeInstanceOf(SsrfBlockedError);
      expect((blocked as SsrfBlockedError).code).toBe('ssrf_blocked');
      // Nom public qui résout vers la boucle locale : refusé aussi (pas d'operator-config hors de l'issuer).
      const named = await idpFetch('https://idp-cdn.zz-test/jwks', {}).catch((e: unknown) => e);
      expect(named).toBeInstanceOf(SsrfBlockedError);
      expect(hits).toEqual(['GET /.well-known/openid-configuration']);
    } finally {
      await operator.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});
