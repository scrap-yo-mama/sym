// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.8 : le tutoriel « Démarrage rapide » (apps/docs/content/tutoriels/quickstart.md) est rejoué sur une instance
// vierge. Les commandes `bash` du tutoriel sont extraites de la page et exécutées telles quelles (curl, openssl), dans le
// terminal que la page indique : l'étape `docker compose up` occupe le premier terminal, la suite se fait dans un second,
// qui ne reçoit RIEN du premier (seules les variables qu'on y définit existent). `docker compose up` est exécutée par un
// faux `docker` qui consigne l'appel (dossier, arguments, environnement du shell) ; l'environnement des services est ensuite
// calculé depuis runtime/docker-compose.yml (interpolation de `.env` et du shell, comme Compose), et les processus de
// l'image (migrations, `server`, `worker`, commandes de deploy/entrypoint.sh) sont lancés avec, sans Docker, sur une base
// PostgreSQL jetable. Un crochet journalise toute connexion TCP des processus : aucune ne doit sortir de la machine.
// - assert_quickstart_replayed : chaque étape rejouable du tutoriel réussit, avec la sortie annoncée par la page ;
// - assert_quickstart_terminal_boundary : le second terminal ne voit aucune variable du premier ;
// - assert_quickstart_compose_parity : le rejeu lance les services avec l'environnement que leur donnerait le fichier
//   Compose suivi par le tutoriel (noms de variables, PUBLIC_URL, port publié, mode de l'image) ;
// - assert_quickstart_no_egress : « aucune requête ne quitte l'instance hors fixtures » (16 § 8) : toutes les connexions
//   du serveur et du worker vont à la boucle locale ou à la base de test ;
// - assert_quickstart_pending_steps_declared : les étapes décrites mais non rejouées (D0, première API) attendent une
//   fonction qui n'est pas livrée ; dès qu'elle l'est, ce test échoue pour obliger à les rejouer. Le critère de 16 § 8
//   « D0 s'affiche, une première API est créée » n'est donc PAS atteint par 4.8 : il est repris par 3.1 (première API) et
//   3.2 (D0), et vérifié en recette (4.4) ; voir le test.todo assert_quickstart_d0_first_api.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { QUICKSTART_BASE_URL, parseQuickstart, type QuickstartStep } from '../apps/docs/src/quickstart.ts';
import { ROUTES } from '../apps/server/src/routes/registry.js';
import { createTestDatabase, type TestDatabase } from './helpers/pg.js';

const runtimeDir = new URL('..', import.meta.url).pathname;
const quickstart = readFileSync(join(runtimeDir, 'apps/docs/content/tutoriels/quickstart.md'), 'utf8');
const steps = parseQuickstart(quickstart);
const hook = join(runtimeDir, 'tests/helpers/net-log-hook.ts');
/** Chemins de l'image (deploy/entrypoint.sh) → fichiers construits du dépôt. */
const IMAGE_PATHS: Record<string, string> = {
  $SERVER: join(runtimeDir, 'apps/server/dist/index.js'),
  $WORKER: join(runtimeDir, 'apps/worker/dist/index.js'),
  $CLI: join(runtimeDir, 'apps/cli/dist/index.js'),
};

let tdb: TestDatabase;
/** Le dossier `runtime/` du tutoriel : il ne contient que le fichier Compose (copié), puis ce que les étapes y écrivent. */
let work: string;
/** Ce que le faux `docker` a consigné. */
let dockerCall: string;
let fakeBin: string;
let port: number;
let base: string;
const children: { name: string; proc: ChildProcess; log: () => string; netLog: string }[] = [];
const stepOutput = new Map<string, string>();
/** Environnement des services, tel que Compose le calculerait pour l'appel du tutoriel. */
const composeEnv = new Map<string, Record<string, string>>();
let serverPorts: string[] = [];

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const terminalState = (terminal: number): string => join(work, `terminal-${terminal}.sh`);

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

/**
 * Un shell par étape. Les variables exportées passent d'une étape à l'autre du MÊME terminal seulement (un fichier d'état
 * par terminal) : un second terminal démarre vide, comme dans la réalité.
 */
function bash(script: string, terminal: number, path: string = process.env['PATH'] ?? ''): { code: number; stdout: string; stderr: string } {
  const state = terminalState(terminal);
  // PATH est reposé après l'état du terminal (qui contient le PATH d'une étape précédente) : le faux `docker` doit gagner.
  const full = [`set -euo pipefail`, `[ -f ${quote(state)} ] && . ${quote(state)}`, `export PATH=${quote(path)}`, script.replaceAll(QUICKSTART_BASE_URL, base), `export -p > ${quote(state)}`].join('\n');
  const result = spawnSync('bash', ['-c', full], { cwd: work, env: { PATH: path, HOME: work, LC_ALL: 'C' }, encoding: 'utf8', timeout: 60_000 });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Valeur d'une variable dans un fichier `export -p` ; undefined si elle n'y est pas définie. */
function exportedVariable(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const result = spawnSync('bash', ['-c', `. ${quote(file)}; [ -n "\${${name}+x}" ] || exit 3; printf %s "\${${name}}"`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : undefined;
}

/** Fichier `.env` au format lu par Compose (CLÉ=valeur, guillemets facultatifs, commentaires `#`). */
function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    out[match[1] ?? ''] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Interpolation de Compose : `${NOM}`, `${NOM:-défaut}`, `${NOM-défaut}`, `$NOM`, `$$`. */
function interpolate(value: string, lookup: (name: string) => string | undefined): string {
  return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced?: string, op?: string, fallback?: string, bare?: string) => {
    if (whole === '$$') return '$';
    const current = lookup(braced ?? bare ?? '');
    if (op === ':-') return current ? current : (fallback ?? '');
    if (op === '-') return current ?? fallback ?? '';
    return current ?? '';
  });
}

type ComposeService = { image?: string; environment?: Record<string, string> | string[]; ports?: string[] };

/** Ce que fait `docker compose up` lancé dans `cwd` avec l'environnement de shell consigné : l'environnement de chaque service. */
function resolveCompose(cwd: string, shellEnv: string, overrides: Record<string, string>): { services: Record<string, ComposeService>; env: (service: string) => Record<string, string>; ports: (service: string) => string[] } {
  const compose = parseYaml(readFileSync(join(cwd, 'docker-compose.yml'), 'utf8')) as { services: Record<string, ComposeService> };
  const dotenv = readDotenv(join(cwd, '.env'));
  // Ordre de Compose : le shell l'emporte sur `.env`. Le rejeu ne fixe que le port publié (port éphémère).
  const lookup = (name: string): string | undefined => overrides[name] ?? exportedVariable(shellEnv, name) ?? dotenv[name];
  const env = (service: string): Record<string, string> => {
    const raw = compose.services[service]?.environment ?? {};
    const pairs = Array.isArray(raw) ? raw.map((entry) => entry.split(/=(.*)/s).slice(0, 2) as [string, string]) : Object.entries(raw);
    return Object.fromEntries(pairs.map(([key, value]) => [key, interpolate(String(value ?? ''), lookup)]));
  };
  const ports = (service: string): string[] => (compose.services[service]?.ports ?? []).map((p) => interpolate(String(p), lookup));
  return { services: compose.services, env, ports };
}

/** Commande lancée par l'image pour un RUNTIME_MODE (deploy/entrypoint.sh), traduite vers les fichiers du dépôt. */
function entrypointCommand(mode: string): string[] {
  const script = readFileSync(join(runtimeDir, 'deploy/entrypoint.sh'), 'utf8');
  // `role` lance le rôle sans capacité héritée ; le worker tourne sous la copie de Node à capacités de fichier de l'image
  // (`$WORKER_NODE`), remplacée ici par le Node du dépôt.
  const line = new RegExp(`^\\s*${mode}\\) role (?:node|"\\$WORKER_NODE") ([^;#]+?)\\s*;;`, 'm').exec(script);
  if (!line) throw new Error(`deploy/entrypoint.sh ne lance pas le mode ${mode}`);
  return (line[1] ?? '').split(/\s+/).map((token) => {
    const unquoted = token.replace(/^"(.*)"$/, '$1');
    return IMAGE_PATHS[unquoted] ?? unquoted;
  });
}

/** Port d'écoute de l'image (ENV PORT de l'étape d'exécution de deploy/Dockerfile). */
function imagePort(): string {
  const dockerfile = readFileSync(join(runtimeDir, 'deploy/Dockerfile'), 'utf8');
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  return /^ENV .*\bPORT=(\d+)/m.exec(runtimeStage)?.[1] ?? '';
}

function startProcess(name: string, args: string[], env: Record<string, string>): void {
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
      // Le worker démarre en parallèle du serveur : sous charge il peut ne pas avoir ouvert sa première connexion (la base)
      // quand le serveur répond déjà ; son journal réseau n'existe alors pas encore et le test d'absence de sortie échouerait.
      if (res.ok && children.every((child) => existsSync(child.netLog))) return;
    } catch {
      // pas encore à l'écoute
    }
    if (Date.now() > deadline) throw new Error(`le serveur ne répond pas sur /api/health, ou un processus n'a ouvert aucune connexion (${children.filter((c) => !existsSync(c.netLog)).map((c) => c.name).join(', ') || 'aucun'})`);
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

/** `docker compose up` : migrate d'abord, puis serveur et worker, avec l'environnement que Compose leur donnerait. */
async function composeUp(step: QuickstartStep): Promise<void> {
  // Jamais le vrai Docker : l'étape échoue si `docker` n'est pas le faux.
  const guard = `[ "$(command -v docker)" = ${quote(join(fakeBin, 'docker'))} ] || { echo 'docker réel atteint' >&2; exit 99; }`;
  const result = bash(`${guard}\n${step.script}`, step.terminal, `${fakeBin}:${process.env['PATH'] ?? ''}`);
  expect(result.code, `${step.id} : ${result.stdout}\n${result.stderr}`).toBe(0);
  const args = readFileSync(join(dockerCall, 'args'), 'utf8').split('\n').filter(Boolean);
  expect(args.slice(0, 2), 'le tutoriel lance « docker compose up »').toEqual(['compose', 'up']);
  const cwd = readFileSync(join(dockerCall, 'cwd'), 'utf8').trim();
  const compose = resolveCompose(cwd, join(dockerCall, 'env'), { SERVER_PORT: String(port) });
  for (const service of ['migrate', 'server', 'worker']) composeEnv.set(service, compose.env(service));
  serverPorts = compose.ports('server');
  const withTestDatabase = (service: string): Record<string, string> => ({ ...composeEnv.get(service), DATABASE_URL: tdb.url });

  const migrate = spawnSync('node', entrypointCommand(composeEnv.get('migrate')?.['RUNTIME_MODE'] ?? ''), { cwd: runtimeDir, env: { PATH: process.env['PATH'] ?? '', ...withTestDatabase('migrate') }, encoding: 'utf8', timeout: 90_000 });
  expect(migrate.status, `${migrate.stdout}${migrate.stderr}`).toBe(0);
  // Compose publie le port de l'image sur le port de l'hôte ; sans Docker, le serveur écoute directement sur le port de l'hôte.
  startProcess('server', entrypointCommand(composeEnv.get('server')?.['RUNTIME_MODE'] ?? ''), { ...withTestDatabase('server'), PORT: String(port) });
  startProcess('worker', entrypointCommand(composeEnv.get('worker')?.['RUNTIME_MODE'] ?? ''), withTestDatabase('worker'));
  await waitHealthy();
}

beforeAll(async () => {
  for (const dist of Object.values(IMAGE_PATHS)) expect(existsSync(dist), `${dist} : lancez pnpm build avant ce test`).toBe(true);
  tdb = await createTestDatabase('quickstart');
  work = mkdtempSync(join(tmpdir(), 'zz_test_quickstart_'));
  copyFileSync(join(runtimeDir, 'docker-compose.yml'), join(work, 'docker-compose.yml'));
  dockerCall = join(work, '.docker-call');
  fakeBin = join(work, '.bin');
  mkdirSync(dockerCall);
  mkdirSync(fakeBin);
  // Faux `docker` : échoue comme Compose hors du dossier du fichier Compose, sinon consigne l'appel et rend la main.
  writeFileSync(
    join(fakeBin, 'docker'),
    [
      '#!/bin/bash',
      `[ -f docker-compose.yml ] || { echo 'no configuration file provided: not found' >&2; exit 14; }`,
      `printf '%s\\n' "$PWD" > ${quote(join(dockerCall, 'cwd'))}`,
      `printf '%s\\n' "$@" > ${quote(join(dockerCall, 'args'))}`,
      `export -p > ${quote(join(dockerCall, 'env'))}`,
      '',
    ].join('\n'),
  );
  chmodSync(join(fakeBin, 'docker'), 0o755);
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
    test(`étape « ${step.id} » (terminal ${step.terminal})`, async () => {
      if (step.mode === 'pending') return;
      if (step.mode === 'process') return composeUp(step);
      const result = bash(step.script, step.terminal);
      expect(result.code, `${step.id} : ${result.stdout}\n${result.stderr}`).toBe(0);
      for (const text of step.expect) expect(result.stdout, `${step.id} : « ${text} » attendu`).toContain(text);
      stepOutput.set(step.id, result.stdout);
    }, 120_000);
  };
  for (const step of steps) replay(step);

  test('les secrets du tutoriel, tels que Compose les passe à l\'instance, respectent le format attendu', () => {
    const server = composeEnv.get('server') ?? {};
    expect(Buffer.from(server['MASTER_KEY'] ?? '', 'base64')).toHaveLength(32);
    expect((server['ADMIN_BOOTSTRAP_TOKEN'] ?? '').length).toBeGreaterThanOrEqual(32);
    expect(composeEnv.get('worker')?.['MASTER_KEY'], 'serveur et worker partagent la clé maîtresse').toBe(server['MASTER_KEY']);
  });

  test('la clé créée par le tutoriel n\'est affichée qu\'une fois, puis relue sans son secret ; D0 la reçoit par SCRAPYOMAMA_KEY', () => {
    const created = JSON.parse(stepOutput.get('api-key') ?? '{}') as { key?: string; id?: string };
    expect(created.key).toMatch(/^sy_live_/);
    const terminal = steps.find((s) => s.id === 'api-key')?.terminal ?? 2;
    const listed = bash(`curl -fsS -b cookies.txt ${QUICKSTART_BASE_URL}/api/api-keys`, terminal);
    expect(listed.code).toBe(0);
    expect(listed.stdout).not.toContain(created.key ?? 'absent');
    expect(exportedVariable(terminalState(terminal), 'SCRAPYOMAMA_KEY')).toBe(created.key);
  });
});

describe('assert_quickstart_terminal_boundary : le second terminal ne reçoit rien du premier', () => {
  test('les étapes après `docker compose up` se jouent dans un terminal neuf, sans les variables du premier', () => {
    const first = steps.filter((s) => s.terminal === 1);
    const second = steps.filter((s) => s.terminal === 2 && s.mode === 'run');
    expect(first.at(-1)?.mode, 'le premier terminal se termine par docker compose up').toBe('process');
    expect(second.length).toBeGreaterThan(0);
    // Ce que le premier terminal a exporté (s'il exporte quelque chose) n'existe pas dans le second, sauf redéfini là.
    const definedInSecond = new Set(second.flatMap((s) => [...s.script.matchAll(/(?:^|[\s;(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1] ?? '')));
    for (const name of ['MASTER_KEY', 'ADMIN_BOOTSTRAP_TOKEN']) {
      if (definedInSecond.has(name)) continue;
      expect(exportedVariable(terminalState(2), name), `${name} n'est pas défini dans le second terminal`).toBeUndefined();
    }
  });
});

describe('assert_quickstart_compose_parity : le rejeu lance ce que lancerait le fichier Compose du tutoriel', () => {
  test('migrate, server et worker existent, avec le mode de l\'image qui leur correspond', () => {
    expect(composeEnv.get('migrate')?.['RUNTIME_MODE']).toBe('migrate');
    expect(composeEnv.get('server')?.['RUNTIME_MODE']).toBe('server');
    expect(composeEnv.get('worker')?.['RUNTIME_MODE']).toBe('worker');
  });

  test('les trois services visent la même base, le service postgres du fichier', () => {
    const urls = ['migrate', 'server', 'worker'].map((service) => composeEnv.get(service)?.['DATABASE_URL'] ?? '');
    expect(new Set(urls).size).toBe(1);
    expect(new URL(urls[0] ?? 'x:').hostname).toBe('postgres');
  });

  test('le port publié et PUBLIC_URL désignent l\'adresse que le tutoriel interroge', () => {
    expect(serverPorts).toEqual([`${port}:${imagePort()}`]);
    expect(composeEnv.get('server')?.['PUBLIC_URL']).toBe(base);
  });

  test('le serveur et le worker reçoivent les secrets du tutoriel, non vides', () => {
    for (const name of ['MASTER_KEY', 'ADMIN_BOOTSTRAP_TOKEN']) expect(composeEnv.get('server')?.[name], `server : ${name}`).toBeTruthy();
    expect(composeEnv.get('worker')?.['MASTER_KEY'], 'worker : MASTER_KEY').toBeTruthy();
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

  test('leurs routes ne sont pas encore livrées : sinon, il faut les rejouer (reprise : 3.1 première API, 3.2 D0)', () => {
    const delivered = (method: string, url: string): boolean => ROUTES.some((r) => r.method === method && r.url === url);
    expect(delivered('POST', '/api/apis'), 'POST /api/apis est livrée (3.1) : passez « first-api » en mode run et remplacez le test.todo assert_quickstart_d0_first_api').toBe(false);
    expect(ROUTES.some((r) => r.url === '/mcp' || r.url.startsWith('/mcp/')), '/mcp est livré (3.2) : passez « d0 » en mode run et remplacez le test.todo assert_quickstart_d0_first_api').toBe(false);
    const openapi = readFileSync(join(runtimeDir, 'packages/client/openapi/openapi.yaml'), 'utf8').split('\n');
    const at = openapi.findIndex((line) => line.trim() === 'operationId: createApi');
    expect(at).toBeGreaterThan(0);
    expect(openapi.slice(Math.max(0, at - 3), at).some((line) => line.includes('x-pending')), 'createApi n\'est plus « en préparation » dans l\'OpenAPI').toBe(true);
  });
});
