// SPDX-License-Identifier: AGPL-3.0-only
// Banc de capacité de SYM Browser (cdc/sym-browser 06 tâche 0.6) : RSS et temps de démarrage par Chromium chaud, par contexte
// `shared` et par session `dedicated`. Tourne DANS un conteneur Linux (lecture de /proc et du cgroup v2) : voir bench/run.sh.
//
//   node bench/measure.ts --label std --variant shell --reps 30 --out results/<fichier>.json
//
// Cas : `warm_shared` (un Chromium chaud, puis 1 à 8 contextes), `dedicated` (un Chromium lancé pour une session, comme
// 04b §2), `concurrent` (k sessions dedicated lancées ensemble, pour la contention CPU et la mémoire cgroup).
// SÉCURITÉ : le seul signal envoyé l'est par `killOwnChild`, à un pid exact créé par ce script (jamais un groupe de
// processus, jamais une cible désignée par un nom).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { arch, cpus, release } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { cgroupLimitBytes, cgroupMemory, readProcTable, treeOf, treeRssBytes } from './procfs.ts';
import { summarize, type Summary } from './stats.ts';

// --- Playwright (typage minimal : le module racine n'embarque pas playwright-core, le nœud le fait)
type Page = { goto(url: string, options?: { waitUntil?: 'load' }): Promise<unknown> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; version(): string; close(): Promise<void> };
type LaunchServer = { wsEndpoint(): string; close(): Promise<void>; process(): { pid?: number } };
type Chromium = {
  launchServer(options: { headless: boolean; chromiumSandbox?: boolean; channel?: string; args?: string[]; timeout?: number }): Promise<LaunchServer>;
  connect(wsEndpoint: string): Promise<Browser>;
};
const requirePlaywright = createRequire(new URL("../apps/node/package.json", import.meta.url));
const PLAYWRIGHT_SPEC = process.env.BENCH_PLAYWRIGHT_CORE ?? "playwright-core";
const { chromium } = requirePlaywright(PLAYWRIGHT_SPEC) as { chromium: Chromium };

// --- Arguments
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const LABEL = arg('label', 'local');
const VARIANT = arg('variant', 'shell') as 'shell' | 'chromium';
const REPS = Number(arg('reps', '30'));
const CONCURRENCY = Number(arg('concurrency', '2'));
const CASES = arg('cases', 'warm_shared,dedicated,concurrent').split(',');
const OUT = arg('out', '');
const PAGE = arg('page', 'typical') as 'typical' | 'heavy';
const SETTLE_MS = Number(arg('settle-ms', '1500'));
const MAX_CONTEXTS = Number(arg('max-contexts', '8'));
const CHECKPOINTS = new Set([1, 2, 4, 6, 8, MAX_CONTEXTS].filter((n) => n <= MAX_CONTEXTS));
const MIB = 1024 * 1024;
const mib = (bytes: number): number => Math.round((bytes / MIB) * 10) / 10;
const ms = (value: number): number => Math.round(value * 10) / 10;

/** `shell` : `headless: true` de Playwright (chromium-headless-shell). `chromium` : nouveau mode headless du Chromium complet. */
/** Arguments figés du worker de SYM (apps/worker/src/browser/launch.ts, CHROMIUM_SILENT_ARGS) : le nœud les reprend (04b §1). */
const SILENT_ARGS = [
  '--disable-background-networking', '--disable-component-update', '--disable-client-side-phishing-detection', '--safebrowsing-disable-auto-update',
  '--disable-domain-reliability', '--disable-sync', '--disable-default-apps', '--disable-breakpad', '--disable-crash-reporter',
  '--metrics-recording-only', '--no-first-run', '--no-default-browser-check', '--no-pings', '--no-service-autorun',
  '--disable-search-engine-choice-screen', '--disable-dev-shm-usage', '--password-store=basic', '--use-mock-keychain',
];

const launchOptions = (): { headless: boolean; chromiumSandbox: boolean; channel?: string; args: string[]; timeout: number } => ({
  headless: true,
  chromiumSandbox: true,
  ...(VARIANT === 'chromium' ? { channel: 'chromium' } : {}),
  args: SILENT_ARGS,
  timeout: 60_000,
});

// --- Processus enfants : seul pid exact créé par ce script, jamais de signal groupé
const ownChildren = new Set<number>();
function killOwnChild(pid: number): boolean {
  if (!(Number.isInteger(pid) && pid > 1) || !ownChildren.has(pid)) return false;
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

// --- Page de test servie en local (aucun accès réseau)
/** `typical` : ~1 500 lignes, 150 000 objets JS `heavy` : 10× plus (page applicative lourde : 15 000 lignes, 1 500 000 objets ; +235 Mio de mémoire anonyme mesurés). */
function typicalPage(): string {
  const scale = PAGE === 'heavy' ? 10 : 1;
  const svg = (i: number): string => `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="hsl(${i * 12},60%,60%)"/><circle cx="60" cy="40" r="${10 + i}" fill="white"/></svg>`;
  return `<!doctype html><meta charset="utf-8"><title>page de test</title>
<style>body{font:14px sans-serif}.row{display:flex;gap:8px;padding:2px;border-bottom:1px solid #ddd}.row span{flex:1}</style>
<body><div id="app"></div>${Array.from({ length: 30 }, (_, i) => svg(i)).join('')}
<script>
const app = document.getElementById('app');
for (let i = 0; i < 1500 * ${scale}; i++) { const row = document.createElement('div'); row.className = 'row'; row.innerHTML = '<span>ligne ' + i + '</span><span>valeur ' + (i * 7) + '</span>'; app.appendChild(row); }
window.__data = Array.from({ length: 150000 * ${scale} }, (_, i) => ({ i, s: 'item' + i }));
</script></body>`;
}

async function serve(): Promise<{ server: HttpServer; url: string }> {
  const html = typicalPage();
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

// --- Session dedicated : un Chromium lancé pour une session (04b §2)
type Dedicated = { launch: LaunchServer; pid: number; browser: Browser; page: Page; launchMs: number; connectMs: number; pageMs: number; readyMs: number; version: string };

async function startDedicated(url: string): Promise<Dedicated> {
  const t0 = performance.now();
  const launch = await chromium.launchServer(launchOptions());
  const pid = launch.process().pid;
  if (pid === undefined) throw new Error('launchServer sans pid');
  ownChildren.add(pid);
  const t1 = performance.now();
  const browser = await chromium.connect(launch.wsEndpoint());
  const t2 = performance.now();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  const t3 = performance.now();
  return { launch, pid, browser, page, launchMs: t1 - t0, connectMs: t2 - t1, pageMs: t3 - t2, readyMs: t3 - t0, version: browser.version() };
}

/** Arrête un Chromium et compte les processus qui survivent à la fermeture (orphelins). */
async function stop(session: { launch: LaunchServer; pid: number; browser: Browser }, pids: number[]): Promise<{ closeMs: number; orphans: number }> {
  const t0 = performance.now();
  await session.browser.close().catch(() => undefined);
  await Promise.race([session.launch.close(), sleep(10_000).then(() => killOwnChild(session.pid))]).catch(() => undefined);
  const deadline = performance.now() + 3000;
  while (pids.some((p) => existsSync(`/proc/${p}`)) && performance.now() < deadline) await sleep(50);
  const survivors = pids.filter((p) => existsSync(`/proc/${p}`));
  for (const pid of survivors) killOwnChild(pid);
  ownChildren.delete(session.pid);
  return { closeMs: performance.now() - t0, orphans: survivors.length };
}

/** Échantillonne le pic de mémoire anonyme du cgroup (tout le conteneur) pendant qu'une tâche s'exécute. */
function peakSampler(): { stop(): number } {
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, cgroupMemory()?.anonBytes ?? 0);
  }, 50);
  return {
    stop() {
      clearInterval(timer);
      return peak;
    },
  };
}

function log(message: string): void {
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${message}\n`);
}

// --- Cas 1 : Chromium chaud puis contextes shared
async function warmShared(url: string): Promise<unknown> {
  const launchMs: number[] = [];
  const readyMs: number[] = [];
  const idleRss: number[] = [];
  const idlePss: number[] = [];
  const pssDelta: Record<number, number[]> = {};
  const idleProcesses: number[] = [];
  const afterCloseRss: number[] = [];
  const createMs: Record<number, number[]> = {};
  const loadMs: Record<number, number[]> = {};
  const rssDelta: Record<number, number[]> = {};
  const cgroupAnonDelta: Record<number, number[]> = {};
  const orphans: number[] = [];
  let version = '';
  for (let rep = 1; rep <= REPS; rep++) {
    const cg0 = cgroupMemory()?.anonBytes ?? 0;
    const t0 = performance.now();
    const server = await chromium.launchServer(launchOptions());
    const pid = server.process().pid as number;
    ownChildren.add(pid);
    launchMs.push(performance.now() - t0);
    const browser = await chromium.connect(server.wsEndpoint());
    readyMs.push(performance.now() - t0);
    version = browser.version();
    await sleep(SETTLE_MS);
    const idle = treeRssBytes(pid);
    idleRss.push(idle.rssBytes);
    idlePss.push(idle.pssBytes);
    idleProcesses.push(idle.processes);
    const idleCg = (cgroupMemory()?.anonBytes ?? 0) - cg0;
    const contexts: Context[] = [];
    for (let n = 1; n <= MAX_CONTEXTS; n++) {
      const a = performance.now();
      const context = await browser.newContext();
      const page = await context.newPage();
      const b = performance.now();
      await page.goto(url, { waitUntil: 'load' });
      const c = performance.now();
      contexts.push(context);
      (createMs[n] ??= []).push(b - a);
      (loadMs[n] ??= []).push(c - b);
      if (CHECKPOINTS.has(n)) {
        await sleep(SETTLE_MS / 2);
        const tree = treeRssBytes(pid);
        (rssDelta[n] ??= []).push(tree.rssBytes - idle.rssBytes);
        (pssDelta[n] ??= []).push(tree.pssBytes - idle.pssBytes);
        (cgroupAnonDelta[n] ??= []).push((cgroupMemory()?.anonBytes ?? 0) - cg0 - idleCg);
      }
    }
    for (const context of contexts) await context.close();
    await sleep(SETTLE_MS / 2);
    afterCloseRss.push(treeRssBytes(pid).rssBytes - idle.rssBytes);
    orphans.push((await stop({ launch: server, pid, browser }, treeOf(pid, readProcTable()))).orphans);
    if (rep % 5 === 0) log(`warm_shared ${rep}/${REPS}`);
  }
  const perContext = (n: number): { rssMib: Summary; pssMib: Summary; cgroupAnonMib: Summary } => ({
    pssMib: summarize((pssDelta[n] ?? []).map((v) => mib(v / n))),
    rssMib: summarize((rssDelta[n] ?? []).map((v) => mib(v / n))),
    cgroupAnonMib: summarize((cgroupAnonDelta[n] ?? []).map((v) => mib(v / n))),
  });
  // Pente marginale : (RSS au dernier palier − RSS à 1 contexte) / (paliers − 1), par répétition.
  const marginal = (rssDelta[1] ?? []).map((v, i) => mib(((rssDelta[MAX_CONTEXTS]?.[i] ?? v) - v) / (MAX_CONTEXTS - 1)));
  return {
    chromiumVersion: version,
    launchMs: summarize(launchMs.map(ms)),
    readyMs: summarize(readyMs.map(ms)),
    idle: { rssMib: summarize(idleRss.map(mib)), pssMib: summarize(idlePss.map(mib)), processes: summarize(idleProcesses) },
    contextCreateMs: Object.fromEntries(Object.entries(createMs).map(([n, v]) => [n, summarize(v.map(ms))])),
    contextLoadMs: Object.fromEntries(Object.entries(loadMs).map(([n, v]) => [n, summarize(v.map(ms))])),
    perContextAtN: Object.fromEntries([...CHECKPOINTS].map((n) => [n, perContext(n)])),
    totalDeltaAtN: Object.fromEntries([...CHECKPOINTS].map((n) => [n, summarize((rssDelta[n] ?? []).map(mib))])),
    marginalPerContextMib: summarize(marginal),
    afterCloseResidualMib: summarize(afterCloseRss.map(mib)),
    orphansAfterClose: summarize(orphans),
    samples: { launchMs, readyMs, idleRss, rssDelta, marginalPerContextMib: marginal },
  };
}

// --- Cas 2 : session dedicated seule
async function dedicated(url: string): Promise<unknown> {
  const ready: number[] = [];
  const launch: number[] = [];
  const connect: number[] = [];
  const page: number[] = [];
  const rss: number[] = [];
  const pss: number[] = [];
  const cgCur: number[] = [];
  const procs: number[] = [];
  const peakTree: number[] = [];
  const cgFinal: number[] = [];
  const cgPeak: number[] = [];
  const close: number[] = [];
  const orphans: number[] = [];
  let version = '';
  for (let rep = 1; rep <= REPS; rep++) {
    const cg0 = cgroupMemory()?.anonBytes ?? 0;
    const cg0cur = cgroupMemory()?.currentBytes ?? 0;
    const sampler = peakSampler();
    const session = await startDedicated(url);
    version = session.version;
    launch.push(session.launchMs);
    connect.push(session.connectMs);
    page.push(session.pageMs);
    ready.push(session.readyMs);
    let treePeak = 0;
    const until = performance.now() + SETTLE_MS;
    while (performance.now() < until) {
      treePeak = Math.max(treePeak, treeRssBytes(session.pid).rssBytes);
      await sleep(100);
    }
    const tree = treeRssBytes(session.pid);
    rss.push(tree.rssBytes);
    pss.push(tree.pssBytes);
    cgCur.push((cgroupMemory()?.currentBytes ?? 0) - cg0cur);
    procs.push(tree.processes);
    peakTree.push(Math.max(treePeak, tree.rssBytes));
    cgFinal.push((cgroupMemory()?.anonBytes ?? 0) - cg0);
    cgPeak.push(sampler.stop() - cg0);
    const result = await stop(session, treeOf(session.pid, readProcTable()));
    close.push(result.closeMs);
    orphans.push(result.orphans);
    if (rep % 5 === 0) log(`dedicated ${rep}/${REPS}`);
  }
  return {
    chromiumVersion: version,
    startMs: { launch: summarize(launch.map(ms)), connect: summarize(connect.map(ms)), pageLoad: summarize(page.map(ms)), ready: summarize(ready.map(ms)) },
    restRssMib: summarize(rss.map(mib)),
    restPssMib: summarize(pss.map(mib)),
    cgroupCurrentAtRestMib: summarize(cgCur.map(mib)),
    peakRssMib: summarize(peakTree.map(mib)),
    processes: summarize(procs),
    cgroupAnonAtRestMib: summarize(cgFinal.map(mib)),
    cgroupAnonPeakMib: summarize(cgPeak.map(mib)),
    closeMs: summarize(close.map(ms)),
    orphansAfterClose: summarize(orphans),
    samples: { readyMs: ready, restRss: rss, peakRss: peakTree, cgroupAnonAtRest: cgFinal },
  };
}

// --- Cas 3 : k sessions dedicated simultanées
async function concurrent(url: string): Promise<unknown> {
  const ready: number[] = [];
  const perRss: number[] = [];
  const perPss: number[] = [];
  const perCur: number[] = [];
  const perCg: number[] = [];
  const perCgPeak: number[] = [];
  const failures: number[] = [];
  let version = '';
  for (let rep = 1; rep <= REPS; rep++) {
    const cg0 = cgroupMemory()?.anonBytes ?? 0;
    const cg0cur = cgroupMemory()?.currentBytes ?? 0;
    const sampler = peakSampler();
    const settled = await Promise.allSettled(Array.from({ length: CONCURRENCY }, () => startDedicated(url)));
    const sessions = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    failures.push(settled.length - sessions.length);
    for (const s of sessions) {
      ready.push(s.readyMs);
      version = s.version;
    }
    await sleep(SETTLE_MS);
    if (sessions.length > 0) {
      perRss.push(sessions.reduce((sum, s) => sum + treeRssBytes(s.pid).rssBytes, 0) / sessions.length);
      perPss.push(sessions.reduce((sum, s) => sum + treeRssBytes(s.pid).pssBytes, 0) / sessions.length);
      perCur.push(((cgroupMemory()?.currentBytes ?? 0) - cg0cur) / sessions.length);
      perCg.push(((cgroupMemory()?.anonBytes ?? 0) - cg0) / sessions.length);
      perCgPeak.push((sampler.stop() - cg0) / sessions.length);
    } else sampler.stop();
    for (const s of sessions) await stop(s, treeOf(s.pid, readProcTable()));
    if (rep % 5 === 0) log(`concurrent(k=${CONCURRENCY}) ${rep}/${REPS}`);
  }
  return {
    chromiumVersion: version,
    concurrency: CONCURRENCY,
    readyMs: summarize(ready.map(ms)),
    perSessionRssMib: summarize(perRss.map(mib)),
    perSessionPssMib: summarize(perPss.map(mib)),
    perSessionCgroupCurrentMib: summarize(perCur.map(mib)),
    perSessionCgroupAnonMib: summarize(perCg.map(mib)),
    perSessionCgroupAnonPeakMib: summarize(perCgPeak.map(mib)),
    failedLaunches: summarize(failures),
    samples: { readyMs: ready, perSessionRss: perRss, perSessionCgroupAnon: perCg },
  };
}

// --- Cas 4 : saturation (combien de sessions dedicated tiennent sous 90 % de la limite du cgroup, seuil de recyclage 04b §4)
async function saturate(url: string): Promise<unknown> {
  const limit = cgroupLimitBytes();
  if (limit === undefined) throw new Error('saturate exige une limite mémoire de cgroup (--memory)');
  const fitsUnder90: number[] = [];
  const perSessionCurrent: number[] = [];
  const currentAtFits: number[] = [];
  const failures: number[] = [];
  for (let rep = 1; rep <= REPS; rep++) {
    const base = cgroupMemory()?.currentBytes ?? 0;
    const sessions: Dedicated[] = [];
    let fits = 0;
    let failed = 0;
    let lastCurrent = base;
    try {
      while (sessions.length < 16) {
        // Garde-fou : ne lance pas un Chromium de plus si le suivant (estimé au coût moyen +10 %) franchirait 97 % de la limite.
        const average = sessions.length > 0 ? (lastCurrent - base) / sessions.length : 0;
        if (lastCurrent + average * 1.1 > limit * 0.97) break;
        sessions.push(await startDedicated(url));
        await sleep(700);
        lastCurrent = cgroupMemory()?.currentBytes ?? lastCurrent;
        if (lastCurrent < limit * 0.9) {
          fits = sessions.length;
          currentAtFits.push(lastCurrent - base);
        } else break;
      }
    } catch {
      failed = 1;
    }
    fitsUnder90.push(fits);
    failures.push(failed);
    if (sessions.length > 0) perSessionCurrent.push((lastCurrent - base) / sessions.length);
    for (const session of sessions) await stop(session, treeOf(session.pid, readProcTable()));
    if (rep % 5 === 0) log(`saturate ${rep}/${REPS}`);
  }
  return {
    limitMib: mib(limit),
    sessionsUnder90Percent: summarize(fitsUnder90),
    perSessionCgroupCurrentMib: summarize(perSessionCurrent.map(mib)),
    failedLaunches: summarize(failures),
    samples: { fitsUnder90, perSessionCurrent },
  };
}

// --- Cas 6 : dérive d'un Chromium chaud qui sert des sessions shared à la suite (base de RECYCLE_AFTER_SESSIONS, 04b §4)
async function leak(url: string): Promise<unknown> {
  const CYCLES = Number(arg('cycles', '100'));
  const STEP = 10;
  const drift: number[] = [];
  const driftPer50Pss: number[] = [];
  const driftPer50Anon: number[] = [];
  const endPss: number[] = [];
  for (let rep = 1; rep <= REPS; rep++) {
    const cg0 = cgroupMemory()?.anonBytes ?? 0;
    const server = await chromium.launchServer(launchOptions());
    const pid = server.process().pid as number;
    ownChildren.add(pid);
    const browser = await chromium.connect(server.wsEndpoint());
    const samples: { cycle: number; rss: number; pss: number; anon: number }[] = [];
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'load' });
      await context.close();
      if (cycle % STEP === 0) {
        await sleep(300);
        const tree = treeRssBytes(pid);
        samples.push({ cycle, rss: tree.rssBytes, pss: tree.pssBytes, anon: (cgroupMemory()?.anonBytes ?? 0) - cg0 });
      }
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (first && last && last.cycle > first.cycle) {
      const per50 = 50 / (last.cycle - first.cycle);
      drift.push((last.rss - first.rss) * per50);
      driftPer50Pss.push((last.pss - first.pss) * per50);
      driftPer50Anon.push((last.anon - first.anon) * per50);
      endPss.push(last.pss);
    }
    await stop({ launch: server, pid, browser }, treeOf(pid, readProcTable()));
    if (rep % 5 === 0) log(`leak ${rep}/${REPS}`);
  }
  return {
    cycles: CYCLES,
    driftRssMibPer50Sessions: summarize(drift.map(mib)),
    driftPssMibPer50Sessions: summarize(driftPer50Pss.map(mib)),
    driftCgroupAnonMibPer50Sessions: summarize(driftPer50Anon.map(mib)),
    endPssMib: summarize(endPss.map(mib)),
    samples: { drift, driftPer50Pss, driftPer50Anon },
  };
}

// --- Cas 5 : base du nœud hors Chromium (processus Node avec playwright-core chargé et un serveur HTTP)
async function nodeBase(): Promise<unknown> {
  const { spawnSync } = await import('node:child_process');
  const code = `const { createRequire } = await import("node:module"); const r = createRequire(process.cwd() + "/x"); r(process.env.BENCH_PLAYWRIGHT_CORE ?? "playwright-core"); const http = await import("node:http"); http.createServer(() => {}).listen(0, "127.0.0.1"); await new Promise((ok) => setTimeout(ok, 1000)); console.log(process.memoryUsage().rss); process.exit(0);`;
  const rss: number[] = [];
  for (let rep = 1; rep <= REPS; rep++) {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: process.env, cwd: process.env.BENCH_PLAYWRIGHT_CORE ? '/' : process.cwd() });
    rss.push(Number(out.stdout.trim()));
  }
  return { nodeRssMib: summarize(rss.map(mib)), samples: { rss } };
}

// --- Exécution
const { server: http, url } = await serve();
const startedAt = new Date().toISOString();
const results: Record<string, unknown> = {};
const runners: Record<string, () => Promise<unknown>> = {
  warm_shared: () => warmShared(url),
  dedicated: () => dedicated(url),
  concurrent: () => concurrent(url),
  saturate: () => saturate(url),
  node_base: () => nodeBase(),
  leak: () => leak(url),
};
try {
  for (const name of CASES) {
    const run = runners[name];
    if (!run) throw new Error(`cas inconnu : ${name}`);
    log(`cas ${name} : ${REPS} répétitions, variante ${VARIANT}, profil ${LABEL}`);
    results[name] = await run();
  }
} finally {
  http.close();
  for (const pid of [...ownChildren]) killOwnChild(pid);
}
const report = {
  meta: {
    task: '0.6',
    startedAt,
    label: LABEL,
    variant: VARIANT,
    reps: REPS,
    maxContexts: MAX_CONTEXTS,
    concurrency: CONCURRENCY,
    settleMs: SETTLE_MS,
    page: PAGE === 'heavy' ? 'lourde : 15 000 lignes DOM, 30 SVG inline, ~1 500 000 objets JS' : 'typique : 1 500 lignes DOM, 30 SVG inline, ~150 000 objets JS',
    pageKind: PAGE,
    playwright: (requirePlaywright(`${PLAYWRIGHT_SPEC}/package.json`) as { version: string }).version,
    node: process.version,
    arch: arch(),
    kernel: release(),
    cpuModel: cpus()[0]?.model ?? 'inconnu',
    cpuVisible: cpus().length,
    cgroupMemoryLimitMib: cgroupLimitBytes() === undefined ? null : mib(cgroupLimitBytes() as number),
  },
  results,
};
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  log(`résultats écrits : ${OUT}`);
} else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
