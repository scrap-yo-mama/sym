// SPDX-License-Identifier: AGPL-3.0-only
// assert_sandbox_image_privileges (INV7, 08 § 3, constat F-20261001-R01) : l'IMAGE construite, démarrée comme Render la
// démarre (no-new-privileges, capacités réduites à CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, SYS_CHROOT, sans KILL ni
// SETPCAP ni SETFCAP), puis comme un Docker classique (capacités par défaut, sans no-new-privileges) :
//   (a) le worker démarre, sonde d'isolation verte ;
//   (b) un enfant ordinaire du worker (sh, Chromium) n'a AUCUNE capacité ;
//   (c) l'enfant du bac à sable tourne sous l'uid dédié, sans capacité, et /proc/1/environ comme /proc/<worker>/environ lui
//       sont refusés (EACCES) ;
//   (d) idem sans no-new-privileges ;
//   (e) RUNTIME_MODE=all : le server descend sans capacité, le worker est lancé comme en mode worker ;
//   (f) `runtime migrate` (pré-déploiement, commande passée au point d'entrée) tourne en pwuser sans capacité ;
//   (g) RUNTIME_MODE=server : aucun processus, PID 1 compris, n'a de capacité ; la sonde de santé du compose, lancée en
//       root par Docker (USER de l'image), descend sur pwuser sans capacité ;
// plus : aucun processus du conteneur ne reste root, tous sous no-new-privileges, et SIGTERM (docker stop) arrête
// proprement le worker (tini relaie le signal ; sous Render, un PID 1 root sans CAP_KILL ne pourrait pas signaler un
// processus de pwuser). Revue de F-20261001-R01 : le worker n'a cap_setuid,cap_setgid qu'en PERMIS (un process.setuid(0)
// échoue), un processus détaché par un enfant ne survit pas au balayage de fin de run, rien de ce qu'exécute pwuser n'est
// modifiable par l'uid dédié, et un démarrage sous un uid imposé pose quand même no-new-privileges.
// Lourd (construction de l'image, PostgreSQL, Chromium) : projet Vitest `image` (`pnpm test:image`), joué par `pnpm ci:local`.
// RUNTIME_IMAGE_UNDER_TEST=<image locale> évite la construction (l'image n'est jamais poussée).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const runtimeDir = new URL('../..', import.meta.url).pathname;
const run = randomBytes(4).toString('hex');
const builtTag = `zz_test_image_privileges:${run}`;
const network = `zz_test_img_${run}`;
const pgName = `zz_test_img_pg_${run}`;
// Même PostgreSQL que deploy/docker-compose.prod.yml.
const PG_IMAGE = 'postgres:16@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54';
const PG_PASSWORD = randomBytes(12).toString('hex');
const MASTER_KEY = randomBytes(32).toString('base64');
const ADMIN_BOOTSTRAP_TOKEN = randomBytes(32).toString('base64');
const DATABASE_URL = `postgres://runtime:${PG_PASSWORD}@${pgName}:5432/runtime`;

/** Capacités du conteneur de Render (bounding 0x400cb) et no-new-privileges. */
const RENDER = [
  '--security-opt', 'no-new-privileges',
  '--cap-drop', 'ALL',
  ...['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'SYS_CHROOT'].flatMap((c) => ['--cap-add', c]),
];
const PROFILES = [
  { name: 'Render (no-new-privileges, capacités réduites)', flags: RENDER, nnp: true },
  { name: 'Docker classique (capacités par défaut)', flags: [] as string[], nnp: false },
] as const;

const NONE = '0000000000000000';
/** cap_setuid (7) et cap_setgid (6). */
const SETID = '00000000000000c0';
const PWUSER = 1001;
const SANDBOX_UID = 1500;

let image = process.env['RUNTIME_IMAGE_UNDER_TEST'] ?? '';
let scratch = '';
const containers: string[] = [];

function docker(args: string[], timeoutMs = 120_000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function dockerOk(args: string[], timeoutMs?: number): string {
  const r = docker(args, timeoutMs);
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} … : code ${r.status}\n${r.stderr.slice(-2000)}`);
  return r.stdout;
}

async function until(what: string, check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

type Proc = { pid: number; ppid: number; name: string; uid: number; inh: string; prm: string; eff: string; amb: string; nnp: number; cmd: string };

/** /proc/<pid>/status et cmdline de chaque processus du conteneur, lus par un `docker exec` sous nobody (65534), exclu. */
function processes(container: string): Proc[] {
  const script =
    'for d in /proc/[0-9]*; do s=$(cat $d/status 2>/dev/null) || continue; ' +
    'c=$(tr "\\0\\t\\n" "   " < $d/cmdline 2>/dev/null); printf "%s\\t%s\\n" "$c" "$(printf "%s" "$s" | tr "\\n\\t" "| ")"; done';
  const out = dockerOk(['exec', '-u', '65534', container, 'sh', '-c', script]);
  const procs: Proc[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [cmd = '', raw = ''] = line.split('\t');
    const field = (k: string) => new RegExp(`(?:^|\\|)${k}:\\s*([^|]*)`).exec(raw)?.[1]?.trim() ?? '';
    const proc: Proc = {
      pid: Number(field('Pid')),
      ppid: Number(field('PPid')),
      name: field('Name'),
      uid: Number(field('Uid').split(/\s+/)[0]),
      inh: field('CapInh'),
      prm: field('CapPrm'),
      eff: field('CapEff'),
      amb: field('CapAmb'),
      nnp: Number(field('NoNewPrivs')),
      cmd: cmd.trim(),
    };
    if (proc.uid !== 65534) procs.push(proc);
  }
  return procs;
}

const caps = (p: Pick<Proc, 'inh' | 'prm' | 'eff' | 'amb'>) => ({ inh: p.inh, prm: p.prm, eff: p.eff, amb: p.amb });
const noCaps = { inh: NONE, prm: NONE, eff: NONE, amb: NONE };
/** Worker : cap_setuid,cap_setgid PERMISES seulement (node-worker =p) ; sandbox-launch les rend effectives à son exec. */
const workerCaps = { inh: NONE, prm: SETID, eff: NONE, amb: NONE };
/** tini et le shell superviseur d'un démarrage worker/all : ensemble ambient, retiré au lancement de chaque rôle. */
const ambientCaps = { inh: SETID, prm: SETID, eff: SETID, amb: SETID };

/** Sonde de santé du server dans deploy/docker-compose.prod.yml (forme exec : ["CMD", …]). */
function composeHealthcheck(): string[] {
  const compose = parse(readFileSync(join(runtimeDir, 'deploy/docker-compose.prod.yml'), 'utf8')) as { services: Record<string, { healthcheck?: { test?: string[] } }> };
  const test_ = compose.services['server']?.healthcheck?.test ?? [];
  if (test_[0] !== 'CMD') throw new Error(`sonde de santé du server : forme exec ["CMD", …] attendue (${JSON.stringify(test_)})`);
  return test_.slice(1);
}

/** Uid, capacités et no-new-privileges d'une sortie `grep … /proc/<pid>/status`. */
function identity(stdout: string) {
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(stdout)?.[1]?.trim();
  return { uid: Number(field('Uid')?.split(/\s+/)[0]), inh: field('CapInh'), prm: field('CapPrm'), eff: field('CapEff'), amb: field('CapAmb'), nnp: Number(field('NoNewPrivs')) };
}

function startContainer(name: string, flags: readonly string[], env: Record<string, string>, extra: string[] = []): string {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  dockerOk(['run', '-d', '--name', name, '--network', network, '--shm-size', '512m', ...flags, ...envArgs, ...extra, image]);
  containers.push(name);
  return name;
}

const logsOf = (name: string) => {
  const r = docker(['logs', name]);
  return r.stdout + r.stderr;
};
const running = (name: string) => docker(['inspect', '-f', '{{.State.Running}}', name]).stdout.trim() === 'true';

async function waitForLog(name: string, needle: string, timeoutMs = 120_000): Promise<void> {
  await until(`« ${needle} » dans ${name}`, () => {
    if (logsOf(name).includes(needle)) return true;
    if (!running(name)) throw new Error(`${name} s'est arrêté :\n${logsOf(name).slice(-3000)}`);
    return false;
  }, timeoutMs);
}

/**
 * Remplace le point d'entrée du worker ($WORKER) par une sonde : elle est lancée par deploy/entrypoint.sh EXACTEMENT comme
 * le worker (même binaire, mêmes capacités), puis lance un enfant ordinaire (sh), Chromium (bac à sable de Chromium actif)
 * et un enfant du bac à sable par le plan de lancement de production (spawnPlan, SANDBOX_*), et exécute un vrai script dans
 * le bac à sable (ProcessSandboxEngine.run).
 */
const PROBE = String.raw`
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
const status = (pid) => {
  const s = readFileSync('/proc/' + pid + '/status', 'utf8');
  const f = (k) => (new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(s) || [])[1] || '';
  return { pid: Number(f('Pid')), name: f('Name'), uid: Number(f('Uid').split(/\s+/)[0]), inh: f('CapInh'), prm: f('CapPrm'), eff: f('CapEff'), amb: f('CapAmb'), nnp: Number(f('NoNewPrivs')) };
};
const out = { worker: status('self'), execPath: process.execPath };
const sh = spawnSync('/bin/sh', ['-c', 'cat /proc/$$/status'], { encoding: 'utf8' });
const shField = (k) => (new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(sh.stdout) || [])[1] || '';
out.sh = { uid: Number(shField('Uid').split(/\s+/)[0]), inh: shField('CapInh'), prm: shField('CapPrm'), eff: shField('CapEff'), amb: shField('CapAmb') };
const { chromium } = await import('/app/apps/worker/node_modules/playwright-core/index.mjs');
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setContent('<p>ok</p>');
out.page = await page.textContent('p');
const myNs = readlinkSync('/proc/self/ns/user');
out.chromium = [];
for (const d of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
  try {
    const st = status(d);
    // Processus de Chromium dans l'espace de noms utilisateur du conteneur ; ceux de son propre bac à sable (espace de
    // noms imbriqué) ont des capacités relatives à cet espace, sans effet hors de lui.
    if (/chrom/.test(st.name) && readlinkSync('/proc/' + d + '/ns/user') === myNs) out.chromium.push(st);
  } catch {}
}
await browser.close();
const { spawnPlan, sandboxOptionsFromEnv, ProcessSandboxEngine } = await import('/app/apps/worker/dist/sandbox/engine.js');
const options = sandboxOptionsFromEnv(process.env);
const CHILD = "const fs=require('fs');const s=fs.readFileSync('/proc/self/status','utf8');const f=k=>(new RegExp('^'+k+':\\\\s*(.*)$','m').exec(s)||[])[1]||'';" +
  "const rd=p=>{try{fs.readFileSync(p);return 'readable'}catch(e){return e.code}};" +
  "process.stdout.write(JSON.stringify({uid:process.getuid(),inh:f('CapInh'),prm:f('CapPrm'),eff:f('CapEff'),amb:f('CapAmb'),nnp:Number(f('NoNewPrivs')),pid1Environ:rd('/proc/1/environ'),parentEnviron:rd('/proc/'+process.ppid+'/environ'),keys:Object.keys(process.env)}))";
const plan = spawnPlan({ node: options.node ?? process.execPath, nodeArgs: ['-e', CHILD], cpuSeconds: 5, launcher: options.launcher, uid: options.uid, gid: options.gid });
const child = spawnSync(plan.command, plan.args, { env: {}, encoding: 'utf8', cwd: '/app/apps/worker/dist/sandbox', uid: plan.uid, gid: plan.gid });
try { out.sandbox = JSON.parse(child.stdout); } catch { out.sandbox = { error: child.status + ' ' + child.stderr.slice(0, 500) }; }
const engine = new ProcessSandboxEngine({ ...options, production: true });
out.probe = await engine.probeIsolation();
await engine.idle();
// Enfant évadé simulé : un processus détaché sous l'uid dédié, hors de tout run suivi ; le balayage de fin de run le tue.
const state = (pid) => { try { return /^State:\s*Z/m.test(readFileSync('/proc/' + pid + '/status', 'utf8')) ? 'zombie' : 'alive'; } catch { return 'gone'; } };
const stray = spawnSync(options.launcher, ['--reuid=' + options.uid, '--regid=' + options.gid, '--clear-groups', '--no-new-privs', '--', '/bin/sh', '-c', 'sleep 600 >/dev/null 2>&1 & echo $!'], { env: {}, encoding: 'utf8' });
const strayPid = Number(stray.stdout.trim());
out.stray = { uid: Number((/^Uid:\s*(\d+)/m.exec(readFileSync('/proc/' + strayPid + '/status', 'utf8')) || [])[1]), before: state(strayPid) };
const bridges = { fetch: async () => { throw new Error('non'); }, log() {}, emit() {}, violation() {} };
const result = await engine.run('return 6 * 7;', bridges, { timeoutMs: 10000, memoryMb: 64 });
out.run = { outcome: result.outcome, value: result.value, error: result.error };
await engine.idle();
out.stray.after = state(strayPid);
// En dernier : le worker n'a pas CAP_SETUID en effectif (node-worker =p).
try { process.setuid(0); out.setuid0 = 'uid ' + process.getuid(); } catch (e) { out.setuid0 = e.code || String(e); }
console.log('ZZ_PROBE ' + JSON.stringify(out));
`;

type ProbeReport = {
  worker: Proc;
  execPath: string;
  sh: Pick<Proc, 'uid' | 'inh' | 'prm' | 'eff' | 'amb'>;
  page: string;
  chromium: Proc[];
  sandbox: { uid: number; inh: string; prm: string; eff: string; amb: string; nnp: number; pid1Environ: string; parentEnviron: string; keys: string[]; error?: string };
  probe: { uid: number; parentEnviron: string; noNewPrivs: boolean };
  run: { outcome: string; value: unknown; error?: string };
  stray: { uid: number; before: string; after: string };
  setuid0: string;
};

beforeAll(() => {
  if (image === '') {
    dockerOk(['build', '--quiet', '-f', 'deploy/Dockerfile', '-t', builtTag, runtimeDir.replace(/\/$/, '')], 900_000);
    image = builtTag;
  }
  scratch = mkdtempSync(join(tmpdir(), 'zz_test_image_privileges-'));
  writeFileSync(join(scratch, 'probe.mjs'), PROBE);
  dockerOk(['network', 'create', network]);
  dockerOk(['run', '-d', '--name', pgName, '--network', network, '-e', 'POSTGRES_USER=runtime', '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`, '-e', 'POSTGRES_DB=runtime', PG_IMAGE]);
  containers.push(pgName);
}, 900_000);

afterAll(() => {
  for (const name of containers.reverse()) docker(['rm', '-f', '-v', name]);
  docker(['network', 'rm', network]);
  if (image === builtTag) docker(['rmi', '-f', builtTag]);
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
}, 120_000);

describe('assert_sandbox_image_privileges — image sous les capacités de Render et en Docker classique', () => {
  test('image : démarre en root pour descendre aussitôt ; copie de Node du worker réservée à pwuser', () => {
    const user = dockerOk(['image', 'inspect', '--format', '{{.Config.User}}', image]).trim();
    expect(['root', '0', '']).toContain(user);
    const stat = dockerOk(['run', '--rm', '--entrypoint', 'stat', image, '-c', '%U:%G %a', '/usr/local/libexec/node-worker', '/usr/local/libexec/sandbox-launch']);
    expect(stat.trim().split('\n')).toEqual(['root:pwuser 750', 'root:pwuser 750']);
  });

  test('`runtime` lancée en root hors point d’entrée (docker exec, shell de l’hébergeur) : descend sur pwuser sans capacité', () => {
    // Un faux `node` en tête du PATH rapporte l'identité sous laquelle la commande `runtime` l'exécute.
    writeFileSync(join(scratch, 'node'), "#!/bin/sh\ngrep -E '^(Uid|CapInh|CapPrm|CapEff|CapAmb|NoNewPrivs):' /proc/$$/status\n", { mode: 0o755 });
    const r = docker(['run', '--rm', '-u', '0', ...RENDER, '--entrypoint', '/usr/local/bin/runtime', '-v', `${join(scratch, 'node')}:/zz-test/node:ro`, '-e', 'PATH=/zz-test:/usr/local/bin:/usr/bin:/bin', image, 'doctor']);
    expect(r.status, r.stderr).toBe(0);
    const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(r.stdout)?.[1]?.trim();
    expect(Number(field('Uid')?.split(/\s+/)[0])).toBe(PWUSER);
    expect({ inh: field('CapInh'), prm: field('CapPrm'), eff: field('CapEff'), amb: field('CapAmb') }).toEqual(noCaps);
  });

  test('démarrage sous un uid imposé (--user 1001) : no-new-privileges posé quand même par le point d’entrée', () => {
    const r = docker(['run', '--rm', '-u', String(PWUSER), image, "grep -E '^(Uid|NoNewPrivs):' /proc/self/status"]);
    expect(r.status, r.stderr).toBe(0);
    expect(identity(r.stdout)).toMatchObject({ uid: PWUSER, nnp: 1 });
  });

  test('rien de ce qu’exécute ou charge pwuser n’est modifiable par l’uid dédié (Chromium de /ms-playwright, /app, /usr)', () => {
    const r = docker(['run', '--rm', '-u', `${SANDBOX_UID}:${SANDBOX_UID}`, '--entrypoint', 'find', image, '/', '-xdev',
      '(', '-path', '/proc', '-o', '-path', '/tmp', '-o', '-path', '/var/tmp', '-o', '-path', '/run/lock', '-o', '-path', '/dev', ')', '-prune',
      '-o', '-writable', '!', '-type', 'l', '-print']);
    expect(r.stdout.trim().split('\n').filter(Boolean)).toEqual([]);
  });

  for (const profile of PROFILES) {
    describe(profile.name, () => {
      test('(f) `runtime migrate` passé au point d’entrée : pwuser, aucune capacité, migrations appliquées', async () => {
        await until('PostgreSQL prêt', () => docker(['exec', pgName, 'pg_isready', '-U', 'runtime', '-d', 'runtime']).status === 0, 90_000);
        const cmd = `grep -E '^(Uid|CapInh|CapPrm|CapEff|CapAmb|NoNewPrivs):' /proc/$$/status && runtime migrate`;
        const r = docker(['run', '--rm', '--network', network, ...profile.flags, '-e', `DATABASE_URL=${DATABASE_URL}`, image, cmd], 180_000);
        expect(r.status, r.stderr.slice(-2000)).toBe(0);
        const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(r.stdout)?.[1]?.trim();
        expect(Number(field('Uid')?.split(/\s+/)[0])).toBe(PWUSER);
        expect({ inh: field('CapInh'), prm: field('CapPrm'), eff: field('CapEff'), amb: field('CapAmb') }).toEqual(noCaps);
        expect(Number(field('NoNewPrivs'))).toBe(1);
      }, 240_000);

      test('(a) worker : sonde d’isolation verte, worker sous pwuser avec cap_setuid,cap_setgid hors ambient, aucun root', async () => {
        const name = startContainer(`zz_test_img_worker_${profile.nnp ? 'render' : 'classic'}_${run}`, profile.flags, {
          RUNTIME_MODE: 'worker',
          DATABASE_URL,
          MASTER_KEY,
          // Ignorée sous node-worker (AT_SECURE) : le worker doit le dire au démarrage.
          NODE_EXTRA_CA_CERTS: '/zz-test/ca.pem',
        });
        await waitForLog(name, 'bac à sable : isolation éprouvée');
        expect(logsOf(name)).toMatch(/NODE_EXTRA_CA_CERTS est ignorée par le worker/);
        const line = logsOf(name).split('\n').find((l) => l.includes('isolation éprouvée')) ?? '';
        expect(JSON.parse(line)).toMatchObject({ sandboxUid: SANDBOX_UID, noNewPrivs: true });
        const procs = processes(name);
        console.log(`${name} : ${JSON.stringify(procs.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 60), uid: p.uid, ...caps(p), nnp: p.nnp })))}`);
        expect(procs.filter((p) => p.uid === 0), JSON.stringify(procs)).toEqual([]);
        const worker = procs.find((p) => p.cmd.startsWith('/usr/local/libexec/node-worker '));
        expect(worker, JSON.stringify(procs)).toBeDefined();
        expect(worker!.uid).toBe(PWUSER);
        expect(caps(worker!)).toEqual(workerCaps);
        expect(worker!.nnp).toBe(1);
        // tini (PID 1) : l'ensemble ambient du démarrage worker, rien de plus ; aucun autre processus ne porte de capacité.
        expect(caps(procs.find((p) => p.pid === 1)!)).toEqual(ambientCaps);
        for (const p of procs.filter((x) => x !== worker && x.pid !== 1)) expect(caps(p), p.name).toEqual(noCaps);
        for (const p of procs) expect(p.nnp, p.cmd).toBe(1);

        // Arrêt propre : tini (pwuser) relaie SIGTERM au worker, qui sort en 0.
        dockerOk(['stop', '-t', '30', name], 60_000);
        expect(docker(['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim()).toBe('0');
        expect(logsOf(name)).not.toMatch(/FATAL tini|forwarding signal/);
      }, 240_000);

      test('(b)(c) enfants du worker : sh et Chromium sans capacité ; bac à sable sous l’uid dédié, sans capacité, /proc/1/environ refusé', async () => {
        const name = startContainer(`zz_test_img_probe_${profile.nnp ? 'render' : 'classic'}_${run}`, profile.flags, { RUNTIME_MODE: 'worker' }, [
          '-v', `${join(scratch, 'probe.mjs')}:/app/apps/worker/dist/index.js:ro`,
        ]);
        await until(`sonde terminée dans ${name}`, () => /ZZ_PROBE |Error/.test(logsOf(name)) && !running(name), 120_000).catch((error: unknown) => {
          // Sonde bloquée : ses journaux et les processus du conteneur disent où.
          const procs = running(name) ? JSON.stringify(processes(name).map((p) => ({ pid: p.pid, ppid: p.ppid, uid: p.uid, cmd: p.cmd.slice(0, 120) }))) : 'arrêté';
          throw new Error(`${String(error)}\n${logsOf(name).slice(-3000)}\nprocessus : ${procs}`);
        });
        const logs = logsOf(name);
        const line = logs.split('\n').find((l) => l.startsWith('ZZ_PROBE '));
        expect(line, logs.slice(-3000)).toBeDefined();
        const report = JSON.parse(line!.slice('ZZ_PROBE '.length)) as ProbeReport;
        console.log(`${profile.name} : ${JSON.stringify({ worker: caps(report.worker), sh: report.sh, chromium: report.chromium.map((c) => ({ name: c.name, uid: c.uid, ...caps(c) })), sandbox: report.sandbox })}`);
        // Le worker (sonde lancée à sa place) : capacités effectives cap_setuid,cap_setgid, ni ambient ni héritables.
        expect(report.execPath).toBe('/usr/local/libexec/node-worker');
        expect(report.worker.uid).toBe(PWUSER);
        expect(caps(report.worker)).toEqual(workerCaps);
        // (b) enfants ordinaires.
        expect(report.sh).toEqual({ uid: PWUSER, ...noCaps });
        expect(report.page).toBe('ok');
        expect(report.chromium.length).toBeGreaterThan(0);
        for (const c of report.chromium) expect({ uid: c.uid, ...caps(c) }, c.name).toEqual({ uid: PWUSER, ...noCaps });
        // (c) enfant du bac à sable, lancé par le plan de production.
        expect(report.sandbox).toMatchObject({ uid: SANDBOX_UID, ...noCaps, nnp: 1, pid1Environ: 'EACCES', parentEnviron: 'EACCES', keys: [] });
        expect(report.probe).toEqual({ uid: SANDBOX_UID, parentEnviron: 'denied', noNewPrivs: true });
        expect(report.run).toMatchObject({ outcome: 'ok', value: 42 });
        // Processus détaché sous l'uid dédié : vivant avant le run, balayé à sa fin.
        expect(report.stray).toMatchObject({ uid: SANDBOX_UID, before: 'alive' });
        expect(['gone', 'zombie']).toContain(report.stray.after);
        // Worker compromis : process.setuid(0) refusé (capacités permises, pas effectives).
        expect(report.setuid0).toBe('EPERM');
      }, 180_000);

      test('(e) RUNTIME_MODE=all : server sans capacité, worker lancé comme en mode worker, aucun root', async () => {
        const name = startContainer(`zz_test_img_all_${profile.nnp ? 'render' : 'classic'}_${run}`, profile.flags, {
          RUNTIME_MODE: 'all',
          DATABASE_URL,
          MASTER_KEY,
          ADMIN_BOOTSTRAP_TOKEN,
          PUBLIC_URL: 'http://localhost:3000',
        });
        await waitForLog(name, 'bac à sable : isolation éprouvée');
        const ready = "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))";
        await until('/api/ready = 200', () => docker(['exec', '-u', String(PWUSER), name, 'node', '-e', ready]).status === 0, 90_000);
        const procs = processes(name);
        console.log(`${name} : ${JSON.stringify(procs.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 60), uid: p.uid, ...caps(p), nnp: p.nnp })))}`);
        expect(procs.filter((p) => p.uid === 0), JSON.stringify(procs)).toEqual([]);
        const worker = procs.find((p) => p.cmd.startsWith('/usr/local/libexec/node-worker '));
        const server = procs.find((p) => p.cmd === 'node /app/apps/server/dist/index.js');
        expect(worker, JSON.stringify(procs)).toBeDefined();
        expect(server, JSON.stringify(procs)).toBeDefined();
        expect(caps(worker!)).toEqual(workerCaps);
        expect(caps(server!)).toEqual(noCaps);
        expect(server!.nnp).toBe(1);
        // L'ensemble ambient ne subsiste que dans tini et le shell superviseur, qui ne lancent les rôles que par `role`.
        const supervisors = procs.filter((x) => x.pid === 1 || x.cmd.startsWith('/bin/bash /usr/local/bin/entrypoint.sh'));
        expect(supervisors.length, JSON.stringify(procs)).toBeGreaterThanOrEqual(2);
        for (const p of supervisors) expect(caps(p), p.cmd).toEqual(ambientCaps);
        for (const p of procs.filter((x) => x !== worker && !supervisors.includes(x))) expect(caps(p), p.cmd).toEqual(noCaps);
        for (const p of procs) expect(p.nnp, p.cmd).toBe(1);
        dockerOk(['stop', '-t', '30', name], 60_000);
        expect(docker(['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim()).toBe('0');
      }, 240_000);

      test('(g) RUNTIME_MODE=server : aucune capacité nulle part (PID 1 compris) ; sonde de santé du compose sous pwuser', async () => {
        const name = startContainer(`zz_test_img_server_${profile.nnp ? 'render' : 'classic'}_${run}`, profile.flags, {
          RUNTIME_MODE: 'server',
          DATABASE_URL,
          MASTER_KEY,
          ADMIN_BOOTSTRAP_TOKEN,
          PUBLIC_URL: 'http://localhost:3000',
        });
        // La sonde du compose, telle quelle, lancée comme Docker la lance (docker exec sans -u : USER de l'image, root).
        const healthcheck = composeHealthcheck();
        await until('sonde de santé du compose = 0', () => docker(['exec', name, ...healthcheck]).status === 0, 90_000);
        const procs = processes(name);
        console.log(`${name} : ${JSON.stringify(procs.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 60), uid: p.uid, ...caps(p), nnp: p.nnp })))}`);
        expect(procs.length).toBeGreaterThanOrEqual(2);
        for (const p of procs) expect({ uid: p.uid, ...caps(p), nnp: p.nnp }, p.cmd).toEqual({ uid: PWUSER, ...noCaps, nnp: 1 });
        // Identité de la commande de la sonde : son code JS remplacé par une lecture de /proc/self/status.
        const at = healthcheck.indexOf('-e');
        expect(at, JSON.stringify(healthcheck)).toBeGreaterThan(0);
        const probe = [...healthcheck.slice(0, at + 1), "process.stdout.write(require('fs').readFileSync('/proc/self/status','utf8'))", ...healthcheck.slice(at + 2)];
        const r = docker(['exec', name, ...probe]);
        expect(r.status, r.stderr).toBe(0);
        expect(identity(r.stdout)).toEqual({ uid: PWUSER, ...noCaps, nnp: 1 });
        dockerOk(['stop', '-t', '30', name], 60_000);
        expect(docker(['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim()).toBe('0');
      }, 240_000);
    });
  }
});
