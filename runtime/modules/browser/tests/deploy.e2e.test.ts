// SPDX-License-Identifier: AGPL-3.0-only
// Gabarits Compose démarrés pour de vrai sur l'image construite (cdc/sym-browser 06 tâche 5.1, 04b P13, 04f F8, 08 étapes
// 1, 18 et 25). Joué par l'étape image de ci:local (`SYMB_E2E_IMAGE=<image>`), sauté sinon : il faut Docker et l'image.
//   - cold_install_two_nodes : mode all à froid (/readyz 200 en moins de 10 min, mesure écrite), puis passerelle + node-1,
//     et node-2 ajouté à chaud pendant qu'un sondeur interroge /readyz de la passerelle toutes les 100 ms : 0 réponse non 200.
//   - assert_standalone_instance : instance seule, réseau Docker interne (aucune sortie), aucun service ni variable de SYM ;
//     /readyz 200 et, lues dans /proc/net/tcp du conteneur, ses seules connexions vont vers sa base ou restent locales.
// Chaque projet Compose porte un nom unique et est détruit avec ses volumes (`down -v`) ; aucun processus n'est tué à la main.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';

const IMAGE = process.env.SYMB_E2E_IMAGE;
const DEPLOY = join(MODULE_ROOT, 'deploy');
const COLD_INSTALL_BUDGET_MS = 10 * 60_000;

type Project = { name: string; file: string; env: Record<string, string> };
const projects: Project[] = [];

function secrets(): Record<string, string> {
  return {
    SYMB_IMAGE: IMAGE ?? '',
    MASTER_KEY: randomBytes(32).toString('base64'),
    NODE_TOKEN: randomBytes(32).toString('base64url'),
    POSTGRES_PASSWORD: randomBytes(18).toString('base64url'),
    // Clé d'échange de test, générée ici : format symb_ (tâche 2.1).
    SYMB_BOOTSTRAP_API_KEY: `symb_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12)}_${randomBytes(32).toString('base64url')}`,
    // Aucun port publié pendant les tests : tout passe par `compose exec`.
    SYMB_BIND: '127.0.0.1:',
  };
}

function compose(project: Project, args: string[], timeoutMs = 600_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('docker', ['compose', '-p', project.name, '-f', join(DEPLOY, project.file), ...args], {
    cwd: DEPLOY,
    env: { ...process.env, ...project.env },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function project(file: string): Project {
  const p = { name: `symb-e2e-${randomBytes(4).toString('hex')}`, file, env: secrets() };
  projects.push(p);
  return p;
}

/** Corps de /readyz lu dans le conteneur (pas de port publié). */
function readyz(p: Project, service: string): { status: number; body: Record<string, unknown> } {
  const script = "fetch('http://127.0.0.1:3000/readyz').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()}))).catch(()=>console.log('{\"status\":0,\"body\":{}}'))";
  const out = compose(p, ['exec', '-T', service, 'node', '-e', script], 60_000);
  try {
    return JSON.parse(out.stdout.trim().split('\n').at(-1) ?? '') as { status: number; body: Record<string, unknown> };
  } catch {
    return { status: 0, body: {} };
  }
}

async function waitReady(p: Project, service: string, budgetMs: number): Promise<number> {
  const started = Date.now();
  for (;;) {
    const r = readyz(p, service);
    if (r.status === 200) return Date.now() - started;
    if (Date.now() - started > budgetMs) throw new Error(`${service} : /readyz ${r.status} après ${budgetMs} ms : ${JSON.stringify(r.body)}\n${compose(p, ['logs', '--tail', '80']).stdout}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function up(p: Project, services: string[] = []): void {
  const out = compose(p, ['up', '-d', ...services]);
  if (out.status !== 0) throw new Error(`compose up : ${out.stderr}`);
}

afterAll(() => {
  for (const p of projects.splice(0)) compose(p, ['down', '-v', '--timeout', '30']);
});

describe.skipIf(!IMAGE)('gabarits Compose sur l’image construite', () => {
  test('cold_install_two_nodes : mode all à froid en moins de 10 min ; 2e nœud ajouté sans interruption de la passerelle', async () => {
    const all = project('compose.yaml');
    const t0 = Date.now();
    up(all);
    const coldMs = await waitReady(all, 'sym-browser', COLD_INSTALL_BUDGET_MS);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(COLD_INSTALL_BUDGET_MS);
    const checks = readyz(all, 'sym-browser').body.checks as Record<string, string>;
    expect(checks).toMatchObject({ database: 'ok', schema: 'ok', nodes: 'ok', heartbeat: 'ok', chromium: 'ok' });
    compose(all, ['down', '-v', '--timeout', '30']);

    const multi = project('compose.nodes.yaml');
    up(multi);
    await waitReady(multi, 'gateway', COLD_INSTALL_BUDGET_MS);
    await waitReady(multi, 'node-1', COLD_INSTALL_BUDGET_MS);
    // Sondeur dans le conteneur de la passerelle : /readyz toutes les 100 ms jusqu'à ce que le fichier stop existe.
    const poller = "const fs=require('fs');const s={total:0,bad:[]};(async()=>{while(!fs.existsSync('/tmp/stop')){const r=await fetch('http://127.0.0.1:3000/readyz').then(x=>x.status,()=>0);s.total++;if(r!==200)s.bad.push(r);await new Promise(z=>setTimeout(z,100));}console.log(JSON.stringify(s));})()";
    const polling = new Promise<string>((resolve) => {
      const child = spawn('docker', ['compose', '-p', multi.name, '-f', join(DEPLOY, multi.file), 'exec', '-T', 'gateway', 'node', '-e', poller], { cwd: DEPLOY, env: { ...process.env, ...multi.env } });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.on('close', () => resolve(out));
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    compose(multi, ['--profile', 'scale', 'up', '-d', 'node-2']);
    await waitReady(multi, 'node-2', COLD_INSTALL_BUDGET_MS);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    compose(multi, ['exec', '-T', 'gateway', 'node', '-e', "require('fs').writeFileSync('/tmp/stop','')"]);
    const stats = JSON.parse((await polling).trim()) as { total: number; bad: number[] };
    expect(stats.total).toBeGreaterThan(10);
    expect(stats.bad).toEqual([]);
    const nodes = compose(multi, ['exec', '-T', 'postgres', 'psql', '-U', 'symb', '-d', 'symb', '-At', '-c', 'SELECT id || \':\' || state FROM nodes ORDER BY id']).stdout.trim().split('\n');
    expect(nodes).toEqual(['node-1:ready', 'node-2:ready']);

    const report = join(MODULE_ROOT, 'deploy', 'mesures');
    mkdirSync(report, { recursive: true });
    writeFileSync(
      join(report, 'installation-a-froid.json'),
      `${JSON.stringify({ date: new Date().toISOString(), image: IMAGE, modeAllReadyMs: coldMs, modeAllTotalMs: elapsed, budgetMs: COLD_INSTALL_BUDGET_MS, secondNodeGatewayProbes: stats.total, secondNodeGatewayNon200: stats.bad.length, note: 'image déjà construite ; base, migrations, nœud et Chromium chaud à froid' }, null, 2)}\n`,
    );
  });

  test('assert_standalone_instance : instance seule, réseau sans sortie, aucun service SYM ; seules connexions vers sa base', async () => {
    const solo = project('compose.standalone.yaml');
    up(solo);
    await waitReady(solo, 'sym-browser', COLD_INSTALL_BUDGET_MS);
    const services = compose(solo, ['config', '--services']).stdout.trim().split('\n').sort();
    expect(services).toEqual(['postgres', 'sym-browser']);
    const env = compose(solo, ['exec', '-T', 'sym-browser', 'env']).stdout;
    expect(env).not.toMatch(/^(BROWSER_|SYM_)/m);
    // Adresse de la base vue du conteneur, puis connexions TCP établies (état 01) lues dans /proc/net/tcp*.
    const dbIp = compose(solo, ['exec', '-T', 'sym-browser', 'getent', 'hosts', 'postgres']).stdout.trim().split(/\s+/)[0] ?? '';
    const table = compose(solo, ['exec', '-T', 'sym-browser', 'cat', '/proc/net/tcp', '/proc/net/tcp6']).stdout;
    const remotes = table
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols[3] === '01')
      .map((cols) => decodeAddress(cols[2] ?? ''));
    expect(remotes.length).toBeGreaterThan(0);
    for (const remote of remotes) expect(remote.ip === dbIp || remote.ip === '127.0.0.1' || remote.ip === '::1', JSON.stringify(remote)).toBe(true);
    // Aucune sortie possible : le réseau Compose est interne.
    const out = compose(solo, ['exec', '-T', 'sym-browser', 'node', '-e', "fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).then(()=>console.log('sortie'),()=>console.log('bloquée'))"]).stdout.trim();
    expect(out).toBe('bloquée');
  });

  test.todo('assert_standalone_instance : session pilotée par le SDK et Puppeteer puis ended (REST monté, relais WSS 2.3, arrêt 2.7)');
});

/** Adresse distante d'une ligne de /proc/net/tcp(6) : hexadécimal petit-boutiste par mot de 32 bits. */
function decodeAddress(field: string): { ip: string; port: number } {
  const [hex = '', portHex = '0'] = field.split(':');
  const port = Number.parseInt(portHex, 16);
  if (hex.length === 8) return { ip: (hex.match(/../g) ?? []).reverse().map((b) => Number.parseInt(b, 16)).join('.'), port };
  const words = (hex.match(/.{8}/g) ?? []).map((w) => (w.match(/../g) ?? []).reverse().join(''));
  const full = words.join('');
  if (full.startsWith('00000000000000000000ffff')) return { ip: (full.slice(24).match(/../g) ?? []).map((b) => Number.parseInt(b, 16)).join('.'), port };
  if (full === '00000000000000000000000000000001') return { ip: '::1', port };
  return { ip: (full.match(/.{4}/g) ?? []).join(':'), port };
}
