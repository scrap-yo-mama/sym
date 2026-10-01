// SPDX-License-Identifier: AGPL-3.0-only
// `SandboxEngine` par processus enfant (INV7, 08 §3) : un enfant dédié par run, environnement VIDE (`env: {}` puis
// vérification), `--no-node-snapshot`, mode permission de Node en ceinture, isolat dans l'enfant, ponts relayés par IPC
// et appliqués ici. Plafonds : temps (mur) et RSS du processus, SIGKILL mesuré sur le processus.
import { spawn } from 'node:child_process';
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
  /** Délai de démarrage de l'enfant (chargement du moteur compris). */
  startupTimeoutMs?: number;
  /** Utilisateur et groupe sans droits pour l'enfant (si le worker tourne en root). */
  uid?: number;
  gid?: number;
  /** Mode permission de Node sur l'enfant (défaut vrai). */
  permission?: boolean;
  /** Diagnostic (tests) : pid et variables vues par l’enfant. */
  onChildReady?: (info: { pid: number; envKeys: readonly string[] }) => void;
};

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

export class ProcessSandboxEngine implements SandboxEngine {
  readonly id: SandboxEngineId;
  readonly #options: ProcessSandboxOptions;
  readonly #childFile: string;
  readonly #readPaths: string[];

  constructor(options: ProcessSandboxOptions = {}) {
    this.id = options.engine ?? 'isolated-vm';
    if (this.id === 'isolated-vm') assertSandboxSupported();
    this.#options = options;
    const self = import.meta.url;
    this.#childFile = fileURLToPath(new URL(self.endsWith('.ts') ? './child.ts' : './child.js', self));
    this.#readPaths = childReadPaths(this.#childFile, this.id);
  }

  run(code: string, bridges: SandboxBridges, limits: SandboxLimits, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    const timeoutMs = limits.timeoutMs;
    const memoryMb = limits.memoryMb;
    const processMemoryMb = limits.processMemoryMb ?? memoryMb * 3 + 192;
    const maxResultBytes = limits.maxResultBytes ?? 10 * 1024 * 1024;
    const inputJson = JSON.stringify(options.input ?? null);
    const permission = this.#options.permission ?? true;
    const args = ['--no-node-snapshot', '--max-old-space-size=64'];
    if (permission) args.push('--permission', '--allow-addons', ...this.#readPaths.map((p) => `--allow-fs-read=${p}`));
    args.push(this.#childFile);

    const started = performance.now();
    const child = spawn(process.execPath, args, {
      env: {}, // INV7 : ni MASTER_KEY, ni DATABASE_URL, ni clé LLM ; vérifié à `ready`
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      cwd: dirname(this.#childFile),
      uid: this.#options.uid,
      gid: this.#options.gid,
    });
    // Sorties de l'enfant drainées et ignorées (avertissement --allow-addons, traces) : aucun canal vers le script.
    child.stdout?.resume();
    child.stderr?.resume();

    const violations: SandboxViolation[] = [];
    const report = (v: SandboxViolation) => {
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

      const kill = (at = performance.now()) => {
        if (child.exitCode === null && child.signalCode === null && !child.killed) {
          killRequestedAt ??= at;
          child.kill('SIGKILL');
        }
      };
      /** Premier verdict retenu ; l'enfant est tué dans tous les cas (un enfant par run). */
      const settle = (o: SandboxOutcome, opts: { byLimit?: boolean; at?: number } = {}) => {
        if (outcome !== undefined) return;
        outcome = o;
        if (opts.byLimit === true) killed = true;
        kill(opts.at);
      };
      const send = (message: ParentMessage) => {
        if (child.connected) child.send(message, (err) => void err);
      };
      const reply = (id: number, ok: boolean, payload: string) => send({ t: 'reply', id, ok, payload });
      const refuse = (err: unknown): string => {
        if (err instanceof SandboxBridgeError) {
          if (err.violation) report({ reason: err.code as SandboxViolation['reason'], detail: err.detail });
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
            settle('crashed');
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
            report({ reason: 'output_limit', detail: 'résultat' });
            settle('violation');
            return;
          }
          try {
            value = JSON.parse(raw);
          } catch {
            report({ reason: 'protocol', detail: 'résultat' });
            settle('violation');
            return;
          }
          settle(violations.length > 0 ? 'violation' : 'ok');
        } else settle(violations.length > 0 ? 'violation' : 'script_error');
      };

      child.on('message', (raw: unknown) => {
        const message = parseChildMessage(raw);
        if (message === undefined) {
          report({ reason: 'protocol' });
          settle('violation', { byLimit: true });
          return;
        }
        switch (message.t) {
          case 'ready': {
            const leaked = unexpectedEnvKeys(message.envKeys);
            if (child.pid !== undefined) this.#options.onChildReady?.({ pid: child.pid, envKeys: message.envKeys });
            if (leaked.length > 0) {
              report({ reason: 'env_not_empty', detail: `${leaked.length} variable(s)` });
              settle('violation', { byLimit: true });
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
            send({ t: 'run', engine: this.id, code, inputJson, limits: { timeoutMs, memoryMb } });
            return;
          }
          case 'rss':
            observeRss(message.mb);
            return;
          case 'call': {
            const call = bridges.fetch(message.payload).then(
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
            report({ reason: message.reason, detail: message.detail });
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
      child.once('exit', finish);
      child.once('error', (err) => {
        error = err.message;
        if (child.pid === undefined) finish();
      });
    });
  }
}
