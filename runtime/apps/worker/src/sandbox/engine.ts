// SPDX-License-Identifier: AGPL-3.0-only
// `SandboxEngine` par processus enfant (INV7, 08 §3) : un enfant dédié par run, environnement VIDE (`env: {}` puis
// vérification), `--no-node-snapshot`, mode permission de Node en ceinture, isolat dans l'enfant, ponts relayés par IPC
// et appliqués ici. Utilisateur dédié (uid distinct du worker, obligatoire en production) via un lanceur setpriv sans
// nouveaux privilèges. Plafonds : temps mur, temps CPU (RLIMIT_CPU), RSS du processus, octets reçus ; SIGKILL mesuré sur
// le processus. Toute violation tue l'enfant aussitôt.
import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  SandboxBridges,
  SandboxEngine,
  SandboxEngineId,
  SandboxLimits,
  SandboxOutcome,
  SandboxResult,
  SandboxRunOptions,
  SandboxViolation,
} from '@runtime/core';
import { SandboxBridgeError } from './bridges.js';
import { parseChildMessage, type ChildMessage, type ParentMessage } from './protocol.js';

type DoneMessage = Extract<ChildMessage, { t: 'done' }>;
import { assertSandboxSupported } from './version.js';

export const DEFAULT_SANDBOX_LIMITS: Required<Pick<SandboxLimits, 'timeoutMs' | 'memoryMb'>> = {
  timeoutMs: 30_000,
  memoryMb: 128, // 08 §3, à valider
};

/** Variables que la plateforme ajoute d'elle-même à un environnement vide (macOS : CoreFoundation). */
const PLATFORM_ENV: Readonly<Record<string, readonly string[]>> = { darwin: ['__CF_USER_TEXT_ENCODING'] };

/** Variables visibles par l'enfant hors celles que la plateforme injecte (doit être vide). */
export function unexpectedEnvKeys(keys: readonly string[], platform: string = process.platform): string[] {
  const tolerated = new Set(PLATFORM_ENV[platform] ?? []);
  return keys.filter((k) => !tolerated.has(k));
}

export type ProcessSandboxOptions = {
  /** Moteur d'isolat dans l'enfant (défaut isolated-vm ; `quickjs` = spike). */
  engine?: SandboxEngineId;
  /** Délai de démarrage de l'enfant (jusqu'au message `ready`). */
  startupTimeoutMs?: number;
  /**
   * Utilisateur et groupe dédiés de l'enfant, distincts de ceux du worker : l'enfant ne peut alors lire ni
   * `/proc/<ppid>/environ` ni le fichier de clé. Obligatoires en production. Sans `launcher`, ils sont posés par
   * `spawn` (le worker doit alors pouvoir changer d'uid, en pratique tourner en root).
   */
  uid?: number;
  gid?: number;
  /**
   * Lanceur qui change d'utilisateur pour l'enfant : un `setpriv` (util-linux) doté des seules capacités
   * `cap_setuid,cap_setgid` et exécutable par le groupe du worker (deploy/Dockerfile). Appelé avec `--no-new-privs`.
   */
  launcher?: string;
  /** Production : refuse de démarrer si l'enfant tournerait sous l'uid du worker (défaut : NODE_ENV=production). */
  production?: boolean;
  /** Mode permission de Node sur l'enfant (défaut vrai). */
  permission?: boolean;
  /** Diagnostic (tests) : pid et variables vues par l’enfant. */
  onChildReady?: (info: { pid: number; envKeys: readonly string[] }) => void;
};

/** Options d'utilisateur dédié lues dans l'environnement du worker (SANDBOX_UID, SANDBOX_GID, SANDBOX_LAUNCHER). */
export function sandboxOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): Pick<ProcessSandboxOptions, 'uid' | 'gid' | 'launcher'> {
  const id = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    if (!/^\d{1,10}$/.test(raw)) throw new Error(`bac à sable : ${name} doit être un identifiant numérique`);
    return Number(raw);
  };
  const uid = id('SANDBOX_UID');
  const gid = id('SANDBOX_GID');
  if ((uid === undefined) !== (gid === undefined)) throw new Error('bac à sable : SANDBOX_UID et SANDBOX_GID vont ensemble');
  const launcher = env.SANDBOX_LAUNCHER === undefined || env.SANDBOX_LAUNCHER === '' ? undefined : env.SANDBOX_LAUNCHER;
  return { ...(uid !== undefined ? { uid } : {}), ...(gid !== undefined ? { gid } : {}), ...(launcher !== undefined ? { launcher } : {}) };
}

/**
 * Script du shell de lancement. `env -i` retire ce que le shell exporte de lui-même (PWD, SHLVL…) mais garde le canal
 * IPC que Node passe à l'enfant (NODE_CHANNEL_*), que l'enfant retire de son environnement au démarrage.
 */
const LAUNCH_SCRIPT =
  'ulimit -S -t "$0" && ulimit -H -t $(($0 + 1)) && exec /usr/bin/env -i ' +
  '${NODE_CHANNEL_FD+"NODE_CHANNEL_FD=$NODE_CHANNEL_FD"} ' +
  '${NODE_CHANNEL_SERIALIZATION_MODE+"NODE_CHANNEL_SERIALIZATION_MODE=$NODE_CHANNEL_SERIALIZATION_MODE"} "$@"';

/** Commande de lancement de l'enfant (pure, testée) : plafond CPU, environnement vidé, changement d'utilisateur. */
export type SpawnPlan = { command: string; args: string[]; uid?: number; gid?: number };

/**
 * `/bin/sh` pose RLIMIT_CPU (souple N puis dur N + 1, dans cet ordre : SIGXCPU d’abord, SIGKILL ensuite), puis `env -i` rend un
 * environnement vide (le shell en ajoute), puis le lanceur change d'utilisateur sans nouveaux privilèges, puis Node.
 * Chaque étape fait `exec` : le pid suivi par le parent reste celui de l'enfant.
 */
export function spawnPlan(p: {
  node: string;
  nodeArgs: readonly string[];
  /** Script de l'enfant ; absent pour `node -e` (sonde). */
  script?: string;
  cpuSeconds: number;
  launcher?: string;
  uid?: number;
  gid?: number;
}): SpawnPlan {
  const node = [p.node, ...p.nodeArgs, ...(p.script === undefined ? [] : [p.script])];
  const switched =
    p.launcher !== undefined && p.uid !== undefined && p.gid !== undefined
      ? [p.launcher, `--reuid=${p.uid}`, `--regid=${p.gid}`, '--clear-groups', '--no-new-privs', '--', ...node]
      : node;
  const cpu = String(Math.max(1, Math.ceil(p.cpuSeconds)));
  const plan: SpawnPlan = {
    command: '/bin/sh',
    args: ['-c', LAUNCH_SCRIPT, cpu, ...switched],
  };
  if (p.launcher === undefined && p.uid !== undefined) return { ...plan, uid: p.uid, gid: p.gid };
  return plan;
}

/**
 * Arrêt forcé d'un enfant lancé sous un autre uid : le worker n'a pas CAP_KILL, kill(2) rendrait EPERM. Le lanceur
 * reprend l'uid de l'enfant (sans nouveaux privilèges) et envoie SIGKILL. `undefined` : `child.kill` suffit (même uid,
 * ou worker root). Le pid ne peut pas être réattribué tant que le parent n'a pas récolté l'enfant (zombie) ; l'appel
 * n'est fait que si Node n'a pas encore vu sa fin.
 */
export function killPlan(
  o: Pick<ProcessSandboxOptions, 'launcher' | 'uid' | 'gid'>,
  pid: number,
): { command: string; args: string[] } | undefined {
  if (o.launcher === undefined || o.uid === undefined || o.gid === undefined) return undefined;
  return {
    command: o.launcher,
    args: [`--reuid=${o.uid}`, `--regid=${o.gid}`, '--clear-groups', '--no-new-privs', '--', '/bin/kill', '-KILL', String(pid)],
  };
}

/** Résultat de `probeIsolation` : ce que voit un processus lancé comme l'enfant, hors mode permission de Node. */
export type IsolationProbe = {
  uid: number | undefined;
  /** `/proc/<ppid>/environ` : `denied` (attendu), `readable` (trou), `absent` (pas de /proc). */
  parentEnviron: 'denied' | 'readable' | 'absent';
  /** Linux : bit no_new_privs posé. */
  noNewPrivs: boolean | undefined;
};

const PROBE_SCRIPT = `
const fs = require('node:fs');
let parentEnviron = 'absent';
try { fs.readFileSync('/proc/' + process.ppid + '/environ'); parentEnviron = 'readable'; }
catch (e) { parentEnviron = e && e.code === 'ENOENT' ? 'absent' : 'denied'; }
let noNewPrivs;
try { noNewPrivs = /^NoNewPrivs:\\s+1$/m.test(fs.readFileSync('/proc/self/status', 'utf8')); } catch (e) {}
process.stdout.write(JSON.stringify({ uid: process.getuid ? process.getuid() : undefined, parentEnviron, noNewPrivs }));`;

/**
 * Chemins d'un paquet résolu depuis `from` : lien symbolique (tel que la résolution le lit), cible réelle, et dossier
 * `node_modules` de la cible (pnpm y range les liens vers ses dépendances). `undefined` si le paquet est absent.
 */
function packagePaths(fromDir: string, name: string): { real: string; paths: string[] } | undefined {
  // Recherche à la manière de Node (dossiers node_modules des ancêtres), sans dépendre du champ `exports`.
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      const real = realpathSync(candidate);
      return { real, paths: [candidate, real, dirname(real)] };
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Chemins lisibles par l'enfant sous `--permission` : son script et les paquets du moteur, rien d'autre. */
function childReadPaths(childFile: string, engine: SandboxEngineId): string[] {
  const here = dirname(childFile);
  const paths = [here];
  // Portée ESM : le chargeur lit le package.json de l'application pour connaître le type de module.
  paths.push(join(here, '..', '..', 'package.json'));
  const add = (from: string, name: string, deps: readonly string[]) => {
    const pkg = packagePaths(from, name);
    if (pkg === undefined) return;
    paths.push(...pkg.paths);
    for (const dep of deps) paths.push(...(packagePaths(pkg.real, dep)?.paths ?? []));
  };
  if (engine === 'isolated-vm') {
    add(here, 'isolated-vm', ['node-gyp-build']);
    // node-gyp-build teste ce fichier (musl ou glibc) sous Linux pour choisir le binaire précompilé.
    if (process.platform === 'linux') paths.push('/etc/alpine-release');
  }
  else {
    add(here, 'quickjs-emscripten-core', ['@jitl/quickjs-ffi-types']);
    add(here, '@jitl/quickjs-wasmfile-release-sync', ['@jitl/quickjs-ffi-types']);
  }
  return [...new Set(paths)];
}

async function linuxRssMb(pid: number): Promise<number | undefined> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
    return kb === undefined ? undefined : Math.round(Number(kb) / 1024);
  } catch {
    return undefined;
  }
}

/** `import(` ou `import.meta` en clair dans le code (y compris dans une chaîne passée à eval). */
const FORBIDDEN_IMPORT = /\bimport\s*(?:\(|\.\s*meta\b)/;
/** Violations retenues par run (l'enfant est tué à la première ; borne contre l'inondation des journaux). */
const MAX_VIOLATIONS = 32;

function messageBytes(message: ChildMessage): number {
  switch (message.t) {
    case 'call':
    case 'log':
    case 'emit':
      return message.payload.length;
    case 'done':
      return (message.value?.length ?? 0) + (message.error?.length ?? 0);
    case 'ready':
      return message.envKeys.reduce((n, k) => n + k.length, 0);
    default:
      return 0;
  }
}

export class ProcessSandboxEngine implements SandboxEngine {
  readonly id: SandboxEngineId;
  readonly #options: ProcessSandboxOptions;
  readonly #childFile: string;
  readonly #readPaths: string[];

  constructor(options: ProcessSandboxOptions = {}) {
    this.id = options.engine ?? 'isolated-vm';
    if (this.id === 'isolated-vm') assertSandboxSupported();
    // 08 §3 « utilisateur sans droits », INV7 « sans secrets » : à uid égal, un code natif évadé de l'isolat lirait
    // /proc/<ppid>/environ (MASTER_KEY, DATABASE_URL) malgré --permission, qui n'est contrôlé qu'en espace utilisateur.
    if ((options.production ?? process.env.NODE_ENV === 'production') && (options.uid === undefined || options.uid === process.getuid?.())) {
      throw new Error(
        "bac à sable : utilisateur dédié requis en production (SANDBOX_UID/SANDBOX_GID distincts de l'uid du worker, SANDBOX_LAUNCHER)",
      );
    }
    this.#options = options;
    const self = import.meta.url;
    this.#childFile = fileURLToPath(new URL(self.endsWith('.ts') ? './child.ts' : './child.js', self));
    this.#readPaths = childReadPaths(this.#childFile, this.id);
  }

  #plan(nodeArgs: readonly string[], script: string | undefined, cpuSeconds: number): SpawnPlan {
    const { launcher, uid, gid } = this.#options;
    return spawnPlan({ node: process.execPath, nodeArgs, script, cpuSeconds, launcher, uid, gid });
  }

  /**
   * Éprouve la frontière de l'OS : lance, par le même chemin que l'enfant (lanceur, uid, environnement vide, plafond
   * CPU) mais sans --permission, un Node qui tente de lire l'environnement du parent. Au démarrage du worker (1.6) :
   * refuser de servir si `parentEnviron` vaut `readable`.
   */
  probeIsolation(): Promise<IsolationProbe> {
    const plan = this.#plan(['-e', PROBE_SCRIPT], undefined, 5);
    return new Promise((resolve, reject) => {
      execFile(plan.command, plan.args, { env: {}, uid: plan.uid, gid: plan.gid, timeout: 10_000, cwd: dirname(this.#childFile) }, (err, stdout) => {
        if (err !== null) {
          reject(new Error(`bac à sable : sonde d'isolation en échec (${err.message.slice(0, 200)})`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as IsolationProbe);
        } catch {
          reject(new Error("bac à sable : sonde d'isolation illisible"));
        }
      });
    });
  }

  run(code: string, bridges: SandboxBridges, limits: SandboxLimits, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    // Import dynamique en clair : refusé avant tout lancement (isolated-vm n'a pas de crochet d'import).
    if (FORBIDDEN_IMPORT.test(code)) {
      const v: SandboxViolation = { reason: 'forbidden_import', detail: 'import()' };
      bridges.violation(v);
      return Promise.resolve({ engine: this.id, outcome: 'violation', violations: [v], durationMs: 0, killed: false });
    }
    const timeoutMs = limits.timeoutMs;
    const memoryMb = limits.memoryMb;
    const processMemoryMb = limits.processMemoryMb ?? memoryMb * 3 + 192;
    const maxResultBytes = limits.maxResultBytes ?? 10 * 1024 * 1024;
    const maxIpcBytes = limits.maxIpcBytes ?? 128 * 1024 * 1024;
    const cpuSeconds = limits.cpuLimitSeconds ?? Math.ceil((2 * timeoutMs) / 1000) + 5;
    const inputJson = JSON.stringify(options.input ?? null);
    const permission = this.#options.permission ?? true;
    // Tas de l'enfant (hors isolat) : file IPC sortante de 64 Mio au plus (child.ts) et sa sérialisation.
    const args = ['--no-node-snapshot', '--max-old-space-size=256'];
    if (permission) args.push('--permission', '--allow-addons', ...this.#readPaths.map((p) => `--allow-fs-read=${p}`));
    const plan = this.#plan(args, this.#childFile, cpuSeconds);

    const started = performance.now();
    const child = spawn(plan.command, plan.args, {
      env: {}, // INV7 : ni MASTER_KEY, ni DATABASE_URL, ni clé LLM ; `env -i` en plus, vérifié à `ready`
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      cwd: dirname(this.#childFile),
      uid: plan.uid,
      gid: plan.gid,
    });
    // Sorties de l'enfant drainées et ignorées (avertissement --allow-addons, traces) : aucun canal vers le script.
    child.stdout?.resume();
    child.stderr?.resume();

    const violations: SandboxViolation[] = [];
    const report = (v: SandboxViolation) => {
      if (violations.length >= MAX_VIOLATIONS) return;
      violations.push(v);
      bridges.violation(v);
    };

    return new Promise<SandboxResult>((resolve) => {
      let outcome: SandboxOutcome | undefined;
      let value: unknown;
      let error: string | undefined;
      let killed = false;
      let killRequestedAt: number | undefined;
      let peakRssMb: number | undefined;
      let running = false;
      const timers: NodeJS.Timeout[] = [];
      const inflight = new Set<Promise<void>>();

      const exited = () => child.exitCode !== null || child.signalCode !== null;
      let killTries = 0;
      const kill = (at = performance.now()) => {
        if (exited() || killRequestedAt !== undefined) return;
        killRequestedAt = at;
        const once = () => {
          if (exited() || killTries++ >= 5) return;
          // Même uid (ou avant le changement d'uid) : signal direct ; sinon EPERM, ignoré, et le lanceur prend le relais.
          child.kill('SIGKILL');
          const viaLauncher = child.pid === undefined ? undefined : killPlan(this.#options, child.pid);
          if (viaLauncher !== undefined) execFile(viaLauncher.command, viaLauncher.args, { env: {}, timeout: 5000 }, () => undefined);
          // Filet : nouvel essai tant que la fin du processus n'est pas constatée.
          setTimeout(once, 300).unref();
        };
        once();
      };
      /** Premier verdict retenu ; l'enfant est tué dans tous les cas (un enfant par run). */
      const settle = (o: SandboxOutcome, opts: { byLimit?: boolean; at?: number } = {}) => {
        if (outcome !== undefined) return;
        outcome = o;
        if (opts.byLimit === true) killed = true;
        kill(opts.at);
      };
      /** Violation : journalisée, puis l'enfant est tué aussitôt (une tentative suffit, pas de boucle de violations). */
      const violate = (v: SandboxViolation) => {
        report(v);
        settle('violation', { byLimit: true });
      };
      let ipcBytes = 0;
      const send = (message: ParentMessage) => {
        if (child.connected) child.send(message, (err) => void err);
      };
      const reply = (id: number, ok: boolean, payload: string) => send({ t: 'reply', id, ok, payload });
      const refuse = (err: unknown): string => {
        if (err instanceof SandboxBridgeError) {
          if (err.violation) violate({ reason: err.code as SandboxViolation['reason'], detail: err.detail });
          return err.code;
        }
        return 'bridge_error';
      };
      const observeRss = (mb: number) => {
        peakRssMb = Math.max(peakRssMb ?? 0, mb);
        if (mb > processMemoryMb && outcome === undefined) {
          report({ reason: 'memory_limit', detail: `rss ${mb} Mo` });
          settle('memory', { byLimit: true });
        }
      };

      timers.push(
        setTimeout(() => {
          if (!running && outcome === undefined) {
            error = 'démarrage du bac à sable trop long';
            report({ reason: 'child_crashed', detail: 'démarrage' });
            settle('crashed', { byLimit: true });
          }
        }, this.#options.startupTimeoutMs ?? 10_000),
      );
      if (process.platform === 'linux') {
        const poll = setInterval(() => {
          if (child.pid !== undefined) void linuxRssMb(child.pid).then((mb) => mb !== undefined && observeRss(mb));
        }, 100);
        timers.push(poll);
      }

      const onDone = (message: DoneMessage) => {
        if (outcome !== undefined) return;
        error = message.error;
        if (message.outcome === 'timeout') {
          report({ reason: 'time_limit', detail: `${timeoutMs} ms` });
          settle('timeout', { byLimit: true });
        } else if (message.outcome === 'memory') {
          report({ reason: 'memory_limit', detail: `isolat ${memoryMb} Mo` });
          settle('memory', { byLimit: true });
        } else if (message.outcome === 'ok') {
          const raw = message.value ?? 'null';
          if (Buffer.byteLength(raw) > maxResultBytes) {
            violate({ reason: 'output_limit', detail: 'résultat' });
            return;
          }
          try {
            value = JSON.parse(raw);
          } catch {
            violate({ reason: 'protocol', detail: 'résultat' });
            return;
          }
          settle(violations.length > 0 ? 'violation' : 'ok');
        } else if (message.outcome === 'engine_error') {
          report({ reason: 'child_crashed', detail: 'moteur' });
          settle('crashed', { byLimit: true });
        } else settle(violations.length > 0 ? 'violation' : 'script_error');
      };

      child.on('message', (raw: unknown) => {
        // Verdict rendu : l'enfant est en cours d'arrêt, ses derniers messages sont ignorés.
        if (outcome !== undefined) return;
        const message = parseChildMessage(raw);
        if (message === undefined) {
          violate({ reason: 'protocol' });
          return;
        }
        // Budget d'octets reçus sur le run (chaque message compte au moins 256 octets : une rafale de petits messages
        // coûte aussi au parent).
        ipcBytes += Math.max(256, messageBytes(message));
        if (ipcBytes > maxIpcBytes) {
          violate({ reason: 'output_limit', detail: 'ipc' });
          return;
        }
        switch (message.t) {
          case 'ready': {
            const leaked = unexpectedEnvKeys(message.envKeys);
            if (child.pid !== undefined) this.#options.onChildReady?.({ pid: child.pid, envKeys: message.envKeys });
            if (leaked.length > 0) {
              violate({ reason: 'env_not_empty', detail: `${leaked.length} variable(s)` });
              return;
            }
            if (running) return;
            running = true;
            const deadline = performance.now() + timeoutMs;
            timers.push(
              setTimeout(() => {
                if (outcome !== undefined) return;
                report({ reason: 'time_limit', detail: `${timeoutMs} ms` });
                settle('timeout', { byLimit: true, at: deadline });
              }, timeoutMs),
            );
            send({ t: 'run', engine: this.id, code, inputJson, limits: { timeoutMs, memoryMb, maxIpcBytes } });
            return;
          }
          case 'rss':
            observeRss(message.mb);
            return;
          case 'call': {
            const target =
              message.bridge === 'fetch'
                ? bridges.fetch(message.payload)
                : bridges.page === undefined
                  ? Promise.reject(new SandboxBridgeError('page_unavailable', false))
                  : bridges.page(message.payload);
            const call = target.then(
              (response) => reply(message.id, true, JSON.stringify(response)),
              (err: unknown) => reply(message.id, false, refuse(err)),
            );
            inflight.add(call);
            void call.finally(() => inflight.delete(call));
            return;
          }
          case 'log':
            try {
              bridges.log(message.payload);
            } catch (err) {
              refuse(err);
            }
            return;
          case 'emit':
            try {
              bridges.emit(message.payload);
            } catch (err) {
              refuse(err);
            }
            return;
          case 'violation':
            violate({ reason: message.reason, detail: message.detail });
            return;
          case 'done':
            if (outcome !== undefined) return;
            // Un appel de pont lâché par le script (promesse non attendue) peut encore être refusé : on attend son
            // verdict, requêtes en vol annulées, avant de rendre le résultat.
            if (inflight.size > 0) {
              bridges.close?.();
              void Promise.allSettled([...inflight]).then(() => onDone(message));
            } else onDone(message);
            return;
        }
      });

      const finish = () => {
        const exitedAt = performance.now();
        for (const t of timers) clearTimeout(t);
        bridges.close?.();
        if (outcome === undefined && child.signalCode === 'SIGXCPU') {
          // RLIMIT_CPU atteint : le système a arrêté l'enfant (plafond CPU au niveau du processus).
          outcome = 'timeout';
          killed = true;
          report({ reason: 'time_limit', detail: 'cpu' });
        }
        if (outcome === undefined) {
          // Sortie spontanée de l'enfant (plantage, abort sur erreur catastrophique de l'isolat).
          outcome = 'crashed';
          report({ reason: 'child_crashed', detail: String(child.signalCode ?? child.exitCode ?? 'inconnu') });
          error ??= `enfant arrêté (${child.signalCode ?? child.exitCode ?? 'inconnu'})`;
        }
        const result: SandboxResult = {
          engine: this.id,
          outcome,
          ...(outcome === 'ok' ? { value } : {}),
          ...(error !== undefined && outcome !== 'ok' ? { error } : {}),
          violations: [...violations],
          durationMs: Math.round(exitedAt - started),
          killed,
          ...(killed && killRequestedAt !== undefined ? { killLatencyMs: Math.round(exitedAt - killRequestedAt) } : {}),
          ...(peakRssMb !== undefined ? { peakRssMb } : {}),
        };
        resolve(result);
      };
      // Annulation du run : l'enfant est tué (aucune sortie retenue).
      const onAbort = () => {
        if (outcome !== undefined) return;
        error = 'run interrompu';
        settle('crashed', { byLimit: true });
      };
      if (options.signal?.aborted === true) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
      // Violations constatées par l'hôte hors pont (navigateur) : même verdict qu'une violation de pont.
      options.watch?.((v) => {
        if (outcome === undefined) violate(v);
      });
      child.once('exit', () => {
        options.signal?.removeEventListener('abort', onAbort);
        finish();
      });
      // Lancement impossible (pas de pid) : fin immédiate. Les autres erreurs (signal refusé, envoi IPC) sont ignorées.
      child.on('error', (err) => {
        if (child.pid !== undefined) return;
        error = err.message;
        finish();
      });
    });
  }
}
