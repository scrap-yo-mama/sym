// SPDX-License-Identifier: AGPL-3.0-only
// Gabarits Compose démarrés pour de vrai sur l'image construite (cdc/sym-browser 06 tâche 5.1, 04b P13, 04f F8, 08 étapes
// 1, 18 et 25). Joué par l'étape image de ci:local (`SYMB_E2E_IMAGE=<image>`), sauté sinon : il faut Docker et l'image.
//   - cold_install_two_nodes : mode all à froid (/readyz 200 en moins de 10 min, mesure écrite), puis passerelle + node-1,
//     et node-2 ajouté à chaud pendant qu'un sondeur interroge /readyz de la passerelle toutes les 100 ms : 0 réponse non 200.
//   - assert_standalone_instance : instance seule, réseau Docker interne (aucune sortie), aucun service ni variable de SYM ;
//     /readyz 200 et, lues dans /proc/net/tcp du conteneur, ses seules connexions vont vers sa base ou restent locales ;
//     puis (F8, F-20261002-01) une session pilotée de bout en bout DANS ce réseau fermé : REST /v1, Playwright
//     connectOverCDP et client CDP brut (forme de Puppeteer `connect({browserWSEndpoint})`, Puppeteer n'étant pas au
//     catalogue), libération par DELETE et par `Browser.close`, sessions ended, aucun répertoire de session restant.
//   - sdk_and_cdp_on_image : mode all publié sur un port libre de 127.0.0.1, site de test sur le réseau Compose
//     (tests/compose.e2e-site.yaml) ; depuis l'hôte : l'exemple du README du SDK (shared, `connect` natif), le SDK
//     `connectCDP` (dedicated) et le client CDP brut, au travers du relais WSS de l'image et de l'egress de chaque session.
//   - quickstart_replayed_on_image (tâche 3.8) : l'étape 1 du quickstart (docs/en/quickstart.md) exécutée par bash avec
//     l'image locale, des noms et un port uniques, puis les étapes 3 à 5 extraites et exécutées telles quelles par node.
// Chaque projet Compose porte un nom unique et est détruit avec ses volumes (`down -v`) ; les conteneurs du quickstart
// (préfixe zz_test_) sont retirés par `docker rm -f` ; aucun processus n'est tué à la main.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';
import { SymBrowser } from '../packages/sdk/src/index.ts';
import { ensureSdkBuilt, SDK_DIR } from '../packages/sdk/src/testing/build.ts';
import { readmeExample } from '../packages/sdk/src/testing/readme.ts';
import { codeBlocks, extractQuickstart } from '../scripts/docs-lib.ts';

const IMAGE = process.env.SYMB_E2E_IMAGE;
const DEPLOY = join(MODULE_ROOT, 'deploy');
const COLD_INSTALL_BUDGET_MS = 10 * 60_000;

type Project = { name: string; files: string[]; env: Record<string, string> };
const E2E_SITE = join(MODULE_ROOT, 'tests', 'compose.e2e-site.yaml');
const SITE_TITLE = 'SYM Browser fixtures';
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

function compose(project: Project, args: string[], timeoutMs = 600_000, input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('docker', ['compose', '-p', project.name, ...project.files.flatMap((f) => ['-f', f]), ...args], {
    cwd: DEPLOY,
    env: { ...process.env, ...project.env },
    encoding: 'utf8',
    timeout: timeoutMs,
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function project(file: string, extra: string[] = []): Project {
  const p = { name: `symb-e2e-${randomBytes(4).toString('hex')}`, files: [join(DEPLOY, file), ...extra], env: secrets() };
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
  // `--profile scale` : sans lui, `down` ignore node-2 (service au profil scale) et le laisserait tourner.
  for (const p of projects.splice(0)) compose(p, ['--profile', 'scale', 'down', '-v', '--timeout', '30']);
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
      const child = spawn('docker', ['compose', '-p', multi.name, ...multi.files.flatMap((f) => ['-f', f]), 'exec', '-T', 'gateway', 'node', '-e', poller], { cwd: DEPLOY, env: { ...process.env, ...multi.env } });
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

  test('assert_standalone_instance (F8) : dans le réseau fermé, session pilotée (REST, connectOverCDP, CDP brut) puis ended', async () => {
    const solo = project('compose.standalone.yaml');
    up(solo);
    await waitReady(solo, 'sym-browser', COLD_INSTALL_BUDGET_MS);
    // Client DANS le conteneur (le réseau interne n'a ni sortie ni port publié) : playwright-core et ws de l'image.
    const run = compose(solo, ['exec', '-T', 'sym-browser', 'node', '--input-type=module', '-'], 300_000, STANDALONE_CLIENT);
    let report: Record<string, unknown> = {};
    try {
      report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
    } catch {
      // rapport illisible : l'assertion suivante affiche la sortie et les journaux
    }
    expect(report, `${run.stdout}\n${run.stderr}\n${compose(solo, ['logs', '--tail', '80']).stdout}`).toMatchObject({
      created: { state: 'running', type: 'dedicated' },
      title: 'F8 autonome',
      released: { state: 'ended', endReason: 'released' },
      rawCdp: 42,
      closedByBrowserClose: { state: 'ended', endReason: 'released' },
    });
    expect(String(report['cdpUrl'])).toMatch(/^ws:\/\/127\.0\.0\.1:3000\/v1\/sessions\/[0-9a-f-]{36}\/cdp\?token=symt_/);
    // Destruction complète (BINV3) : aucun répertoire de session, aucun Chromium de session encore vivant.
    expect(await until(() => residue(solo, 'sym-browser'), (r) => r.dirs === 0 && r.chromium === 0)).toEqual({ dirs: 0, chromium: 0 });
  }, 900_000);

  test('sdk_and_cdp_on_image : SDK (README shared, connectCDP dedicated) et client CDP brut depuis l’hôte, au travers de l’image', async () => {
    const all = project('compose.yaml', [E2E_SITE]);
    up(all);
    await waitReady(all, 'sym-browser', COLD_INSTALL_BUDGET_MS);
    const url = `http://${compose(all, ['port', 'sym-browser', '3000']).stdout.trim().split('\n')[0] ?? ''}`;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const apiKey = all.env['SYMB_BOOTSTRAP_API_KEY'] ?? '';
    const site = 'http://site-a.test:8080/';

    // 1. Exemple du README du SDK, tel quel, dans un process Node (session shared, connect natif, libération).
    ensureSdkBuilt();
    const runDir = join(SDK_DIR, `.e2e-run-${randomBytes(3).toString('hex')}`);
    mkdirSync(runDir, { recursive: true });
    try {
      writeFileSync(join(runDir, 'example.mjs'), readmeExample());
      const example = spawnSync(process.execPath, ['example.mjs'], { cwd: runDir, env: { ...process.env, SYMB_URL: url, SYMB_API_KEY: apiKey, SYMB_DEMO_URL: site }, encoding: 'utf8', timeout: 180_000 });
      expect(example.status, `${example.stdout}\n${example.stderr}\n${compose(all, ['logs', '--tail', '80', 'sym-browser']).stdout}`).toBe(0);
      expect(example.stdout).toContain(SITE_TITLE);
      expect(example.stdout).toContain('ended released');
      expect(example.stdout).not.toContain(apiKey);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }

    // 2. SDK, session dedicated par défaut : connectCDP au travers du relais WSS de l'image, page du site, libération.
    const symb = new SymBrowser({ url, apiKey, releaseOnExit: false });
    let id: string;
    {
      await using session = await symb.sessions.create({ egress: { allowedHosts: ['site-a.test'], ports: [8080] }, metadata: { e2e: 'sdk' } });
      id = session.id;
      expect(session.type).toBe('dedicated');
      expect(session.connectUrls?.cdp?.startsWith(`${url.replace(/^http/, 'ws')}/v1/sessions/${id}/cdp?token=symt_`)).toBe(true);
      const browser = await symb.connectCDP(session);
      const page = await browser.contexts()[0]!.newPage();
      await page.goto(site);
      expect(await page.title()).toBe(SITE_TITLE);
      await page.close();
    }
    expect(await symb.sessions.get(id)).toMatchObject({ state: 'ended', endReason: 'released' });

    // 3. Client CDP brut (forme de Puppeteer `connect({browserWSEndpoint})`) : cible, titre, puis Browser.close libère.
    const auth = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    const response = await fetch(`${url}/v1/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ egress: { allowedHosts: ['site-a.test'], ports: [8080] } }) });
    const created = (await response.json()) as { id: string; connectUrls: { cdp: string } };
    expect(response.status, JSON.stringify(created)).toBe(201);
    const cdp = await rawCdp(created.connectUrls.cdp);
    const { targetId } = (await cdp.send('Target.createTarget', { url: site })) as { targetId: string };
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    let title = '';
    for (let i = 0; i < 100 && title !== SITE_TITLE; i += 1) {
      title = ((await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)) as { result: { value: string } }).result.value;
      if (title !== SITE_TITLE) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(title).toBe(SITE_TITLE);
    cdp.ws.send(JSON.stringify({ id: 9999, method: 'Browser.close' }));
    const ended = await until(
      async () => (await (await fetch(`${url}/v1/sessions/${created.id}`, { headers: auth })).json()) as { state: string; endReason?: string },
      (s) => s.state === 'ended',
    );
    cdp.ws.terminate();
    expect(ended).toMatchObject({ state: 'ended', endReason: 'released' });
    await symb.close();
    expect(await until(() => residue(all, 'sym-browser'), (r) => r.dirs === 0 && r.chromium === 0)).toEqual({ dirs: 0, chromium: 0 });
  }, 900_000);

  test('quickstart_replayed_on_image : étape 1 du quickstart (bash) sur l’image construite, puis étapes 3 à 5 telles quelles', async () => {
    const page = readFileSync(join(MODULE_ROOT, 'docs/en/quickstart.md'), 'utf8');
    const step1 = codeBlocks(page).find((b) => b.code.includes('docker network create'))?.code ?? '';
    expect(step1).not.toBe('');
    const tag = `zz_test_qs_${randomBytes(3).toString('hex')}`;
    const port = await freePort();
    const names = { net: tag, db: `${tag}_db`, app: `${tag}_app`, site: `${tag}_site` };
    // Substitutions de la CI, chacune attendue dans la page (sinon la page a changé et ce rejeu doit suivre).
    const substitutions: Array<[string, string]> = [
      ['curl -fsSLO https://raw.githubusercontent.com/scrap-yo-mama/sym-browser/main/deploy/seccomp-chromium.json', `cp '${join(DEPLOY, 'seccomp-chromium.json')}' .`],
      ['docker network create symb', `docker network create ${names.net}`],
      ['--name symb-db --network symb', `--name ${names.db} --network ${names.net}`],
      ['@symb-db:', `@${names.db}:`],
      ['--name sym-browser --network symb -p 127.0.0.1:3000:3000', `--name ${names.app} --network ${names.net} -p 127.0.0.1:${port}:3000`],
      // Site de test du rejeu, joignable par l'egress (seul ajout à la commande de la page).
      ['-e SYMB_MODE=all', '-e SYMB_MODE=all -e SYMB_PRIVATE_HOSTS=site-a.test'],
      ['ghcr.io/scrap-yo-mama/sym-browser:1', IMAGE ?? ''],
      ['export SYMB_URL=http://localhost:3000', `export SYMB_URL=http://localhost:${port}`],
    ];
    let script = step1;
    for (const [from, to] of substitutions) {
      expect(script.includes(from), from).toBe(true);
      script = script.split(from).join(to);
    }
    const printEnv = 'printf "\\nSYMB_API_KEY=%s\\nSYMB_URL=%s\\n" "$SYMB_API_KEY" "$SYMB_URL"';
    const dir = mkdtempSync(join(MODULE_ROOT, '.quickstart-image-'));
    const logs = (): string => {
      const out = spawnSync('docker', ['logs', '--tail', '60', names.app], { encoding: 'utf8' });
      return `${out.stdout}${out.stderr}`;
    };
    try {
      const step = spawnSync('bash', ['-e', '-c', `${script}\n${printEnv}\n`], { cwd: dir, encoding: 'utf8', timeout: COLD_INSTALL_BUDGET_MS });
      expect(step.status, `${step.stdout}\n${step.stderr}\n${logs()}`).toBe(0);
      const env = Object.fromEntries([...step.stdout.matchAll(/^(SYMB_API_KEY|SYMB_URL)=(.+)$/gm)].map((m) => [m[1] ?? '', m[2] ?? '']));
      expect(env['SYMB_URL']).toBe(`http://localhost:${port}`);
      const site = spawnSync('docker', ['run', '-d', '--name', names.site, '--network', names.net, '--network-alias', 'site-a.test', IMAGE ?? '', 'node', '-e', SITE_SERVER], { encoding: 'utf8' });
      expect(site.status, site.stderr).toBe(0);

      writeFileSync(join(dir, 'quickstart.mjs'), extractQuickstart(page).code);
      const replay = () => spawnSync(process.execPath, ['quickstart.mjs'], { cwd: dir, env: { ...process.env, ...env, TARGET_URL: 'http://site-a.test:8080/' }, encoding: 'utf8', timeout: 180_000 });
      // Le site démarre en quelques secondes : le quickstart est rejoué tel quel tant que la page n'est pas joignable (60 s).
      let run = replay();
      for (let i = 0; i < 12 && run.status !== 0 && /net::ERR_/.test(run.stderr); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        run = replay();
      }
      expect(run.status, `${run.stdout}\n${run.stderr}\n${logs()}`).toBe(0);
      expect(run.stderr).toBe('');
      const id = /^session ([0-9a-f-]{36}): running \(dedicated\)$/m.exec(run.stdout)?.[1];
      expect(id, run.stdout).toBeDefined();
      expect(run.stdout).toContain(`title: ${SITE_TITLE}`);
      expect(run.stdout).toContain(`session ${id ?? ''}: ended (released)`);
      const state = spawnSync('docker', ['exec', names.db, 'psql', '-U', 'postgres', '-d', 'sym_browser', '-At', '-c', `SELECT state || ':' || end_reason FROM sessions WHERE id = '${id ?? ''}'`], { encoding: 'utf8' });
      expect(state.stdout.trim()).toBe('ended:released');
    } finally {
      for (const name of [names.site, names.app, names.db]) spawnSync('docker', ['rm', '-f', '-v', name], { encoding: 'utf8' });
      spawnSync('docker', ['network', 'rm', names.net], { encoding: 'utf8' });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 900_000);
});

/** Site de test du quickstart, servi par le Node de l'image (même page que tests/compose.e2e-site.yaml). */
const SITE_SERVER = "require('node:http').createServer((q, s) => s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>SYM Browser fixtures</title><h1>site-a</h1>')).listen(8080)";

/**
 * Client du test F8, exécuté par le Node de l'image DANS le réseau fermé : REST /v1 avec la clé d'échange, Playwright
 * connectOverCDP (playwright-core de l'image), puis client CDP brut sur `ws` (forme de Puppeteer) libéré par Browser.close.
 * Dernière ligne : rapport JSON.
 */
const STANDALONE_CLIENT = String.raw`
import { createRequire } from 'node:module';
const { chromium } = createRequire('/app/modules/browser/apps/node/package.json')('playwright-core');
const { WebSocket } = createRequire('/app/modules/browser/apps/gateway/package.json')('ws');
const base = 'http://127.0.0.1:3000';
const headers = { authorization: 'Bearer ' + process.env.SYMB_BOOTSTRAP_API_KEY, 'content-type': 'application/json' };
const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json();
  if (res.status >= 300) throw new Error(method + ' ' + path + ' : ' + res.status + ' ' + JSON.stringify(json));
  return json;
};
const report = {};
const a = await call('POST', '/v1/sessions', { timeoutSeconds: 120, metadata: { e2e: 'f8' } });
report.created = { state: a.state, type: a.type };
report.cdpUrl = a.connectUrls.cdp;
const browser = await chromium.connectOverCDP(a.connectUrls.cdp);
const page = await (browser.contexts()[0] ?? (await browser.newContext())).newPage();
await page.setContent('<title>F8 autonome</title><p>ok</p>');
report.title = await page.title();
const released = await call('DELETE', '/v1/sessions/' + a.id);
report.released = { state: released.state, endReason: released.endReason };
await browser.close().catch(() => undefined);

const b = await call('POST', '/v1/sessions', { timeoutSeconds: 120 });
const ws = new WebSocket(b.connectUrls.cdp);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
let id = 0;
const pending = new Map();
ws.on('message', (data) => { const m = JSON.parse(data.toString()); if (m.id !== undefined) pending.get(m.id)?.(m); });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  id += 1;
  pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {})));
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const attached = await send('Target.attachToTarget', { targetId, flatten: true });
report.rawCdp = (await send('Runtime.evaluate', { expression: '6 * 7', returnByValue: true }, attached.sessionId)).result.value;
ws.send(JSON.stringify({ id: 9999, method: 'Browser.close' }));
let state = await call('GET', '/v1/sessions/' + b.id);
for (let i = 0; i < 100 && state.state !== 'ended'; i += 1) {
  await new Promise((r) => setTimeout(r, 200));
  state = await call('GET', '/v1/sessions/' + b.id);
}
ws.terminate();
report.closedByBrowserClose = { state: state.state, endReason: state.endReason };
console.log(JSON.stringify(report));
`;

/** Restes dans le conteneur : répertoires `/data/sessions/*`, processus lancés pour une session (`/data/sessions/` dans la ligne de commande, la sonde elle-même exclue). */
const RESIDUE_PROBE = String.raw`const fs=require('fs');let d=[];try{d=fs.readdirSync('/data/sessions')}catch{}let c=0;for(const p of fs.readdirSync('/proc')){if(!/^\d+$/.test(p)||p===String(process.pid))continue;try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes('/data/sessions/'))c++}catch{}}console.log(JSON.stringify({dirs:d.length,chromium:c}))`;

function residue(p: Project, service: string): { dirs: number; chromium: number } {
  try {
    return JSON.parse(compose(p, ['exec', '-T', service, 'node', '-e', RESIDUE_PROBE], 60_000).stdout.trim().split('\n').at(-1) ?? '') as { dirs: number; chromium: number };
  } catch {
    return { dirs: -1, chromium: -1 };
  }
}

/** Valeur de `read` dès que `ok` la valide (au plus `ms`) ; la dernière lue sinon. */
async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    value = await read();
  }
  return value;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Client CDP brut (forme de Puppeteer `connect({browserWSEndpoint})`) : commandes numérotées, réponses attendues. */
async function rawCdp(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  let id = 0;
  const pending = new Map<number, (message: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  ws.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString()) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      id += 1;
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {})));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, send };
}

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
