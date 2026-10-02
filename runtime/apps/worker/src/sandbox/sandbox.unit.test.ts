// SPDX-License-Identifier: AGPL-3.0-only
// Bac à sable (INV7, tâche 1.5), niveau unitaire : borne d'isolated-vm, validation des ponts (dont fuzz), protocole IPC.
// La suite hostile de bout en bout (`assert_sandbox`) est dans sandbox.security.test.ts (pnpm test:security).
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import { SsrfGuard } from '@runtime/core/net';
import { createSandboxBridges, domainAllowed, normalizeDomain, SandboxBridgeError, validateFetchRequest, type BridgeResponse } from './bridges.js';
import type { SandboxBridges } from '@runtime/core';
import { killPlan, ProcessSandboxEngine, sandboxOptionsFromEnv, sandboxSurvivors, spawnPlan, SweepScheduler, sweepPlan, sweepRefusal, unexpectedEnvKeys } from './engine.js';
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

  test('assert_no_personal_data_in_logs (ctx.log du script) : le texte reste en mémoire (onLog), jamais au journal du worker', () => {
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
    // SANDBOX_NODE : Node de l'enfant, distinct de la copie à capacités de fichier sous laquelle tourne le worker.
    expect(sandboxOptionsFromEnv({ SANDBOX_NODE: '/usr/bin/node' })).toEqual({ node: '/usr/bin/node' });
    expect(sandboxOptionsFromEnv({ SANDBOX_NODE: '' })).toEqual({});
    // SANDBOX_SECCOMP : filtre seccomp posé sur l'enfant (aucun espace de noms, revue 4.1b).
    expect(sandboxOptionsFromEnv({ SANDBOX_SECCOMP: '/usr/local/libexec/sandbox-seccomp' })).toEqual({ seccomp: '/usr/local/libexec/sandbox-seccomp' });
    expect(sandboxOptionsFromEnv({ SANDBOX_SECCOMP: '' })).toEqual({});
    expect(() => sandboxOptionsFromEnv({ SANDBOX_UID: 'abc' })).toThrow(/SANDBOX_UID/);
    expect(() => sandboxOptionsFromEnv({ SANDBOX_UID: '1500' })).toThrow(/SANDBOX_GID/);
  });

  test('assert_sandbox_probe_discriminating — uid ou gid 0, ou groupe du worker, refusés pour l’enfant (revue 4.1b) : le lanceur détient CAP_SETUID effectif', () => {
    // SANDBOX_UID=0 : l'enfant tournerait root, propriétaire de /usr/bin/node, entrypoint.sh, /app. SANDBOX_GID d'un groupe
    // du worker (pwuser) : l'enfant exécuterait node-worker et sandbox-launch et lirait les fichiers du groupe.
    expect(() => new ProcessSandboxEngine({ production: false, uid: 0, gid: 1500 })).toThrow(/SANDBOX_UID.*0/);
    expect(() => new ProcessSandboxEngine({ production: false, uid: 1500, gid: 0 })).toThrow(/SANDBOX_GID.*0/);
    const ownGid = process.getgid?.() ?? 0;
    if (ownGid !== 0) expect(() => new ProcessSandboxEngine({ production: false, uid: 1500, gid: ownGid })).toThrow(/SANDBOX_GID.*groupe du worker/);
    for (const g of (process.getgroups?.() ?? []).filter((x) => x !== 0)) {
      expect(() => new ProcessSandboxEngine({ production: false, uid: 1500, gid: g }), String(g)).toThrow(/SANDBOX_GID.*groupe du worker/);
    }
    expect(() => new ProcessSandboxEngine({ production: false, uid: 1500, gid: 1500 })).not.toThrow();
  });

  test('assert_sandbox_probe_discriminating — sonde d’isolation : fichier témoin 0600 du worker, lisible sous le même uid (la sonde le dit)', async () => {
    // Sous no-new-privileges, /proc/<worker>/environ est refusé à tout processus sans capacité, même du MÊME uid : la sonde
    // lit donc aussi un fichier témoin du worker, que seul un autre uid ne peut pas lire (revue 4.1b).
    const probe = await new ProcessSandboxEngine({ production: false, node: process.execPath }).probeIsolation();
    expect(probe.uid).toBe(process.getuid?.());
    expect(probe.witness).toBe('readable');
  });

  test('commande de lancement : lanceur setpriv EXÉCUTÉ PAR LE WORKER, puis RLIMIT_CPU et environnement vidé sous l’uid dédié', () => {
    const plain = spawnPlan({ node: '/n', nodeArgs: ['--x'], script: 'c.js', cpuSeconds: 7 });
    expect(plain.command).toBe('/bin/sh');
    expect(plain.args.slice(2)).toEqual(['7', '/n', '--x', 'c.js']);
    expect(plain.args[1]).toMatch(/ulimit -S -t "\$0" && ulimit -H -t .* && exec \/usr\/bin\/env -i /);
    // Linux : aucun vidage mémoire (assert_sandbox_no_core_dump) : RLIMIT_CORE d'un octet et coredump_filter nul, avant l'exec,
    // SANS condition (aucune garde sur la présence d'un fichier : un /proc absent ou masqué fait échouer le lancement).
    const linux = spawnPlan({ node: '/n', nodeArgs: ['--x'], script: 'c.js', cpuSeconds: 7, platform: 'linux' });
    expect(linux.args[1]).toMatch(/ulimit -H -t \$\(\(\$0 \+ 1\)\) && echo 0 > \/proc\/self\/coredump_filter && \/usr\/bin\/prlimit --pid \$\$ --core=1:1 && exec \/usr\/bin\/env -i /);
    // Hors Linux (développement) : ni coredump_filter ni prlimit.
    const darwin = spawnPlan({ node: '/n', nodeArgs: ['--x'], script: 'c.js', cpuSeconds: 7, platform: 'darwin' });
    expect(darwin.args[1]).not.toMatch(/coredump_filter|prlimit/);
    expect(plain.args[1]).toBe(process.platform === 'linux' ? linux.args[1] : darwin.args[1]);
    const launched = spawnPlan({ node: '/n', nodeArgs: [], script: 'c.js', cpuSeconds: 3, launcher: '/l', uid: 1500, gid: 1501 });
    // Sous no-new-privileges (Render), le lanceur n'obtient ses capacités de fichier que si son appelant les détient : il
    // doit donc être exécuté par le worker lui-même, jamais par un shell intermédiaire (F-20261001-R01).
    expect(launched.command).toBe('/l');
    expect(launched.args).toEqual([
      '--reuid=1500', '--regid=1501', '--clear-groups', '--no-new-privs', '--', '/bin/sh', '-c', plain.args[1], '3', '/n', 'c.js',
    ]);
    expect(launched.uid).toBeUndefined();
    const root = spawnPlan({ node: '/n', nodeArgs: [], script: 'c.js', cpuSeconds: 3, uid: 1500, gid: 1501 });
    expect(root).toMatchObject({ uid: 1500, gid: 1501 });
  });

  // assert_sandbox_no_core_dump : échec fermé. Sur une machine sans /proc/self/coredump_filter (ici macOS, comme un Linux
  // au /proc absent ou masqué), le plan Linux ne lance pas l'enfant au lieu de le lancer sans protection contre le vidage.
  test.skipIf(existsSync('/proc/self/coredump_filter'))('plan Linux sans /proc/self/coredump_filter : l’enfant ne démarre pas', () => {
    const plan = spawnPlan({ node: process.execPath, nodeArgs: ['-e', 'process.stdout.write("zz_test_started")'], cpuSeconds: 5, platform: 'linux' });
    const r = spawnSync(plan.command, plan.args, { encoding: 'utf8', env: {} });
    expect(r.stdout).not.toContain('zz_test_started');
    expect(r.status).not.toBe(0);
  });

  test('assert_sandbox_child_no_namespaces — filtre seccomp de l’enfant (SANDBOX_SECCOMP) exécuté juste après le changement d’uid, avant le shell', () => {
    // Le profil seccomp du compose permet clone, setns et unshare à tout le conteneur (bac à sable de Chromium) : l'enfant du bac à
    // sable, lui, les perd (aucun espace de noms utilisateur, donc aucune capacité dans un espace imbriqué, revue 4.1b).
    const plain = spawnPlan({ node: '/n', nodeArgs: [], script: 'c.js', cpuSeconds: 3 });
    const launched = spawnPlan({ node: '/n', nodeArgs: [], script: 'c.js', cpuSeconds: 3, launcher: '/l', uid: 1500, gid: 1501, seccomp: '/s' });
    expect(launched.command).toBe('/l');
    expect(launched.args).toEqual(['--reuid=1500', '--regid=1501', '--clear-groups', '--no-new-privs', '--', '/s', '/bin/sh', '-c', plain.args[1], '3', '/n', 'c.js']);
    const alone = spawnPlan({ node: '/n', nodeArgs: [], script: 'c.js', cpuSeconds: 3, seccomp: '/s' });
    expect(alone).toEqual({ command: '/s', args: ['/bin/sh', '-c', plain.args[1], '3', '/n', 'c.js'] });
    // La sonde d'isolation dit si l'enfant peut créer un espace de noms utilisateur (`absent` hors Linux).
    const dockerfile = readFileSync(new URL('../../../../deploy/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/\bSANDBOX_SECCOMP=\/usr\/local\/libexec\/sandbox-seccomp\b/);
    expect(dockerfile).toMatch(/COPY --from=seccomp --chmod=0755 \/src\/sandbox-seccomp \/usr\/local\/libexec\/sandbox-seccomp/);
    const source = readFileSync(new URL('../../../../deploy/sandbox-seccomp.c', import.meta.url), 'utf8');
    for (const name of ['__NR_unshare', '__NR_setns', '__NR_clone3', '__NR_clone', 'CLONE_NEWUSER', 'CLONE_NEWNET', 'PR_SET_NO_NEW_PRIVS', 'SECCOMP_RET_KILL_PROCESS']) expect(source, name).toContain(name);
  });

  test('assert_sandbox_child_no_namespaces — sonde d’isolation : création d’un espace de noms utilisateur rapportée', async () => {
    const probe = await new ProcessSandboxEngine({ production: false, node: process.execPath }).probeIsolation();
    expect(['allowed', 'denied', 'absent']).toContain(probe.namespaces);
    if (process.platform !== 'linux') expect(probe.namespaces).toBe('absent');
  });

  test('assert_sandbox_child_no_namespaces — arrêt forcé (killPlan) et balayage (sweepPlan) sous l’uid dédié : même filtre seccomp que l’enfant', () => {
    // Le profil du compose permet clone, setns et unshare au conteneur : un /bin/kill lancé sous l'uid 1500 sans filtre serait
    // un processus de cet uid sans filtre, qu'un enfant évadé pourrait stopper puis détourner (ptrace ou /proc/<pid>/mem si
    // Yama vaut 0) pour y créer un espace de noms utilisateur. Le filtre s'exécute donc aussi avant /bin/kill.
    const o = { launcher: '/l', uid: 1500, gid: 1501, seccomp: '/s' };
    expect(killPlan(o, 4242)).toEqual({ command: '/l', args: ['--reuid=1500', '--regid=1501', '--clear-groups', '--no-new-privs', '--', '/s', '/bin/kill', '-KILL', '4242'] });
    expect(sweepPlan(o)).toEqual({ command: '/l', args: ['--reuid=1500', '--regid=1501', '--clear-groups', '--no-new-privs', '--', '/s', '/bin/kill', '-KILL', '-1'] });
  });

  test('assert_sandbox_child_no_namespaces — le moteur passe SANDBOX_SECCOMP au lancement de l’enfant ET au balayage', async () => {
    // Faux lanceur : journalise la commande lancée après `--` ; n'exécute JAMAIS /bin/kill, quelle que soit sa position
    // (F-20261002-06 : kill -1 sous notre uid tue toute la session). Le plan de balayage est lu par onSweep ; hors Linux, le
    // moteur refuse de l'exécuter (assert_sweep_never_targets_own_uid), le lanceur ne le voit donc jamais.
    const dir = mkdtempSync(join(tmpdir(), 'zz_test_sweep_seccomp-'));
    const log = join(dir, 'calls.log');
    const launcher = join(dir, 'launch.sh');
    const seccomp = join(dir, 'seccomp.sh');
    writeFileSync(launcher, `#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done; shift\nprintf '%s\\n' "$1 $2 $4" >> '${log}'\nfor a in "$@"; do [ "$a" = /bin/kill ] && exit 0; done\nexec "$@"\n`);
    writeFileSync(seccomp, '#!/bin/sh\nexec "$@"\n');
    chmodSync(launcher, 0o755);
    chmodSync(seccomp, 0o755);
    const bridges = { fetch: () => Promise.reject(new Error('non')), log: () => undefined, emit: () => undefined, violation: () => undefined } as unknown as SandboxBridges;
    const sweeps: { command: string; args: readonly string[]; refused?: string }[] = [];
    try {
      const engine = new ProcessSandboxEngine({ production: false, launcher, uid: 1500, gid: 1500, seccomp, onSweep: (s) => sweeps.push(s) });
      expect(await engine.run('return 1;', bridges, { timeoutMs: 5000, memoryMb: 64 })).toMatchObject({ outcome: 'ok', value: 1 });
      await engine.idle();
      // Lancements d'enfant et balayages ; les arrêts forcés par pid (killPlan, `<filtre> /bin/kill <pid>`) sont ignorés.
      const calls = readFileSync(log, 'utf8').trim().split('\n').filter((c) => !/ \/bin\/kill \d+$/.test(c));
      expect(calls[0]?.startsWith(`${seccomp} /bin/sh `)).toBe(true);
      expect(sweeps).toHaveLength(1);
      expect(sweeps[0]).toMatchObject({ command: launcher });
      expect(sweeps[0]?.args.slice(-5)).toEqual(['--', seccomp, '/bin/kill', '-KILL', '-1']);
      if (process.platform === 'linux') {
        expect(sweeps[0]?.refused).toBeUndefined();
        expect(calls).toEqual([calls[0], `${seccomp} /bin/kill -1`]);
      } else {
        expect(sweeps[0]?.refused).toMatch(/Linux/);
        expect(calls).toEqual([calls[0]]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Node de l’enfant : option `node` (SANDBOX_NODE) prise à la place de process.execPath', async () => {
    // Sans lanceur ni uid : seul le Node change. Un Node introuvable fait échouer la sonde, le Node courant la réussit.
    await expect(new ProcessSandboxEngine({ production: false, node: '/zz-test/absent/node' }).probeIsolation()).rejects.toThrow(/sonde d'isolation en échec/);
    const probe = await new ProcessSandboxEngine({ production: false, node: process.execPath }).probeIsolation();
    expect(probe.uid).toBe(process.getuid?.());
  });

  test('arrêt forcé sous un autre uid : SIGKILL envoyé par le lanceur, sous l’uid de l’enfant', () => {
    // Le worker (autre uid, sans CAP_KILL) ne peut pas signaler l'enfant : kill(2) rend EPERM.
    expect(killPlan({ launcher: '/l', uid: 1500, gid: 1501 }, 4242)).toEqual({
      command: '/l',
      args: ['--reuid=1500', '--regid=1501', '--clear-groups', '--no-new-privs', '--', '/bin/kill', '-KILL', '4242'],
    });
    expect(killPlan({ uid: 1500, gid: 1501 }, 4242)).toBeUndefined();
    // Jamais kill 0 (groupe), kill -N (tous ou un groupe), kill 1 (init) : seul un pid d'enfant (> 1, entier) est visé.
    for (const pid of [0, -1, -4242, 1, 1.5, Number.NaN]) expect(killPlan({ launcher: '/l', uid: 1500, gid: 1501 }, pid), String(pid)).toBeUndefined();
    expect(killPlan({}, 4242)).toBeUndefined();
  });

  test('balayage de fin de run : SIGKILL à tous les processus de l’uid dédié, envoyé par le lanceur sous cet uid', () => {
    // kill(-1) sous l'uid dédié n'atteint que les processus de cet uid (ni le worker, ni Chromium, ni tini).
    expect(sweepPlan({ launcher: '/l', uid: 1500, gid: 1501 })).toEqual({
      command: '/l',
      args: ['--reuid=1500', '--regid=1501', '--clear-groups', '--no-new-privs', '--', '/bin/kill', '-KILL', '-1'],
    });
    expect(sweepPlan({ uid: 1500, gid: 1501 })).toBeUndefined();
    expect(sweepPlan({})).toBeUndefined();
  });

  test('balayage : seulement quand aucun autre run (ni sonde) n’est actif, et un run suivant attend sa fin (revue F-20261001-R01)', async () => {
    // Faux lanceur : journalise chaque appel ; n'exécute JAMAIS /bin/kill (ici, kill -1 viserait tous nos processus).
    const dir = mkdtempSync(join(tmpdir(), 'zz_test_sweep-'));
    const log = join(dir, 'calls.log');
    const launcher = join(dir, 'launch.sh');
    writeFileSync(launcher, `#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done; shift\nprintf '%s\\n' "$1 $3" >> '${log}'\nfor a in "$@"; do [ "$a" = /bin/kill ] && exit 0; done\nexec "$@"\n`);
    chmodSync(launcher, 0o755);
    // Lancements d'enfant (/bin/sh, journalisés par le faux lanceur) et balayages (onSweep, dans le même journal : exécutés sous
    // Linux, refusés ailleurs) ; les appels de /bin/kill vus par le faux lanceur (arrêts forcés, balayage Linux) sont ignorés.
    const calls = () =>
      readFileSync(log, 'utf8').trim().split('\n').flatMap((c) => (c === 'zz_sweep' ? ['sweep'] : c.startsWith('/bin/sh ') ? ['spawn'] : []));
    const bridges = { fetch: () => Promise.reject(new Error('non')), log: () => undefined, emit: () => undefined, violation: () => undefined } as unknown as SandboxBridges;
    try {
      const engine = new ProcessSandboxEngine({ production: false, launcher, uid: 1500, gid: 1500, onSweep: () => appendFileSync(log, 'zz_sweep\n') });
      const limits = { timeoutMs: 5000, memoryMb: 64 };
      expect(await engine.run('return 1;', bridges, limits)).toMatchObject({ outcome: 'ok', value: 1 });
      await engine.idle();
      expect(calls()).toEqual(['spawn', 'sweep']);
      // Deux runs concurrents : un seul balayage, après le second.
      const [a, b] = await Promise.all([engine.run('return 2;', bridges, limits), engine.run('return 3;', bridges, limits)]);
      expect([a.value, b.value]).toEqual([2, 3]);
      await engine.idle();
      // Ordre : lancement, balayage, lancement, lancement, balayage (aucun lancement pendant un balayage).
      expect(calls()).toEqual(['spawn', 'sweep', 'spawn', 'spawn', 'sweep']);
      // La sonde d'isolation compte comme un run : balayage après elle aussi.
      await engine.probeIsolation();
      await engine.idle();
      expect(calls().slice(-2)).toEqual(['spawn', 'sweep']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('assert_sandbox_sweep_verified — balayage de l’uid dédié : vidange périodique et vérification (revue 4.1b, D-32)', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  test('runs qui se chevauchent sans fin : après N runs, nouveaux lancements suspendus jusqu’à la vidange, puis balayage', async () => {
    const events: string[] = [];
    const scheduler = new SweepScheduler({ sweepOnce: () => { events.push('sweep'); return Promise.resolve(true); }, everyRuns: 2, everyMs: 3_600_000 });
    await scheduler.enter(); events.push('a');
    await scheduler.enter(); events.push('b');
    // Deux runs depuis le dernier balayage : le troisième attend que a et b soient finis, puis le balayage.
    let cEntered = false;
    const c = scheduler.enter().then(() => { cEntered = true; events.push('c'); });
    await tick();
    expect(cEntered).toBe(false);
    scheduler.leave(); // a
    await tick();
    expect(cEntered).toBe(false);
    scheduler.leave(); // b : plus aucun run actif → balayage
    await c;
    expect(events).toEqual(['a', 'b', 'sweep', 'c']);
    scheduler.leave();
    await scheduler.idle();
    expect(events).toEqual(['a', 'b', 'sweep', 'c', 'sweep']);
  });

  test('vidange aussi après T secondes sans balayage, même sous le seuil de runs', async () => {
    let now = 0;
    const events: string[] = [];
    const scheduler = new SweepScheduler({ sweepOnce: () => { events.push('sweep'); return Promise.resolve(true); }, everyRuns: 1000, everyMs: 60_000, now: () => now });
    await scheduler.enter();
    now = 60_001;
    let entered = false;
    const next = scheduler.enter().then(() => { entered = true; });
    await tick();
    expect(entered).toBe(false);
    scheduler.leave();
    await next;
    expect(events).toEqual(['sweep']);
  });

  test('survivant après le balayage (balayeur stoppé par un processus évadé) : nouveau balayage ; échec persistant → runs refusés, alerte', async () => {
    const alerts: string[] = [];
    let attempts = 0;
    const flaky = new SweepScheduler({ sweepOnce: () => Promise.resolve(++attempts >= 2), everyRuns: 10, everyMs: 3_600_000, onFailure: (m) => alerts.push(m) });
    await flaky.enter();
    flaky.leave();
    await flaky.idle();
    expect(attempts).toBe(2);
    await expect(flaky.enter()).resolves.toBeUndefined();
    flaky.leave();
    await flaky.idle();

    const stuck = new SweepScheduler({ sweepOnce: () => Promise.resolve(false), everyRuns: 10, everyMs: 3_600_000, maxAttempts: 3, onFailure: (m) => alerts.push(m) });
    await stuck.enter();
    stuck.leave();
    await stuck.idle();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/balayage de l'uid dédié en échec/);
    await expect(stuck.enter()).rejects.toThrow(/balayage de l'uid dédié en échec/);
  });

  test('sandboxSurvivors : processus de l’uid dédié encore vivants (uid réel, effectif ou sauvé), zombies exclus', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'zz_test_proc-'));
    const status = (pid: number, uid: string, state: string) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), 'status'), `Name:\tx\nState:\t${state}\nPid:\t${pid}\nUid:\t${uid}\nGid:\t1500\t1500\t1500\t1500\n`);
    };
    try {
      status(10, '1001\t1001\t1001\t1001', 'S (sleeping)'); // worker
      status(11, '1500\t1500\t1500\t1500', 'T (stopped)'); // balayeur stoppé
      status(12, '1500\t1500\t1500\t1500', 'Z (zombie)'); // déjà mort
      status(13, '1001\t1500\t1500\t1500', 'R (running)'); // uid effectif 1500
      status(14, '0\t0\t0\t0', 'S (sleeping)');
      mkdirSync(join(proc, 'self'));
      expect((await sandboxSurvivors(1500, proc)).sort()).toEqual([11, 13]);
      expect(await sandboxSurvivors(1600, proc)).toEqual([]);
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });
});

describe('assert_sweep_never_targets_own_uid — balayage (kill -1) refusé hors Linux, sous l’uid du worker et sous root (F-20261002-06)', () => {
  // Décision pure : aucun lanceur, aucun /bin/kill n'est exécuté ici. `kill -1` lancé sous l'uid du worker tuerait tous ses
  // processus (sur un poste de développement : toute la session de l'utilisateur) ; sous root, tout le conteneur.
  test('refus : plateforme autre que Linux, uid cible égal à l’uid courant, uid courant inconnu, uid cible 0', () => {
    expect(sweepRefusal({ uid: 1500, ownUid: 1001, platform: 'linux' })).toBeUndefined();
    expect(sweepRefusal({ uid: 1500, ownUid: 1001, platform: 'darwin' })).toMatch(/Linux/);
    expect(sweepRefusal({ uid: 1500, ownUid: 1001, platform: 'win32' })).toMatch(/Linux/);
    expect(sweepRefusal({ uid: 1001, ownUid: 1001, platform: 'linux' })).toMatch(/uid du worker/);
    expect(sweepRefusal({ uid: 1500, ownUid: undefined, platform: 'linux' })).toMatch(/uid du worker/);
    expect(sweepRefusal({ uid: 0, ownUid: 1001, platform: 'linux' })).toMatch(/root/);
    // Sur cette machine, sous notre propre uid : toujours refusé, quelle que soit la plateforme.
    const own = process.getuid?.();
    if (own !== undefined) expect(sweepRefusal({ uid: own, ownUid: own, platform: process.platform })).toBeDefined();
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
    // F-20261001-R01 : le worker tourne sous une COPIE de Node à capacités de fichier réservée à pwuser ; l'enfant exécute
    // le Node ordinaire (sans capacité de fichier, exécutable par l'uid dédié). Démarrage en root, descente par entrypoint.sh.
    expect(dockerfile).toContain('install -o root -g pwuser -m 0750 /usr/bin/node /usr/local/libexec/node-worker');
    // Capacités PERMISES seulement (=p, revue de F-20261001-R01) : un process.setuid(0) du worker échoue (EPERM) ; sous
    // no-new-privileges, sandbox-launch garde les siennes par l'intersection avec le permis du worker.
    expect(dockerfile).toContain('setcap cap_setuid,cap_setgid=p /usr/local/libexec/node-worker');
    // Rien de ce qu'exécute pwuser (Chromium de /ms-playwright) n'est modifiable par l'uid dédié.
    expect(dockerfile).toMatch(/chmod -R go-w,a\+rX \/ms-playwright/);
    expect(options.node).toBe('/usr/bin/node');
    expect(dockerfile).toMatch(/^USER root$/m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/entrypoint\.sh"\]$/m);
  });
});
