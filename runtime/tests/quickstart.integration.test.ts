// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.8 : le tutoriel « Démarrage rapide » (apps/docs/content/tutoriels/quickstart.md) est rejoué sur une instance
// vierge. Les commandes `bash` du tutoriel sont extraites de la page et exécutées telles quelles (curl, openssl) ; l'étape
// `docker compose up` est jouée par les processus de l'image (migrations, `server`, `worker`), sans Docker, sur une base
// PostgreSQL jetable. Un crochet journalise toute connexion TCP des processus : aucune ne doit sortir de la machine.
// - assert_quickstart_replayed : chaque étape rejouable du tutoriel réussit, avec la sortie annoncée par la page ;
// - assert_quickstart_no_egress : « aucune requête ne quitte l'instance hors fixtures » (16 § 8) : toutes les connexions
//   du serveur et du worker vont à la boucle locale ou à la base de test ;
// - assert_quickstart_pending_steps_declared : les étapes décrites mais non rejouées (D0, première API) attendent une
//   fonction qui n'est pas livrée ; dès qu'elle l'est, ce test échoue pour obliger à les rejouer.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { QUICKSTART_BASE_URL, parseQuickstart, type QuickstartStep } from '../apps/docs/src/quickstart.ts';
import { ROUTES } from '../apps/server/src/routes/registry.js';
import { createTestDatabase, type TestDatabase } from './helpers/pg.js';

const runtimeDir = new URL('..', import.meta.url).pathname;
const quickstart = readFileSync(join(runtimeDir, 'apps/docs/content/tutoriels/quickstart.md'), 'utf8');
const steps = parseQuickstart(quickstart);
const hook = join(runtimeDir, 'tests/helpers/net-log-hook.ts');
const cli = join(runtimeDir, 'apps/cli/dist/index.js');
const serverEntry = join(runtimeDir, 'apps/server/dist/index.js');
const workerEntry = join(runtimeDir, 'apps/worker/dist/index.js');

let tdb: TestDatabase;
let work: string;
let stateFile: string;
let port: number;
let base: string;
const children: { name: string; proc: ChildProcess; log: () => string; netLog: string }[] = [];
const stepOutput = new Map<string, string>();

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: free } = server.address() as AddressInfo;
      server.close(() => resolve(free));
    });
  });
}

/** Un shell par étape, état (variables exportées) passé d'une étape à l'autre : comme un terminal qu'on garde ouvert. */
function bash(script: string): { code: number; stdout: string; stderr: string } {
  const full = [`set -euo pipefail`, `[ -f ${quote(stateFile)} ] && . ${quote(stateFile)}`, script.replaceAll(QUICKSTART_BASE_URL, base), `export -p > ${quote(stateFile)}`].join('\n');
  const result = spawnSync('bash', ['-c', full], { cwd: work, env: { PATH: process.env['PATH'] ?? '', HOME: work, LC_ALL: 'C' }, encoding: 'utf8', timeout: 60_000 });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const stateVariable = (name: string): string => {
  const result = spawnSync('bash', ['-c', `. ${quote(stateFile)}; printf %s "\${${name}}"`], { encoding: 'utf8' });
  return result.stdout;
};

function startProcess(name: string, args: string[], env: NodeJS.ProcessEnv): void {
  const netLog = join(work, `${name}.net`);
  const proc = spawn('node', ['--import', hook, ...args], {
    cwd: runtimeDir,
    env: { PATH: process.env['PATH'] ?? '', NET_LOG: netLog, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-4000);
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);
  children.push({ name, proc, log: () => output, netLog });
}

async function waitHealthy(): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    for (const child of children) {
      if (child.proc.exitCode !== null) throw new Error(`${child.name} s'est arrêté (code ${child.proc.exitCode}) : ${child.log()}`);
    }
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // pas encore à l'écoute
    }
    if (Date.now() > deadline) throw new Error('le serveur ne répond pas sur /api/health');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function stopChildren(): Promise<void> {
  for (const { proc } of children) if (proc.exitCode === null) proc.kill('SIGTERM');
  await Promise.all(
    children.map(
      ({ proc }) =>
        new Promise<void>((resolve) => {
          if (proc.exitCode !== null) return resolve();
          const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
          proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
}

beforeAll(async () => {
  for (const dist of [cli, serverEntry, workerEntry]) expect(existsSync(dist), `${dist} : lancez pnpm build avant ce test`).toBe(true);
  tdb = await createTestDatabase('quickstart');
  work = mkdtempSync(join(tmpdir(), 'zz_test_quickstart_'));
  stateFile = join(work, 'state.sh');
  port = await freePort();
  base = `http://localhost:${port}`;
}, 120_000);

afterAll(async () => {
  await stopChildren();
  if (work) rmSync(work, { recursive: true, force: true });
  await tdb?.drop();
}, 120_000);

describe('assert_quickstart_replayed : le tutoriel sur une instance vierge', () => {
  test('la page déclare des étapes, avec un identifiant unique chacune', () => {
    expect(steps.length).toBeGreaterThanOrEqual(8);
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
    for (const step of steps.filter((s) => s.mode === 'run')) {
      // Toute requête du tutoriel vise l'instance locale : le rejeu ne contacte aucun site.
      for (const url of step.script.match(/https?:\/\/[^\s'"\\]+/g) ?? []) expect(url.startsWith(QUICKSTART_BASE_URL), `${step.id} : ${url}`).toBe(true);
    }
  });

  const replay = (step: QuickstartStep): void => {
    test(`étape « ${step.id} »`, async () => {
      if (step.mode === 'pending') return;
      if (step.mode === 'process') {
        // `docker compose up` : service migrate, puis serveur et worker (mêmes variables que le fichier Compose).
        const masterKey = stateVariable('MASTER_KEY');
        const token = stateVariable('ADMIN_BOOTSTRAP_TOKEN');
        const migrate = spawnSync('node', [cli, 'migrate'], { cwd: runtimeDir, env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: tdb.url }, encoding: 'utf8', timeout: 90_000 });
        expect(migrate.status, `${migrate.stdout}${migrate.stderr}`).toBe(0);
        startProcess('server', [serverEntry], { DATABASE_URL: tdb.url, PUBLIC_URL: base, MASTER_KEY: masterKey, ADMIN_BOOTSTRAP_TOKEN: token, PORT: String(port) });
        startProcess('worker', ['--no-node-snapshot', workerEntry], { DATABASE_URL: tdb.url, MASTER_KEY: masterKey });
        await waitHealthy();
        return;
      }
      const result = bash(step.script);
      expect(result.code, `${step.id} : ${result.stdout}\n${result.stderr}`).toBe(0);
      for (const text of step.expect) expect(result.stdout, `${step.id} : « ${text} » attendu`).toContain(text);
      stepOutput.set(step.id, result.stdout);
    }, 120_000);
  };
  for (const step of steps) replay(step);

  test('les secrets du tutoriel respectent le format attendu par l\'instance', () => {
    expect(Buffer.from(stateVariable('MASTER_KEY'), 'base64')).toHaveLength(32);
    expect(stateVariable('ADMIN_BOOTSTRAP_TOKEN').length).toBeGreaterThanOrEqual(32);
  });

  test('la clé créée par le tutoriel n\'est affichée qu\'une fois, puis relue sans son secret', () => {
    const created = JSON.parse(stepOutput.get('api-key') ?? '{}') as { key?: string; id?: string };
    expect(created.key).toMatch(/^sy_live_/);
    const listed = bash(`curl -fsS -b cookies.txt ${QUICKSTART_BASE_URL}/api/api-keys`);
    expect(listed.code).toBe(0);
    expect(listed.stdout).not.toContain(created.key ?? 'absent');
  });
});

describe('assert_quickstart_no_egress : aucune connexion ne quitte la machine', () => {
  test('toutes les connexions du serveur et du worker vont à la boucle locale ou à la base de test', async () => {
    await stopChildren();
    const db = new URL(tdb.url);
    const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', db.hostname]);
    const allowedPorts = new Set([String(port), db.port || '5432']);
    const seen: string[] = [];
    for (const child of children) {
      expect(existsSync(child.netLog), `${child.name} : aucun journal réseau (crochet non chargé ?)`).toBe(true);
      for (const line of readFileSync(child.netLog, 'utf8').split('\n').filter(Boolean)) seen.push(`${child.name} ${line}`);
    }
    expect(seen.length, 'le crochet doit avoir vu au moins la connexion à la base').toBeGreaterThan(0);
    const outside = seen.filter((entry) => {
      const [, destination = ''] = entry.split(' ');
      if (destination.startsWith('unix')) return false;
      const index = destination.lastIndexOf(':');
      return !(allowedHosts.has(destination.slice(0, index)) && allowedPorts.has(destination.slice(index + 1)));
    });
    expect(outside, `destinations hors machine : ${outside.join(', ')}`).toEqual([]);
  });
});

describe('assert_quickstart_pending_steps_declared : ce que le tutoriel décrit sans le rejouer', () => {
  const pending = steps.filter((s) => s.mode === 'pending');

  test('les étapes D0 et première API sont déclarées en attente, avec leur cause', () => {
    expect(pending.map((s) => s.id).sort()).toEqual(['d0', 'first-api']);
    for (const step of pending) expect(step.pending, step.id).toBeTruthy();
  });

  test('leurs routes ne sont pas encore livrées : sinon, il faut les rejouer', () => {
    const delivered = (method: string, url: string): boolean => ROUTES.some((r) => r.method === method && r.url === url);
    expect(delivered('POST', '/api/apis'), 'POST /api/apis est livrée : passez « first-api » en mode run').toBe(false);
    expect(ROUTES.some((r) => r.url === '/mcp' || r.url.startsWith('/mcp/')), '/mcp est livré : passez « d0 » en mode run').toBe(false);
    const openapi = readFileSync(join(runtimeDir, 'packages/client/openapi/openapi.yaml'), 'utf8').split('\n');
    const at = openapi.findIndex((line) => line.trim() === 'operationId: createApi');
    expect(at).toBeGreaterThan(0);
    expect(openapi.slice(Math.max(0, at - 3), at).some((line) => line.includes('x-pending')), 'createApi n\'est plus « en préparation » dans l\'OpenAPI').toBe(true);
  });
});
