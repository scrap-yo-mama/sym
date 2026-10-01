// SPDX-License-Identifier: AGPL-3.0-only
// Bac à sable (INV7, tâche 1.5), niveau unitaire : borne d'isolated-vm, validation des ponts (dont fuzz), protocole IPC.
// La suite hostile de bout en bout (`assert_sandbox`) est dans sandbox.security.test.ts (pnpm test:security).
import fc from 'fast-check';
import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import { SsrfGuard } from '@runtime/core/net';
import { createSandboxBridges, domainAllowed, normalizeDomain, SandboxBridgeError, validateFetchRequest } from './bridges.js';
import { unexpectedEnvKeys } from './engine.js';
import { parseChildMessage } from './protocol.js';
import { checkIsolatedVmVersion, installedIsolatedVmVersion } from './version.js';

const policy = { allowedDomains: ['api.zz-test', '*.cdn.zz-test'].map(normalizeDomain), allowedMethods: ['GET', 'HEAD', 'POST'], maxRequestBodyBytes: 1024 };
const req = (r: object) => JSON.stringify({ method: 'GET', headers: {}, ...r });
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof SandboxBridgeError ? error.code : `autre:${String(error)}`;
  }
};

describe('borne isolated-vm (GHSA-864f-rcv7-6rh4)', () => {
  test('refuse sous la borne, accepte les versions corrigées sur le bon Node', () => {
    expect(() => checkIsolatedVmVersion('7.0.0', '26.1.0')).toThrow(/7\.0\.1/);
    expect(() => checkIsolatedVmVersion('7.0.0', '24.21.0')).toThrow(/7\.0\.1/);
    expect(() => checkIsolatedVmVersion('6.1.2', '24.21.0')).toThrow(/6\.2\.0/);
    expect(() => checkIsolatedVmVersion('6.2.0', '26.1.0')).toThrow(/Node 26/);
    expect(() => checkIsolatedVmVersion('5.0.4', '24.21.0')).toThrow(/branche/);
    expect(() => checkIsolatedVmVersion('7.0.1', '22.12.0')).toThrow(/Node 24/);
    expect(() => checkIsolatedVmVersion('7.0.1', '24.21.0')).not.toThrow();
    expect(() => checkIsolatedVmVersion('7.0.1', '26.1.0')).not.toThrow();
    expect(() => checkIsolatedVmVersion('6.2.0', '24.21.0')).not.toThrow();
  });

  test('la version installée passe la borne sur ce Node', () => {
    expect(() => checkIsolatedVmVersion(installedIsolatedVmVersion(), process.versions.node)).not.toThrow();
  });
});

describe('domaines de l’API', () => {
  test('nom exact ou joker de sous-domaine, normalisé', () => {
    const allowed = policy.allowedDomains;
    expect(domainAllowed('api.zz-test', allowed)).toBe(true);
    expect(domainAllowed('API.ZZ-TEST.', allowed)).toBe(true);
    expect(domainAllowed('x.api.zz-test', allowed)).toBe(false);
    expect(domainAllowed('evilapi.zz-test', allowed)).toBe(false);
    expect(domainAllowed('img.cdn.zz-test', allowed)).toBe(true);
    expect(domainAllowed('cdn.zz-test', allowed)).toBe(false);
    expect(domainAllowed('evilcdn.zz-test', allowed)).toBe(false);
    expect(normalizeDomain('Bücher.zz-test')).toBe('xn--bcher-kva.zz-test');
  });

  test('utilisateur@hôte, IDN, schémas et identifiants refusés', () => {
    expect(code(() => validateFetchRequest(req({ url: 'https://api.zz-test@evil.zz-test/' }), policy))).toBe('invalid_bridge_call');
    expect(code(() => validateFetchRequest(req({ url: 'https://evil.zz-test/?h=api.zz-test' }), policy))).toBe('domain_not_allowed');
    expect(code(() => validateFetchRequest(req({ url: 'https://api.zz-test.evil.zz-test/' }), policy))).toBe('domain_not_allowed');
    expect(code(() => validateFetchRequest(req({ url: 'file:///etc/passwd' }), policy))).toBe('invalid_bridge_call');
    expect(code(() => validateFetchRequest(req({ url: 'ws://api.zz-test/' }), policy))).toBe('invalid_bridge_call');
    expect(code(() => validateFetchRequest(req({ url: 'https://api.zz-test/ok' }), policy))).toBeUndefined();
  });

  test('méthodes, en-têtes interdits, corps', () => {
    const url = 'https://api.zz-test/';
    expect(code(() => validateFetchRequest(req({ url, method: 'DELETE' }), policy))).toBe('method_not_allowed');
    for (const name of ['Cookie', 'authorization', 'Host', 'proxy-authorization', 'sec-fetch-site']) {
      expect(code(() => validateFetchRequest(req({ url, headers: { [name]: 'x' } }), policy))).toBe('forbidden_header');
    }
    expect(code(() => validateFetchRequest(req({ url, headers: { 'x-a': 'a\r\nb: c' } }), policy))).toBe('invalid_bridge_call');
    expect(code(() => validateFetchRequest(req({ url, body: 'x' }), policy))).toBe('invalid_bridge_call');
    expect(code(() => validateFetchRequest(req({ url, method: 'POST', body: 'x'.repeat(2048) }), policy))).toBe('invalid_bridge_call');
    expect(code(() => validateFetchRequest(req({ url, extra: 1 }), policy))).toBe('invalid_bridge_call');
  });

  test('fuzz : toute entrée arbitraire est refusée proprement (SandboxBridgeError) ou acceptée dans le domaine', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.jsonValue().map((v) => JSON.stringify(v)),
          fc.record({ url: fc.oneof(fc.webUrl(), fc.string()), method: fc.string(), headers: fc.dictionary(fc.string(), fc.jsonValue()), body: fc.jsonValue() }, { requiredKeys: [] }).map((v) => JSON.stringify(v)),
          fc.anything(),
        ),
        (raw) => {
          try {
            const out = validateFetchRequest(raw, policy);
            expect(domainAllowed(new URL(out.url).hostname, policy.allowedDomains)).toBe(true);
          } catch (error) {
            expect(error).toBeInstanceOf(SandboxBridgeError);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('ponts log, emit, violation', () => {
  test('violation journalisée `sandbox_violation`, quotas de sortie', () => {
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) });
    const { bridges, items, violations } = createSandboxBridges({ allowedDomains: ['api.zz-test'], guard: new SsrfGuard(), logger, maxItems: 1, maxLogBytes: 40 });
    bridges.emit('{"a":1}');
    expect(code(() => bridges.emit('{"b":2}'))).toBe('output_limit');
    expect(code(() => bridges.emit('{pas du json'))).toBe('invalid_bridge_call');
    bridges.log('["bonjour"]');
    expect(code(() => bridges.log('["' + 'x'.repeat(64) + '"]'))).toBe('log_limit');
    expect(code(() => bridges.log('[1,2]'))).toBe('invalid_bridge_call');
    bridges.violation({ reason: 'forbidden_global', detail: 'require' });
    expect(items).toEqual([{ a: 1 }]);
    expect(violations).toEqual([{ reason: 'forbidden_global', detail: 'require' }]);
    const logged = lines.map((l) => JSON.parse(l) as { event?: string; reason?: string });
    expect(logged.some((l) => l.event === 'sandbox_violation' && l.reason === 'forbidden_global')).toBe(true);
  });

  test('fuzz : log et emit ne lèvent que des SandboxBridgeError', () => {
    const logger = pino({ level: 'silent' });
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const { bridges } = createSandboxBridges({ allowedDomains: ['api.zz-test'], guard: new SsrfGuard(), logger });
        for (const call of [() => bridges.log(raw), () => bridges.emit(raw)]) {
          try {
            call();
          } catch (error) {
            expect(error).toBeInstanceOf(SandboxBridgeError);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('protocole IPC et environnement', () => {
  test('messages de l’enfant validés : forme, types, tailles', () => {
    expect(parseChildMessage({ t: 'ready', envKeys: [], node: '24.21.0' })).toBeDefined();
    expect(parseChildMessage({ t: 'call', id: 1, bridge: 'fetch', payload: '{}' })).toBeDefined();
    expect(parseChildMessage({ t: 'call', id: 1, bridge: 'exec', payload: '{}' })).toBeUndefined();
    expect(parseChildMessage({ t: 'call', id: -1, bridge: 'fetch', payload: '{}' })).toBeUndefined();
    expect(parseChildMessage({ t: 'done', outcome: 'pwned' })).toBeUndefined();
    expect(parseChildMessage({ t: 'violation', reason: 'time_limit', detail: '' })).toBeUndefined();
    expect(parseChildMessage(null)).toBeUndefined();
    fc.assert(fc.property(fc.anything(), (raw) => void parseChildMessage(raw)));
  });

  test('seules les variables injectées par la plateforme sont tolérées', () => {
    expect(unexpectedEnvKeys(['__CF_USER_TEXT_ENCODING'], 'darwin')).toEqual([]);
    expect(unexpectedEnvKeys(['__CF_USER_TEXT_ENCODING'], 'linux')).toEqual(['__CF_USER_TEXT_ENCODING']);
    expect(unexpectedEnvKeys(['MASTER_KEY', 'DATABASE_URL'], 'darwin')).toEqual(['MASTER_KEY', 'DATABASE_URL']);
  });
});
