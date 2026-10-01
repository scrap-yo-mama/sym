// SPDX-License-Identifier: AGPL-3.0-only
// Bac à sable (INV7, tâche 1.5), niveau unitaire : borne d'isolated-vm, validation des ponts (dont fuzz), protocole IPC.
// La suite hostile de bout en bout (`assert_sandbox`) est dans sandbox.security.test.ts (pnpm test:security).
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import { SsrfGuard } from '@runtime/core/net';
import { createSandboxBridges, domainAllowed, normalizeDomain, SandboxBridgeError, validateFetchRequest, type BridgeResponse } from './bridges.js';
import { killPlan, ProcessSandboxEngine, sandboxOptionsFromEnv, spawnPlan, unexpectedEnvKeys } from './engine.js';
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
    expect(code(() => bridges.log('["' + 'x'.repeat(64) + '"]'))).toBe('output_limit');
    expect(code(() => bridges.log('[1,2]'))).toBe('invalid_bridge_call');
    bridges.violation({ reason: 'forbidden_global', detail: 'require' });
    expect(items).toEqual([{ a: 1 }]);
    expect(violations).toEqual([{ reason: 'forbidden_global', detail: 'require' }]);
    const logged = lines.map((l) => JSON.parse(l) as { event?: string; reason?: string });
    expect(logged.some((l) => l.event === 'sandbox_violation' && l.reason === 'forbidden_global')).toBe(true);
  });

  test('assert_no_personal_data_in_logs (ctx.log du script) : le texte va au journal du run (onLog), jamais au journal du worker', () => {
    const lines: string[] = [];
    const logger = pino({ level: 'trace' }, { write: (s: string) => void lines.push(s) });
    const runLog: (readonly string[])[] = [];
    const { bridges } = createSandboxBridges({ allowedDomains: ['api.zz-test'], guard: new SsrfGuard(), logger, onLog: (args) => void runLog.push(args) });
    bridges.log(JSON.stringify(['contact', 'zz_test_jeanne@exemple.invalid', 'Zztest Jeanne', '+33 6 00 00 00 01']));
    expect(runLog).toEqual([['contact', 'zz_test_jeanne@exemple.invalid', 'Zztest Jeanne', '+33 6 00 00 00 01']]);
    const out = lines.join('');
    for (const motif of ['zz_test_jeanne', 'exemple.invalid', 'Zztest', '00 00 01', 'contact']) expect(out).not.toContain(motif);
    // Seule la taille (identifiant technique) reste au journal du worker.
    expect(lines.map((l) => JSON.parse(l) as { event?: string; count?: number })).toEqual([expect.objectContaining({ event: 'sandbox_log', count: 4 })]);
  });

  test('dépassement du journal : violation (tue l’enfant), plus une simple erreur', () => {
    const { bridges } = createSandboxBridges({ allowedDomains: ['api.zz-test'], guard: new SsrfGuard(), logger: pino({ level: 'silent' }), maxLogBytes: 10 });
    try {
      bridges.log('["' + 'x'.repeat(64) + '"]');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxBridgeError);
      expect((error as SandboxBridgeError).violation).toBe(true);
    }
  });

  test('plafond cumulé des éléments émis (mémoire de l’hôte) : output_limit', () => {
    const { bridges, items } = createSandboxBridges({ allowedDomains: ['api.zz-test'], guard: new SsrfGuard(), logger: pino({ level: 'silent' }), maxTotalItemBytes: 25 });
    const item = JSON.stringify('x'.repeat(8)); // 10 octets
    bridges.emit(item);
    bridges.emit(item);
    expect(code(() => bridges.emit(item))).toBe('output_limit');
    expect(items).toHaveLength(2);
    // Défaut : 50 Mo, bien en deçà de maxItems × maxItemBytes (10 Go).
    const big = JSON.stringify('x'.repeat(1024 * 1024 - 2));
    const d = createSandboxBridges({ allowedDomains: ['api.zz-test'], guard: new SsrfGuard(), logger: pino({ level: 'silent' }) });
    let n = 0;
    while (code(() => d.bridges.emit(big)) === undefined) n += 1;
    expect(n).toBe(50);
  });

  test('violations : 32 retenues et journalisées au plus', () => {
    const lines: string[] = [];
    const { bridges, violations } = createSandboxBridges({ allowedDomains: ['api.zz-test'], guard: new SsrfGuard(), logger: pino({ level: 'info' }, { write: (s: string) => void lines.push(s) }) });
    for (let i = 0; i < 1000; i++) bridges.violation({ reason: 'forbidden_global', detail: 'process' });
    expect(violations).toHaveLength(32);
    expect(lines.filter((l) => l.includes('sandbox_violation'))).toHaveLength(32);
  });

  test('budget cumulé des corps de réponse fetch : coupé puis refusé (bridge_quota)', async () => {
    const response = (body: string): BridgeResponse => ({
      status: 200,
      url: 'https://api.zz-test/',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new Blob([body]).stream(),
    });
    const { bridges } = createSandboxBridges({
      allowedDomains: ['api.zz-test'],
      guard: new SsrfGuard(),
      logger: pino({ level: 'silent' }),
      maxTotalResponseBytes: 150,
      fetch: async () => response('z'.repeat(100)),
    });
    const r = req({ url: 'https://api.zz-test/' });
    expect((await bridges.fetch(r)).truncated).toBe(false);
    const second = await bridges.fetch(r);
    expect(second.truncated).toBe(true);
    expect(second.body).toHaveLength(50);
    await expect(bridges.fetch(r)).rejects.toMatchObject({ code: 'bridge_quota', violation: true });
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
    // ctx.page.* (tâche 1.6) : un second pont relayé, et lui seul.
    expect(parseChildMessage({ t: 'call', id: 2, bridge: 'page', payload: '{"op":"url","args":{}}' })).toEqual({ t: 'call', id: 2, bridge: 'page', payload: '{"op":"url","args":{}}' });
    expect(parseChildMessage({ t: 'call', id: 2, bridge: 'route', payload: '{}' })).toBeUndefined();
    expect(parseChildMessage({ t: 'call', id: -1, bridge: 'fetch', payload: '{}' })).toBeUndefined();
    expect(parseChildMessage({ t: 'done', outcome: 'pwned' })).toBeUndefined();
    expect(parseChildMessage({ t: 'violation', reason: 'time_limit', detail: '' })).toBeUndefined();
    expect(parseChildMessage({ t: 'violation', reason: 'forbidden_import', detail: 'node:fs' })).toBeDefined();
    expect(parseChildMessage({ t: 'done', outcome: 'engine_error', error: 'x' })).toBeDefined();
    expect(parseChildMessage(null)).toBeUndefined();
    fc.assert(fc.property(fc.anything(), (raw) => void parseChildMessage(raw)));
  });

  test('seules les variables injectées par la plateforme sont tolérées', () => {
    expect(unexpectedEnvKeys(['__CF_USER_TEXT_ENCODING'], 'darwin')).toEqual([]);
    expect(unexpectedEnvKeys(['__CF_USER_TEXT_ENCODING'], 'linux')).toEqual(['__CF_USER_TEXT_ENCODING']);
    expect(unexpectedEnvKeys(['MASTER_KEY', 'DATABASE_URL'], 'darwin')).toEqual(['MASTER_KEY', 'DATABASE_URL']);
  });
});

describe('utilisateur dédié, lanceur et plafond CPU (08 §3)', () => {
  test('production : refus de démarrer si l’enfant tournerait sous l’uid du worker', () => {
    expect(() => new ProcessSandboxEngine({ production: true })).toThrow(/utilisateur dédié/);
    const own = process.getuid?.() ?? 0;
    expect(() => new ProcessSandboxEngine({ production: true, uid: own, gid: own })).toThrow(/utilisateur dédié/);
    expect(() => new ProcessSandboxEngine({ production: false })).not.toThrow();
  });

  test('variables SANDBOX_* lues strictement', () => {
    expect(sandboxOptionsFromEnv({})).toEqual({});
    expect(sandboxOptionsFromEnv({ SANDBOX_UID: '1500', SANDBOX_GID: '1500', SANDBOX_LAUNCHER: '/usr/local/libexec/sandbox-launch' })).toEqual({
      uid: 1500,
      gid: 1500,
      launcher: '/usr/local/libexec/sandbox-launch',
    });
    expect(() => sandboxOptionsFromEnv({ SANDBOX_UID: 'abc' })).toThrow(/SANDBOX_UID/);
    expect(() => sandboxOptionsFromEnv({ SANDBOX_UID: '1500' })).toThrow(/SANDBOX_GID/);
  });

  test('commande de lancement : RLIMIT_CPU, environnement vidé, lanceur setpriv sans nouveaux privilèges', () => {
    const plain = spawnPlan({ node: '/n', nodeArgs: ['--x'], script: 'c.js', cpuSeconds: 7 });
    expect(plain.command).toBe('/bin/sh');
    expect(plain.args.slice(2)).toEqual(['7', '/n', '--x', 'c.js']);
    expect(plain.args[1]).toMatch(/ulimit -S -t "\$0" && ulimit -H -t .* && exec \/usr\/bin\/env -i /);
    const launched = spawnPlan({ node: '/n', nodeArgs: [], script: 'c.js', cpuSeconds: 3, launcher: '/l', uid: 1500, gid: 1501 });
    expect(launched.args.slice(2)).toEqual([
      '3', '/l', '--reuid=1500', '--regid=1501', '--clear-groups', '--no-new-privs', '--', '/n', 'c.js',
    ]);
    expect(launched.uid).toBeUndefined();
    const root = spawnPlan({ node: '/n', nodeArgs: [], script: 'c.js', cpuSeconds: 3, uid: 1500, gid: 1501 });
    expect(root).toMatchObject({ uid: 1500, gid: 1501 });
  });

  test('arrêt forcé sous un autre uid : SIGKILL envoyé par le lanceur, sous l’uid de l’enfant', () => {
    // Le worker (autre uid, sans CAP_KILL) ne peut pas signaler l'enfant : kill(2) rend EPERM.
    expect(killPlan({ launcher: '/l', uid: 1500, gid: 1501 }, 4242)).toEqual({
      command: '/l',
      args: ['--reuid=1500', '--regid=1501', '--clear-groups', '--no-new-privs', '--', '/bin/kill', '-KILL', '4242'],
    });
    expect(killPlan({ uid: 1500, gid: 1501 }, 4242)).toBeUndefined();
    expect(killPlan({}, 4242)).toBeUndefined();
  });
});

describe('image (deploy/Dockerfile) : utilisateur dédié du bac à sable', () => {
  test('uid distinct de pwuser, lanceur à capacités minimales réservé au groupe du worker, variables posées', () => {
    const dockerfile = readFileSync(new URL('../../../../deploy/Dockerfile', import.meta.url), 'utf8');
    const env = Object.fromEntries([...dockerfile.matchAll(/\b(SANDBOX_\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
    const options = sandboxOptionsFromEnv(env);
    expect(options.uid).toBeDefined();
    expect(options.uid).not.toBe(1001); // pwuser, utilisateur du worker et du serveur
    expect(dockerfile).toMatch(new RegExp(`useradd --system --uid ${options.uid} --gid ${options.gid} .*--shell /usr/sbin/nologin sandbox`));
    expect(dockerfile).toContain(`install -o root -g pwuser -m 0750 /usr/bin/setpriv ${options.launcher}`);
    expect(dockerfile).toContain(`setcap cap_setuid,cap_setgid=ep ${options.launcher}`);
    expect(dockerfile).toMatch(/^USER pwuser$/m);
  });
});
