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
// Seccomp (revue 4.1b) : les deux profils ci-dessus appliquent le profil du compose (deploy/seccomp-chromium.json), que Render
// n'applique pas (render.yaml n'a pas de security_opt ; son régime seccomp reste à relever, GO). Le régime de Render est donc
// joué aussi sous le profil par défaut de Docker (builtin) et sans profil (unconfined) : (c), sonde d'isolation et run du bac
// à sable verts dans les deux cas ; sous builtin, Chromium s'arrête sur « No usable sandbox! » et le worker le dit dès son
// démarrage (alert: chromium_sandbox_unavailable, régime seccomp journalisé). Dans tous les profils, l'enfant du bac à sable
// ne crée aucun espace de noms (filtre SANDBOX_SECCOMP), même là où le conteneur le permet à Chromium.
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

/**
 * Options de sécurité du worker dans deploy/docker-compose.prod.yml (profil seccomp de Chromium), chemins rendus absolus.
 * Le profil seccomp par défaut de Docker refuse les espaces de noms utilisateur du bac à sable de Chromium (« No usable
 * sandbox! », job image de la CI sur ubuntu-24.04, revue 4.1b) ; Docker Desktop, lui, n'applique aucun profil par défaut :
 * le profil est donc toujours passé explicitement, comme le compose le fait.
 */
function composeWorkerSecurityOpts(): string[] {
  const compose = parse(readFileSync(join(runtimeDir, 'deploy/docker-compose.prod.yml'), 'utf8')) as { services: Record<string, { security_opt?: string[] }> };
  return (compose.services['worker']?.security_opt ?? []).flatMap((opt) => ['--security-opt', opt.replace(/^seccomp=\.\//, `seccomp=${join(runtimeDir, 'deploy')}/`)]);
}
const WORKER_SECURITY = composeWorkerSecurityOpts();
const RENDER_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'SYS_CHROOT'];
/**
 * Capacités du conteneur de Render (bounding 0x400cb) et no-new-privileges, avec un régime seccomp au choix : celui du compose
 * par défaut. Le régime seccomp de Render n'est pas relevé (à lire au GO dans le journal du worker : champ `seccomp`).
 */
const renderFlags = (capabilities: readonly string[] = RENDER_CAPS, seccomp: readonly string[] = WORKER_SECURITY) => [
  '--security-opt', 'no-new-privileges',
  '--cap-drop', 'ALL',
  ...capabilities.flatMap((c) => ['--cap-add', c]),
  ...seccomp,
];
const RENDER = renderFlags();
const PROFILES = [
  { name: 'Render (no-new-privileges, capacités réduites), profil seccomp du compose', flags: RENDER, nnp: true, short: 'render' },
  { name: 'Docker classique (capacités par défaut), profil seccomp du compose', flags: [...WORKER_SECURITY], nnp: false, short: 'classic' },
] as const;
/** Régime de Render sans le profil du compose : profil par défaut de Docker (Chromium sans bac à sable utilisable), aucun profil. */
const RENDER_SECCOMP_VARIANTS = [
  { name: 'Render sous le profil seccomp par défaut de Docker (builtin)', flags: renderFlags(RENDER_CAPS, ['--security-opt', 'seccomp=builtin']), short: 'render_builtin', seccomp: '2', chromium: false },
  { name: 'Render sans profil seccomp (unconfined)', flags: renderFlags(RENDER_CAPS, ['--security-opt', 'seccomp=unconfined']), short: 'render_unconfined', seccomp: '0', chromium: true },
] as const;
/** Filtre de l'enfant (sandbox-seccomp --self-test sous l'uid dédié) : aucun espace de noms, clone ordinaire permis. */
const CHILD_NO_NAMESPACES = { unshareUser: 'EPERM', unshareNet: 'EPERM', setns: 'EPERM', clone3: 'ENOSYS', cloneUser: 'EPERM', cloneNet: 'EPERM', clone: 'ok' };

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

/** Composes dont la sonde de santé du server est rejouée telle quelle (production, puis développement). */
const COMPOSE_FILES = ['deploy/docker-compose.prod.yml', 'docker-compose.yml'] as const;

/** Sonde de santé du server dans un fichier compose (forme exec : ["CMD", …]). */
function composeHealthcheck(file: (typeof COMPOSE_FILES)[number]): string[] {
  const compose = parse(readFileSync(join(runtimeDir, file), 'utf8')) as { services: Record<string, { healthcheck?: { test?: string[] } }> };
  const test_ = compose.services['server']?.healthcheck?.test ?? [];
  if (test_[0] !== 'CMD') throw new Error(`${file}, sonde de santé du server : forme exec ["CMD", …] attendue (${JSON.stringify(test_)})`);
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
// Diagnostic du bac à sable de Chromium : création d'un espace de noms utilisateur (EPERM : seccomp ; EACCES : AppArmor).
const userns = spawnSync('/usr/bin/unshare', ['--user', '/bin/true'], { encoding: 'utf8' });
out.userns = userns.status === 0 ? 'ok' : (userns.status + ' ' + userns.stderr.trim()).slice(0, 300);
out.seccomp = (/^Seccomp:\s*(\d)/m.exec(readFileSync('/proc/self/status', 'utf8')) || [])[1];
const { chromium } = await import('/app/apps/worker/node_modules/playwright-core/index.mjs');
out.chromium = [];
try {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setContent('<p>ok</p>');
  out.page = await page.textContent('p');
  const myNs = readlinkSync('/proc/self/ns/user');
  for (const d of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const st = status(d);
      // Processus de Chromium dans l'espace de noms utilisateur du conteneur ; ceux de son propre bac à sable (espace de
      // noms imbriqué) ont des capacités relatives à cet espace, sans effet hors de lui.
      if (/chrom/.test(st.name) && readlinkSync('/proc/' + d + '/ns/user') === myNs) out.chromium.push(st);
    } catch {}
  }
  await browser.close();
} catch (e) {
  // Chromium sans bac à sable utilisable : rapporté avec le diagnostic au lieu d'un arrêt de la sonde.
  out.chromiumError = String(e && e.message || e).split('\n').filter((l) => /FATAL|sandbox|launch/i.test(l)).join(' | ').slice(0, 800);
}
const { spawnPlan, sandboxOptionsFromEnv, ProcessSandboxEngine } = await import('/app/apps/worker/dist/sandbox/engine.js');
const options = sandboxOptionsFromEnv(process.env);
const CHILD = "const fs=require('fs');const s=fs.readFileSync('/proc/self/status','utf8');const f=k=>(new RegExp('^'+k+':\\\\s*(.*)$','m').exec(s)||[])[1]||'';" +
  "const rd=p=>{try{fs.readFileSync(p);return 'readable'}catch(e){return e.code}};" +
  "process.stdout.write(JSON.stringify({uid:process.getuid(),inh:f('CapInh'),prm:f('CapPrm'),eff:f('CapEff'),amb:f('CapAmb'),nnp:Number(f('NoNewPrivs')),seccomp:f('Seccomp'),pid1Environ:rd('/proc/1/environ'),parentEnviron:rd('/proc/'+process.ppid+'/environ'),keys:Object.keys(process.env),core:(/^Max core file size\\s+(\\S+)\\s+(\\S+)/m.exec(fs.readFileSync('/proc/self/limits','utf8'))||[]).slice(1).join(' '),coredumpFilter:fs.readFileSync('/proc/self/coredump_filter','utf8').trim(),userns:require('child_process').spawnSync('/usr/bin/unshare',['-U','/bin/true']).status}))";
const plan = spawnPlan({ node: options.node ?? process.execPath, nodeArgs: ['-e', CHILD], cpuSeconds: 5, launcher: options.launcher, uid: options.uid, gid: options.gid, seccomp: options.seccomp });const child = spawnSync(plan.command, plan.args, { env: {}, encoding: 'utf8', cwd: '/app/apps/worker/dist/sandbox', uid: plan.uid, gid: plan.gid });
try { out.sandbox = JSON.parse(child.stdout); } catch { out.sandbox = { error: child.status + ' ' + child.stderr.slice(0, 500) }; }
// Filtre de l'enfant, essayé sous l'uid dédié par le lanceur (comme spawnPlan le pose) : aucun espace de noms.
const selfTest = spawnSync(options.launcher, ['--reuid=' + options.uid, '--regid=' + options.gid, '--clear-groups', '--no-new-privs', '--', options.seccomp, '--self-test'], { env: {}, encoding: 'utf8' });
try { out.childNamespaces = JSON.parse(selfTest.stdout); } catch { out.childNamespaces = { error: selfTest.status + ' ' + selfTest.stderr.slice(0, 300) }; }
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
  page?: string;
  userns: string;
  seccomp?: string;
  chromiumError?: string;
  chromium: Proc[];
  sandbox: { uid: number; inh: string; prm: string; eff: string; amb: string; nnp: number; seccomp: string; pid1Environ: string; parentEnviron: string; keys: string[]; core: string; coredumpFilter: string; userns: number | null; error?: string };
  childNamespaces: Record<string, string>;
  probe: { uid: number; parentEnviron: string; witness: string; noNewPrivs: boolean; namespaces: string };
  run: { outcome: string; value: unknown; error?: string };  stray: { uid: number; before: string; after: string };
  setuid0: string;
};

/** Lance la sonde à la place du worker (même point d'entrée, mêmes capacités) et rend son rapport. */
async function runProbe(short: string, flags: readonly string[]): Promise<ProbeReport> {
  const name = startContainer(`zz_test_img_probe_${short}_${run}`, flags, { RUNTIME_MODE: 'worker' }, ['-v', `${join(scratch, 'probe.mjs')}:/app/apps/worker/dist/index.js:ro`]);
  // La sonde s'arrête d'elle-même (rapport ou erreur) : attendre l'arrêt du conteneur, pas un motif des journaux.
  await until(`sonde terminée dans ${name}`, () => !running(name), 120_000).catch((error: unknown) => {
    // Sonde bloquée : ses journaux et les processus du conteneur disent où.
    const procs = running(name) ? JSON.stringify(processes(name).map((p) => ({ pid: p.pid, ppid: p.ppid, uid: p.uid, cmd: p.cmd.slice(0, 120) }))) : 'arrêté';
    throw new Error(`${String(error)}\n${logsOf(name).slice(-3000)}\nprocessus : ${procs}`);
  });
  const logs = logsOf(name);
  const line = logs.split('\n').find((l) => l.startsWith('ZZ_PROBE '));
  expect(line, logs.slice(-3000)).toBeDefined();
  return JSON.parse(line!.slice('ZZ_PROBE '.length)) as ProbeReport;
}

/**
 * (c) enfant du bac à sable lancé par le plan de production : uid dédié, aucune capacité, filtre seccomp de l'enfant (aucun
 * espace de noms), /proc/1/environ refusé ; sonde d'isolation verte ; vrai run ; processus détaché balayé à la fin du run ;
 * worker : process.setuid(0) refusé (capacités permises, pas effectives).
 */
function expectSandboxChild(report: ProbeReport): void {
  expect(report.sandbox).toMatchObject({ uid: SANDBOX_UID, ...noCaps, nnp: 1, seccomp: '2', pid1Environ: 'EACCES', parentEnviron: 'EACCES', keys: [] });
  expect(report.childNamespaces).toEqual(CHILD_NO_NAMESPACES);
  // assert_sandbox_no_core_dump (INV7) : aucun vidage mémoire possible, même vers un collecteur en tube de l'hôte.
  expect({ core: report.sandbox.core, coredumpFilter: report.sandbox.coredumpFilter }).toEqual({ core: '1 1', coredumpFilter: '00000000' });
  // assert_sandbox_child_no_namespaces : le profil seccomp livré permet les espaces de noms utilisateur au conteneur
  // (Chromium) ; l'enfant (uid 1500), sous son filtre, ne peut pas en créer (risque résiduel de fix-pnpm-pin fermé, 4.1b).
  expect(report.sandbox.userns, 'unshare -U sous l’uid 1500').toBeGreaterThan(0);
  expect(report.probe).toEqual({ uid: SANDBOX_UID, parentEnviron: 'denied', witness: 'denied', noNewPrivs: true, namespaces: 'denied' });
  expect(report.run).toMatchObject({ outcome: 'ok', value: 42 });
  expect(report.stray).toMatchObject({ uid: SANDBOX_UID, before: 'alive' });
  expect(['gone', 'zombie']).toContain(report.stray.after);
  expect(report.setuid0).toBe('EPERM');
}

/** Ligne de journal JSON du worker qui contient `needle`. */
const logLine = (name: string, needle: string): Record<string, unknown> => JSON.parse(logsOf(name).split('\n').find((l) => l.includes(needle)) ?? '{}') as Record<string, unknown>;

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

  test('seccomp : le profil par défaut de Docker refuse les espaces de noms utilisateur (bac à sable de Chromium), celui du compose les permet', () => {
    // Cause de l'échec du job image sur ubuntu-24.04 (revue 4.1b) : Chromium s'arrêtait sur « No usable sandbox! ».
    const unshare = (opts: readonly string[]) => docker(['run', '--rm', '-u', String(PWUSER), ...opts, '--entrypoint', '/usr/bin/unshare', image, '--user', '/bin/true']);
    const builtin = unshare(['--security-opt', 'seccomp=builtin']);
    expect(builtin.status).not.toBe(0);
    expect(builtin.stderr).toMatch(/Operation not permitted/);
    for (const profile of PROFILES) {
      const r = unshare(profile.flags);
      expect(r.status, `${profile.short} : ${r.stderr}`).toBe(0);
    }
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
        const name = startContainer(`zz_test_img_worker_${profile.short}_${run}`, profile.flags, {
          RUNTIME_MODE: 'worker',
          DATABASE_URL,
          MASTER_KEY,
          // Ignorée sous node-worker (AT_SECURE) : le worker doit le dire au démarrage.
          NODE_EXTRA_CA_CERTS: '/zz-test/ca.pem',
        });
        await waitForLog(name, 'bac à sable : isolation éprouvée');
        expect(logsOf(name)).toMatch(/NODE_EXTRA_CA_CERTS est ignorée par le worker/);
        expect(logLine(name, 'isolation éprouvée')).toMatchObject({ sandboxUid: SANDBOX_UID, noNewPrivs: true, namespaces: 'denied', seccomp: '2' });
        // Profil seccomp du compose : bac à sable de Chromium disponible, dit au démarrage.
        await waitForLog(name, 'Chromium : bac à sable disponible');
        expect(logsOf(name)).not.toMatch(/chromium_sandbox_unavailable/);
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
        const report = await runProbe(profile.short, profile.flags);        console.log(`${profile.name} : ${JSON.stringify({ worker: caps(report.worker), sh: report.sh, chromium: report.chromium.map((c) => ({ name: c.name, uid: c.uid, ...caps(c) })), sandbox: report.sandbox })}`);
        // Le worker (sonde lancée à sa place) : capacités effectives cap_setuid,cap_setgid, ni ambient ni héritables.
        expect(report.execPath).toBe('/usr/local/libexec/node-worker');
        expect(report.worker.uid).toBe(PWUSER);
        expect(caps(report.worker)).toEqual(workerCaps);
        // (b) enfants ordinaires. Bac à sable de Chromium : espaces de noms utilisateur permis par le profil seccomp du compose.
        expect(report.sh).toEqual({ uid: PWUSER, ...noCaps });
        expect({ userns: report.userns, chromiumError: report.chromiumError }, `seccomp ${report.seccomp ?? '?'}`).toEqual({ userns: 'ok', chromiumError: undefined });
        expect(report.page).toBe('ok');
        expect(report.chromium.length).toBeGreaterThan(0);
        for (const c of report.chromium) expect({ uid: c.uid, ...caps(c) }, c.name).toEqual({ uid: PWUSER, ...noCaps });
        // (c) enfant du bac à sable, lancé par le plan de production ; le conteneur permet les espaces de noms (Chromium),
        // l'enfant non (filtre SANDBOX_SECCOMP).
        expectSandboxChild(report);
      }, 180_000);

      test('(e) RUNTIME_MODE=all : server sans capacité, worker lancé comme en mode worker, aucun root', async () => {
        const name = startContainer(`zz_test_img_all_${profile.short}_${run}`, profile.flags, {
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

      test('(g) RUNTIME_MODE=server : aucune capacité nulle part (PID 1 compris) ; sondes de santé des deux compose sous pwuser', async () => {
        const name = startContainer(`zz_test_img_server_${profile.short}_${run}`, profile.flags, {
          RUNTIME_MODE: 'server',
          DATABASE_URL,
          MASTER_KEY,
          ADMIN_BOOTSTRAP_TOKEN,
          PUBLIC_URL: 'http://localhost:3000',
        });
        // La sonde de chaque compose, telle quelle, lancée comme Docker la lance (docker exec sans -u : USER de l'image, root).
        for (const file of COMPOSE_FILES) {
          const healthcheck = composeHealthcheck(file);
          await until(`sonde de santé de ${file} = 0`, () => docker(['exec', name, ...healthcheck]).status === 0, 90_000);
        }
        const procs = processes(name);
        console.log(`${name} : ${JSON.stringify(procs.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 60), uid: p.uid, ...caps(p), nnp: p.nnp })))}`);
        expect(procs.length).toBeGreaterThanOrEqual(2);
        for (const p of procs) expect({ uid: p.uid, ...caps(p), nnp: p.nnp }, p.cmd).toEqual({ uid: PWUSER, ...noCaps, nnp: 1 });
        // Identité de la commande de chaque sonde : son code JS remplacé par une lecture de /proc/self/status.
        for (const file of COMPOSE_FILES) {
          const healthcheck = composeHealthcheck(file);
          const at = healthcheck.indexOf('-e');
          expect(at, JSON.stringify(healthcheck)).toBeGreaterThan(0);
          const probe = [...healthcheck.slice(0, at + 1), "process.stdout.write(require('fs').readFileSync('/proc/self/status','utf8'))", ...healthcheck.slice(at + 2)];
          const r = docker(['exec', name, ...probe]);
          expect(r.status, `${file} : ${r.stderr}`).toBe(0);
          expect(identity(r.stdout), file).toEqual({ uid: PWUSER, ...noCaps, nnp: 1 });
        }
        dockerOk(['stop', '-t', '30', name], 60_000);
        expect(docker(['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim()).toBe('0');
      }, 240_000);
    });
  }

  // Revue 4.1b : Render n'applique pas le profil seccomp du compose. Sous le profil par défaut de Docker comme sans profil,
  // le bac à sable des scripts tient (uid dédié, sonde, run, balayage, aucun espace de noms pour l'enfant) ; sous le profil
  // par défaut, Chromium n'a pas de bac à sable utilisable et le worker le dit dès son démarrage, régime seccomp compris.
  for (const variant of RENDER_SECCOMP_VARIANTS) {
    describe(variant.name, () => {
      test(`assert_chromium_sandbox_reported — worker : isolation éprouvée, bac à sable de Chromium ${variant.chromium ? 'disponible' : 'indisponible, dit au démarrage'}`, async () => {
        await until('PostgreSQL prêt', () => docker(['exec', pgName, 'pg_isready', '-U', 'runtime', '-d', 'runtime']).status === 0, 90_000);
        const migrated = docker(['run', '--rm', '--network', network, '-e', `DATABASE_URL=${DATABASE_URL}`, image, 'runtime migrate'], 180_000);
        expect(migrated.status, migrated.stderr.slice(-2000)).toBe(0);
        const name = startContainer(`zz_test_img_worker_${variant.short}_${run}`, variant.flags, { RUNTIME_MODE: 'worker', DATABASE_URL, MASTER_KEY });
        await waitForLog(name, 'bac à sable : isolation éprouvée');
        expect(logLine(name, 'isolation éprouvée')).toMatchObject({ sandboxUid: SANDBOX_UID, noNewPrivs: true, namespaces: 'denied', seccomp: variant.seccomp });
        if (variant.chromium) {
          await waitForLog(name, 'Chromium : bac à sable disponible');
          expect(logLine(name, 'Chromium : bac à sable disponible')).toMatchObject({ seccomp: variant.seccomp });
          expect(logsOf(name)).not.toMatch(/chromium_sandbox_unavailable/);
        } else {
          await waitForLog(name, 'chromium_sandbox_unavailable');
          const alert = logLine(name, 'chromium_sandbox_unavailable');
          expect(alert).toMatchObject({ level: 50, seccomp: variant.seccomp, detail: expect.stringMatching(/Operation not permitted/) });
          expect(alert['msg']).toMatch(/Chromium : bac à sable indisponible.*les runs navigateur échoueront/);
        }
        // Le worker reste en service (runs sans navigateur) et s'arrête proprement.
        expect(running(name)).toBe(true);
        dockerOk(['stop', '-t', '30', name], 60_000);
        expect(docker(['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim()).toBe('0');
      }, 240_000);

      test(`(c) bac à sable des scripts vert (uid dédié, sonde, run, balayage) ; Chromium ${variant.chromium ? 'avec son bac à sable' : 'arrêté sur « No usable sandbox! »'}`, async () => {
        const report = await runProbe(variant.short, variant.flags);
        console.log(`${variant.name} : ${JSON.stringify({ userns: report.userns, seccomp: report.seccomp, chromiumError: report.chromiumError, sandbox: report.sandbox, childNamespaces: report.childNamespaces })}`);
        expect(report.seccomp).toBe(variant.seccomp);
        expect(report.execPath).toBe('/usr/local/libexec/node-worker');
        expect(caps(report.worker)).toEqual(workerCaps);
        expect(report.sh).toEqual({ uid: PWUSER, ...noCaps });
        if (variant.chromium) {
          expect({ userns: report.userns, chromiumError: report.chromiumError }).toEqual({ userns: 'ok', chromiumError: undefined });
          expect(report.page).toBe('ok');
          for (const c of report.chromium) expect({ uid: c.uid, ...caps(c) }, c.name).toEqual({ uid: PWUSER, ...noCaps });
        } else {
          expect(report.userns).toMatch(/Operation not permitted/);
          expect(report.chromiumError).toMatch(/No usable sandbox/);
          expect(report.page).toBeUndefined();
        }
        expectSandboxChild(report);
      }, 180_000);
    });
  }

  // D-32 (tâche 4.1b) : démarré directement sous un uid imposé (`--user`, `runAsUser`), le point d'entrée pose
  // no-new-privileges ; node-worker et sandbox-launch perdent alors leurs capacités de fichier, le changement d'uid du bac à
  // sable échoue et le worker de production REFUSE de démarrer (fermeture sûre), au lieu de servir sans isolation. Autonome :
  // migrations appliquées ici (startWorker vérifie le schéma AVANT la fabrique d'exécuteurs, donc avant la sonde).
  for (const profile of PROFILES) {
    test(`uid imposé (--user 1001), RUNTIME_MODE=worker, ${profile.short} : sonde d’isolation en échec, refus de démarrer (code 2)`, async () => {
      await until('PostgreSQL prêt', () => docker(['exec', pgName, 'pg_isready', '-U', 'runtime', '-d', 'runtime']).status === 0, 90_000);
      const migrated = docker(['run', '--rm', '--network', network, '-e', `DATABASE_URL=${DATABASE_URL}`, image, 'runtime migrate'], 180_000);
      expect(migrated.status, migrated.stderr.slice(-2000)).toBe(0);
      const name = startContainer(`zz_test_img_imposed_uid_${profile.short}_${run}`, [...profile.flags, '-u', String(PWUSER)], { RUNTIME_MODE: 'worker', DATABASE_URL, MASTER_KEY });
      await until(`worker arrêté dans ${name}`, () => !running(name), 120_000);
      const logs = logsOf(name);
      expect(docker(['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim(), logs.slice(-3000)).toBe('2');
      expect(logs).toMatch(/Refus de démarrer le worker : bac à sable : sonde d'isolation en échec/);
      expect(logs).not.toMatch(/isolation éprouvée/);
    }, 240_000);
  }

  // CDC 14 (D-32) : SETUID/SETGID retirés au conteneur (cap_drop) : root ne peut même pas descendre sur pwuser. Le point
  // d'entrée s'arrête sur l'échec de setpriv (exec, donc sans repli), avant tini et avant tout rôle : rien ne tourne, pas
  // même en root, et le worker ne démarre pas (fermeture sûre).
  test('SETUID et SETGID retirés (profil Render sans eux) : arrêt au point d’entrée, aucun rôle démarré, ni root ni worker', async () => {
    const flags = renderFlags(RENDER_CAPS.filter((c) => c !== 'SETUID' && c !== 'SETGID'));
    const name = startContainer(`zz_test_img_no_setid_${run}`, flags, { RUNTIME_MODE: 'worker', DATABASE_URL, MASTER_KEY });
    await until(`conteneur arrêté : ${name}`, () => !running(name), 60_000);
    const logs = logsOf(name);
    expect(docker(['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim(), logs.slice(-3000)).not.toBe('0');
    expect(logs).toMatch(/setpriv: .*(setresuid|setresgid|setgroups|initgroups).*(Operation not permitted|failed)/i);
    expect(logs).not.toMatch(/isolation éprouvée/);
  }, 120_000);
});
