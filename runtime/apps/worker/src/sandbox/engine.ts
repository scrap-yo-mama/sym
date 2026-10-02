// SPDX-License-Identifier: AGPL-3.0-only
// `SandboxEngine` par processus enfant (INV7, 08 §3) : un enfant dédié par run, environnement VIDE (`env: {}` puis
// vérification), `--no-node-snapshot`, mode permission de Node en ceinture, isolat dans l'enfant, ponts relayés par IPC
// et appliqués ici. Utilisateur dédié (uid distinct du worker, obligatoire en production) via un lanceur setpriv sans
// nouveaux privilèges, exécuté directement par le worker (sous no-new-privileges, ses capacités de fichier ne valent que
// si le worker les détient déjà), sous un Node que l'uid dédié peut exécuter (SANDBOX_NODE). Plafonds : temps mur, temps
// CPU (RLIMIT_CPU), RSS du processus, octets reçus ; SIGKILL mesuré sur le processus. Toute violation tue l'enfant aussitôt.
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { SIGNAL_OUTPUT_LIMIT, parseChildMessage, type ChildMessage, type ParentMessage } from './protocol.js';

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
   * `cap_setuid,cap_setgid` et exécutable par le groupe du worker (deploy/Dockerfile). Appelé avec `--no-new-privs`,
   * directement par le worker : sous no-new-privileges (Render), un exec ne garde de ses capacités de fichier que celles
   * que l'appelant détient déjà, et un shell intermédiaire n'en détiendrait aucune.
   */
  launcher?: string;
  /**
   * Node exécuté par l'enfant (défaut `process.execPath`). Dans l'image, le worker tourne sous une copie de Node dotée de
   * capacités de fichier et réservée au groupe pwuser (`/usr/local/libexec/node-worker`), que l'uid dédié ne peut pas
   * exécuter : l'enfant prend le Node ordinaire (`SANDBOX_NODE=/usr/bin/node`), sans capacité.
   */
  node?: string;
  /**
   * Filtre seccomp de l'enfant (`deploy/sandbox-seccomp.c`, `SANDBOX_SECCOMP`), premier exec du worker, AVANT le lanceur et
   * donc avant le changement d'uid (revue 4.1b (4)) : `unshare`, `setns` et `clone` avec un drapeau CLONE_NEW* refusés,
   * `clone3` en ENOSYS, `ptrace` et `process_vm_readv/writev` refusés. Le profil seccomp du compose permet les espaces de
   * noms utilisateur à tout le conteneur (bac à sable de Chromium) ; l'enfant, lui, n'en crée aucun (aucune capacité dans un
   * espace imbriqué, donc pas de surface netfilter, mount… après une double évasion). Dans l'image, il porte
   * cap_setuid,cap_setgid en permis (=p) pour que le lanceur qu'il exécute garde les siennes sous no-new-privileges.
   */
  seccomp?: string;
  /** Production : refuse de démarrer si l'enfant tournerait sous l'uid du worker (défaut : NODE_ENV=production). */
  production?: boolean;
  /** Mode permission de Node sur l'enfant (défaut vrai). */
  permission?: boolean;
  /** Diagnostic (tests) : pid et variables vues par l’enfant. */
  onChildReady?: (info: { pid: number; envKeys: readonly string[] }) => void;
  /** Vidange forcée (balayage de l'uid dédié) après ce nombre de runs ou ce délai sans balayage (défauts : 25 runs, 5 min). */
  sweepEveryRuns?: number;
  sweepEveryMs?: number;
  /** Alerte : balayage de l'uid dédié en échec persistant, tous les runs suivants sont refusés. */
  onSweepFailure?: (message: string) => void;
  /** Diagnostic (tests) : plan de chaque balayage, et motif du refus s'il n'est pas exécuté (`sweepRefusal`). */
  onSweep?: (info: { command: string; args: readonly string[]; refused?: string }) => void;
};

/** Vidange forcée par défaut : au plus 25 runs ou 5 minutes entre deux balayages de l'uid dédié. */
const SWEEP_EVERY_RUNS = 25;
const SWEEP_EVERY_MS = 5 * 60_000;

/** Options d'utilisateur dédié lues dans l'environnement du worker (SANDBOX_UID, SANDBOX_GID, SANDBOX_LAUNCHER, SANDBOX_NODE, SANDBOX_SECCOMP). */
export function sandboxOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): Pick<ProcessSandboxOptions, 'uid' | 'gid' | 'launcher' | 'node' | 'seccomp'> {
  const id = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    if (!/^\d{1,10}$/.test(raw)) throw new Error(`bac à sable : ${name} doit être un identifiant numérique`);
    return Number(raw);
  };
  const uid = id('SANDBOX_UID');
  const gid = id('SANDBOX_GID');
  if ((uid === undefined) !== (gid === undefined)) throw new Error('bac à sable : SANDBOX_UID et SANDBOX_GID vont ensemble');
  const path = (name: string): string | undefined => (env[name] === undefined || env[name] === '' ? undefined : env[name]);
  const launcher = path('SANDBOX_LAUNCHER');
  const node = path('SANDBOX_NODE');
  const seccomp = path('SANDBOX_SECCOMP');
  return {
    ...(uid !== undefined ? { uid } : {}),
    ...(gid !== undefined ? { gid } : {}),
    ...(launcher !== undefined ? { launcher } : {}),
    ...(node !== undefined ? { node } : {}),
    ...(seccomp !== undefined ? { seccomp } : {}),
  };
}

/**
 * Script du shell de lancement. `env -i` retire ce que le shell exporte de lui-même (PWD, SHLVL…) mais garde le canal
 * IPC que Node passe à l'enfant (NODE_CHANNEL_*), que l'enfant retire de son environnement au démarrage.
 *
 * Linux, aucun vidage mémoire de l'enfant (INV7 : son tas tient le script, les données extraites, les réponses des ponts),
 * y compris par SIGXCPU au plafond CPU : RLIMIT_CORE d'UN octet, souple et dure (`prlimit` : `ulimit -c` compte en blocs
 * de 512 octets). Vers un fichier, c'est sous la taille minimale d'un vidage ; vers un collecteur en tube (systemd-coredump,
 * apport), auquel RLIMIT_CORE ne s'applique pas, le noyau traite exactement 1 comme un refus (« RLIMIT_CORE is set to 1,
 * aborting core »). En plus, coredump_filter nul : aucune page mémoire si un collecteur passait outre. Les deux sont hérités
 * par `exec`. PR_SET_DUMPABLE serait plus direct mais n'est pas accessible : `exec` le remet, Node n'expose pas prctl.
 * Échec de l'un ou l'autre : l'enfant ne démarre pas. La plateforme décide (celle du worker, `process.platform`), jamais la
 * présence d'un fichier : sous Linux, un /proc absent ou masqué fait échouer le lancement (échec fermé) au lieu de lancer
 * l'enfant sans protection. `prlimit` par son chemin absolu (util-linux) : le shell n'a pas de PATH fiable.
 */
function launchScript(platform: NodeJS.Platform): string {
  return (
    'ulimit -S -t "$0" && ulimit -H -t $(($0 + 1)) && ' +
    (platform === 'linux' ? 'echo 0 > /proc/self/coredump_filter && /usr/bin/prlimit --pid $$ --core=1:1 && ' : '') +
    'exec /usr/bin/env -i ' +
    '${NODE_CHANNEL_FD+"NODE_CHANNEL_FD=$NODE_CHANNEL_FD"} ' +
    '${NODE_CHANNEL_SERIALIZATION_MODE+"NODE_CHANNEL_SERIALIZATION_MODE=$NODE_CHANNEL_SERIALIZATION_MODE"} "$@"'
  );
}

/** Commande de lancement de l'enfant (pure, testée) : plafond CPU, environnement vidé, changement d'utilisateur. */
export type SpawnPlan = { command: string; args: string[]; uid?: number; gid?: number };

/**
 * Le lanceur change d'utilisateur sans nouveaux privilèges (premier exec, fait par le worker lui-même : sous
 * no-new-privileges, il n'obtient cap_setuid,cap_setgid que si l'appelant les détient), puis `/bin/sh`, sous l'uid dédié,
 * pose RLIMIT_CPU (souple N puis dur N + 1, dans cet ordre : SIGXCPU d’abord, SIGKILL ensuite) et interdit tout vidage
 * mémoire (Linux, voir launchScript), puis `env -i` rend un environnement vide (le shell en ajoute), puis Node. Avec
 * `seccomp` et un lanceur, le filtre de l'enfant s'exécute en PREMIER, sous l'uid du worker, puis exécute le lanceur
 * (`asSandboxUid`) : aucun processus de l'uid dédié n'existe sans filtre. Chaque étape fait `exec` : le pid suivi par le
 * parent reste celui de l'enfant. Sans lanceur (worker root, `spawn` change d'uid), le filtre suit le changement d'uid :
 * mode de développement, l'image passe toujours par le lanceur. */
export function spawnPlan(p: {
  node: string;
  nodeArgs: readonly string[];
  /** Script de l'enfant ; absent pour `node -e` (sonde). */
  script?: string;
  cpuSeconds: number;
  launcher?: string;
  uid?: number;
  gid?: number;
  /** Plateforme du worker (défaut `process.platform`) : sous Linux, aucun vidage mémoire de l'enfant (voir launchScript). */
  platform?: NodeJS.Platform;
  seccomp?: string;
}): SpawnPlan {
  const node = [p.node, ...p.nodeArgs, ...(p.script === undefined ? [] : [p.script])];
  const cpu = String(Math.max(1, Math.ceil(p.cpuSeconds)));
  const shell = ['/bin/sh', '-c', launchScript(p.platform ?? process.platform), cpu, ...node];
  if (p.launcher !== undefined && p.uid !== undefined && p.gid !== undefined) {
    return asSandboxUid({ launcher: p.launcher, uid: p.uid, gid: p.gid, seccomp: p.seccomp }, shell);
  }
  const [command = '/bin/sh', ...args] = p.seccomp === undefined ? shell : [p.seccomp, ...shell];
  const plan: SpawnPlan = { command, args };
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
  o: Pick<ProcessSandboxOptions, 'launcher' | 'uid' | 'gid' | 'seccomp'>,
  pid: number,
): { command: string; args: string[] } | undefined {
  if (o.launcher === undefined || o.uid === undefined || o.gid === undefined) return undefined;
  // Un pid d'enfant seulement : jamais 0 (groupe), négatif (kill -1, groupe) ni 1 (init) (F-20261002-06).
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  return asSandboxUid({ ...o, launcher: o.launcher, uid: o.uid, gid: o.gid }, ['/bin/kill', '-KILL', String(pid)]);
}

/**
 * Commande lancée sous l'uid dédié : filtre seccomp de l'enfant d'abord (sous l'uid du worker), puis le lanceur (changement
 * d'uid sans nouveaux privilèges), puis la commande. Le profil du compose permet clone, setns et unshare au conteneur : un
 * processus de l'uid dédié sans filtre (enfant, /bin/kill de l'arrêt forcé ou du balayage) pourrait être stoppé puis détourné
 * par un enfant évadé (ptrace, ou /proc/<pid>/mem si Yama vaut 0) pour créer un espace de noms utilisateur. Revue 4.1b (4) :
 * posé APRÈS le changement d'uid, le filtre laissait cette fenêtre à chaque lancement (l'exec de sandbox-seccomp, sans
 * capacité, rend le processus attachable avant que son `main` ne pose le filtre). Posé avant, sous l'uid du worker, il
 * précède tout processus de l'uid dédié : le lanceur, filtré, n'est pas attachable (capacités, non dumpable après son
 * changement d'uid) jusqu'à l'exec de la commande, filtrée elle aussi.
 */
function asSandboxUid(o: { launcher: string; uid: number; gid: number; seccomp?: string | undefined }, command: readonly string[]): { command: string; args: string[] } {
  const launch = [o.launcher, `--reuid=${o.uid}`, `--regid=${o.gid}`, '--clear-groups', '--no-new-privs', '--', ...command];
  const [first, ...args] = o.seccomp === undefined ? launch : [o.seccomp, ...launch];
  return { command: first ?? o.launcher, args };
}

/**
 * Balayage de fin de run : SIGKILL à TOUS les processus de l'uid dédié (`kill -1` lancé sous cet uid par le lanceur ; il
 * n'atteint ni le worker, ni Chromium, ni tini). Tous les enfants partagent l'uid dédié et l'arrêt forcé ne vise que le pid
 * suivi : un enfant évadé de l'isolat pourrait laisser un processus détaché qui observerait les runs suivants (/proc,
 * ptrace selon Yama). Joué quand aucun autre run n'est actif ; `undefined` sans lanceur (même uid, ou worker root).
 */
export function sweepPlan(o: Pick<ProcessSandboxOptions, 'launcher' | 'uid' | 'gid' | 'seccomp'>): { command: string; args: string[] } | undefined {
  if (o.launcher === undefined || o.uid === undefined || o.gid === undefined) return undefined;
  return asSandboxUid({ ...o, launcher: o.launcher, uid: o.uid, gid: o.gid }, ['/bin/kill', '-KILL', '-1']);
}

/**
 * Vérification préalable à chaque balayage (revue 4.1b (3)) : `/usr/bin/id -u` lancé par la même chaîne que le balayage
 * (filtre, lanceur). `sweepRefusal` ne compare que l'uid configuré à l'uid courant : un lanceur qui ne change pas réellement
 * d'uid (mal installé, faux lanceur de test) passerait cette garde et `kill -1` partirait sous l'uid du worker.
 */
export function sweepIdentityPlan(o: Pick<ProcessSandboxOptions, 'launcher' | 'uid' | 'gid' | 'seccomp'>): { command: string; args: string[] } | undefined {
  if (o.launcher === undefined || o.uid === undefined || o.gid === undefined) return undefined;
  return asSandboxUid({ ...o, launcher: o.launcher, uid: o.uid, gid: o.gid }, ['/usr/bin/id', '-u']);
}

/** Uid rapporté par `sweepIdentityPlan` : motif du refus s'il n'est pas exactement l'uid dédié, sinon `undefined`. */
export function sweepIdentityRefusal(p: { uid: number; reported: string | undefined }): string | undefined {
  const seen = p.reported?.trim() ?? '';
  if (seen === String(p.uid)) return undefined;
  return `balayage refusé : le lanceur ne fait pas tourner sa commande sous l'uid dédié (${p.uid}) ; uid vu : ${seen === '' ? 'aucun' : seen.slice(0, 40)}`;
}

/**
 * Garde du balayage (F-20261002-06, défense en profondeur) : `kill -1` atteint tous les processus de l'uid qui l'envoie.
 * Lancé sous l'uid du worker, il tuerait le worker et tout ce que cet uid fait tourner (sur un poste de développement : toute
 * la session de l'utilisateur) ; sous root, tout le conteneur. Le balayage n'est donc exécuté que sous Linux (la plateforme
 * du lanceur de production), vers un uid connu, ni root ni celui du processus courant. Rend le motif du refus, sinon
 * `undefined`. Décision pure : la plateforme et l'uid courant sont lus par l'appelant (`process.platform`, `process.getuid`).
 */
export function sweepRefusal(p: { uid: number; ownUid: number | undefined; platform: NodeJS.Platform }): string | undefined {
  if (p.platform !== 'linux') return `balayage refusé : plateforme ${p.platform}, Linux seulement`;
  if (p.uid === 0) return 'balayage refusé : uid cible 0 (root)';
  if (p.ownUid === undefined || p.uid === p.ownUid) return `balayage refusé : l'uid cible (${p.uid}) est l'uid du worker ou l'uid du worker est inconnu`;
  return undefined;
}

/**
 * Processus encore vivants de l'uid dédié (uid réel, effectif ou sauvé), zombies exclus, lus dans `/proc` : après un
 * balayage, il ne doit en rester aucun (un processus évadé peut stopper le balayeur entre son changement d'uid et son
 * `kill -1`).
 */
export async function sandboxSurvivors(uid: number, procRoot = '/proc'): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const entry of entries.filter((e) => /^\d+$/.test(e))) {
    let status: string;
    try {
      status = await readFile(join(procRoot, entry, 'status'), 'utf8');
    } catch {
      continue; // processus disparu entre-temps
    }
    const state = /^State:\s*(\S)/m.exec(status)?.[1];
    if (state === 'Z' || state === 'X') continue;
    const uids = (/^Uid:\s*(.*)$/m.exec(status)?.[1] ?? '').trim().split(/\s+/).slice(0, 3).map(Number);
    if (uids.includes(uid)) found.push(Number(entry));
  }
  return found;
}

/**
 * Ordonnance les balayages de l'uid dédié (D-32, revue 4.1b). Un balayage a lieu quand aucun run n'est actif ; sous des
 * runs qui se chevauchent sans fin (WORKER_CONCURRENCY > 1), il n'aurait jamais lieu : après `everyRuns` runs ou
 * `everyMs` sans balayage, les nouveaux lancements sont suspendus jusqu'à la vidange (plus aucun run actif), puis le
 * balayage joue. Chaque balayage est vérifié (`sweepOnce` rend `false` s'il reste un processus de l'uid dédié) et repris
 * jusqu'à `maxAttempts` fois ; un échec persistant refuse tout run suivant (alerte par `onFailure`).
 */
export class SweepScheduler {
  readonly #sweepOnce: () => Promise<boolean>;
  readonly #everyRuns: number;
  readonly #everyMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #onFailure: ((message: string) => void) | undefined;
  #active = 0;
  #runsSinceSweep = 0;
  #lastSweepAt: number;
  #sweeping: Promise<void> | undefined;
  #drainWaiters: (() => void)[] = [];
  #failure: Error | undefined;

  constructor(o: { sweepOnce: () => Promise<boolean>; everyRuns: number; everyMs: number; maxAttempts?: number; now?: () => number; onFailure?: (message: string) => void }) {
    this.#sweepOnce = o.sweepOnce;
    this.#everyRuns = o.everyRuns;
    this.#everyMs = o.everyMs;
    this.#maxAttempts = o.maxAttempts ?? 3;
    this.#now = o.now ?? Date.now;
    this.#onFailure = o.onFailure;
    this.#lastSweepAt = this.#now();
  }

  #drainDue(): boolean {
    return this.#runsSinceSweep >= this.#everyRuns || this.#now() - this.#lastSweepAt >= this.#everyMs;
  }

  /** Avant le lancement d'un enfant : attend un balayage en cours, ou la vidange quand elle est due. */
  async enter(): Promise<void> {
    for (;;) {
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#sweeping !== undefined) await this.#sweeping;
      else if (this.#active > 0 && this.#drainDue()) await new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
      else break;
    }
    this.#active++;
    this.#runsSinceSweep++;
  }

  /** Fin d'un run (ou d'une sonde) : le dernier actif déclenche le balayage. */
  leave(): void {
    if (--this.#active > 0) return;
    const sweeping: Promise<void> = this.#sweepVerified().finally(() => {
      if (this.#sweeping === sweeping) this.#sweeping = undefined;
      for (const wake of this.#drainWaiters.splice(0)) wake();
    });
    this.#sweeping = sweeping;
  }

  async #sweepVerified(): Promise<void> {
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      let clean: boolean;
      try {
        clean = await this.#sweepOnce();
      } catch {
        clean = false;
      }
      if (clean) {
        this.#runsSinceSweep = 0;
        this.#lastSweepAt = this.#now();
        return;
      }
    }
    const message = `bac à sable : balayage de l'uid dédié en échec (processus survivants, ou balayage refusé, après ${this.#maxAttempts} essais) ; runs refusés`;
    this.#failure = new Error(message);
    this.#onFailure?.(message);
  }

  /** Attend la fin du balayage en cours (arrêt du worker, tests). */
  async idle(): Promise<void> {
    while (this.#sweeping !== undefined) await this.#sweeping;
  }
}

/** Résultat de `probeIsolation` : ce que voit un processus lancé comme l'enfant, hors mode permission de Node. */
export type IsolationProbe = {
  uid: number | undefined;
  /** `/proc/<ppid>/environ` : `denied` (attendu), `readable` (trou), `absent` (pas de /proc). */
  parentEnviron: 'denied' | 'readable' | 'absent';
  /**
   * Fichier témoin 0600 du worker, dans un dossier 0700 : `denied` (attendu), `readable` (l'enfant a l'uid du worker).
   * Discriminant même sous no-new-privileges, où `/proc/<worker>/environ` est refusé à un processus du même uid (le worker
   * détient des capacités permises).
   */
  witness: 'denied' | 'readable' | 'absent';
  /** Linux : bit no_new_privs posé. */
  noNewPrivs: boolean | undefined;
  /**
   * Création d'un espace de noms utilisateur par l'enfant (`unshare --user`) : `denied` (attendu en production, filtre
   * `SANDBOX_SECCOMP` ou profil seccomp de l'hôte), `allowed` (le worker refuse de démarrer en production), `absent`
   * (pas de commande `unshare`, hors Linux).
   */
  namespaces?: 'denied' | 'allowed' | 'absent';
};

const PROBE_SCRIPT = `
const fs = require('node:fs');
let parentEnviron = 'absent';
try { fs.readFileSync('/proc/' + process.ppid + '/environ'); parentEnviron = 'readable'; }
catch (e) { parentEnviron = e && e.code === 'ENOENT' ? 'absent' : 'denied'; }
let witness = 'absent';
try { fs.readFileSync(process.argv[1]); witness = 'readable'; }
catch (e) { witness = e && e.code === 'ENOENT' ? 'absent' : 'denied'; }
let noNewPrivs;
try { noNewPrivs = /^NoNewPrivs:\\s+1$/m.test(fs.readFileSync('/proc/self/status', 'utf8')); } catch (e) {}
let namespaces = 'absent';
if (fs.existsSync('/usr/bin/unshare')) {
  const r = require('node:child_process').spawnSync('/usr/bin/unshare', ['--user', '/bin/true'], { stdio: 'ignore', timeout: 5000 });
  namespaces = r.status === 0 ? 'allowed' : 'denied';
}
process.stdout.write(JSON.stringify({ uid: process.getuid ? process.getuid() : undefined, parentEnviron, witness, noNewPrivs, namespaces }));`;

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
  /** Balayages de l'uid dédié (D-32) : absent sans lanceur (même uid, ou worker root), rien à balayer. */
  readonly #sweeps: SweepScheduler | undefined;

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
    // Le lanceur détient CAP_SETUID effectif (revue 4.1b) : uid 0, l'enfant serait root, propriétaire de /usr/bin/node,
    // entrypoint.sh et /app ; groupe du worker, il exécuterait node-worker et sandbox-launch et lirait les fichiers du groupe.
    if (options.uid === 0) throw new Error('bac à sable : SANDBOX_UID ne peut pas valoir 0 (root)');
    if (options.gid === 0) throw new Error('bac à sable : SANDBOX_GID ne peut pas valoir 0 (root)');
    if (options.gid !== undefined && (options.gid === process.getgid?.() || (process.getgroups?.() ?? []).includes(options.gid))) {
      throw new Error(`bac à sable : SANDBOX_GID (${options.gid}) est un groupe du worker ; un groupe dédié est requis`);
    }
    this.#options = options;
    const self = import.meta.url;
    this.#childFile = fileURLToPath(new URL(self.endsWith('.ts') ? './child.ts' : './child.js', self));
    this.#readPaths = childReadPaths(this.#childFile, this.id);
    const plan = sweepPlan(options);
    const uid = options.uid;
    this.#sweeps =
      plan === undefined || uid === undefined
        ? undefined
        : new SweepScheduler({
            sweepOnce: () => this.#sweepOnce(plan, uid),
            everyRuns: options.sweepEveryRuns ?? SWEEP_EVERY_RUNS,
            everyMs: options.sweepEveryMs ?? SWEEP_EVERY_MS,
            ...(options.onSweepFailure === undefined ? {} : { onFailure: options.onSweepFailure }),
          });
  }

  /**
   * Compte un run (ou une sonde) : il attend la fin d'un balayage en cours (ou la vidange quand elle est due) avant de
   * lancer son enfant ; le dernier à finir balaie l'uid dédié (`sweepPlan`), balayage vérifié (`SweepScheduler`).
   */
  async #track<T>(start: () => Promise<T>): Promise<T> {
    if (this.#sweeps === undefined) return start();
    await this.#sweeps.enter();
    try {
      return await start();
    } finally {
      this.#sweeps.leave();
    }
  }

  /**
   * Un balayage : `kill -1` sous l'uid dédié, puis aucun processus de cet uid ne doit subsister (Linux). Refusé par
   * `sweepRefusal`, ou par `sweepIdentityRefusal` (le lanceur ne fait pas tourner `id -u` sous l'uid dédié) : rien n'est
   * lancé ; hors Linux, rien à balayer (pas de lanceur de production) ; sous Linux, échec (runs refusés, alerte), l'uid
   * dédié n'étant pas distinct du worker.
   */
  async #sweepOnce(plan: { command: string; args: string[] }, uid: number): Promise<boolean> {
    const refused = sweepRefusal({ uid, ownUid: process.getuid?.(), platform: process.platform }) ?? (await this.#sweepIdentity(uid));
    this.#options.onSweep?.({ command: plan.command, args: plan.args, ...(refused === undefined ? {} : { refused }) });
    if (refused !== undefined) return process.platform !== 'linux';
    await new Promise<void>((resolve) => {
      execFile(plan.command, plan.args, { env: {}, timeout: 5000 }, () => resolve());
    });
    if (process.platform !== 'linux') return true;
    // SIGKILL n'est pas instantané (sortie d'un appel système en cours) : quelques relectures avant de conclure.
    for (let i = 0; i < 10; i++) {
      if ((await sandboxSurvivors(uid)).length === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  /** Le lanceur fait-il tourner sa commande sous l'uid dédié ? Motif du refus sinon (`sweepIdentityRefusal`). */
  async #sweepIdentity(uid: number): Promise<string | undefined> {
    const plan = sweepIdentityPlan(this.#options);
    if (plan === undefined) return 'balayage refusé : aucun lanceur';
    const reported = await new Promise<string | undefined>((resolve) => {
      execFile(plan.command, plan.args, { env: {}, timeout: 5000, encoding: 'utf8' }, (error, stdout) => resolve(error === null ? stdout : undefined));
    });
    return sweepIdentityRefusal({ uid, reported });
  }

  /** Attend la fin du balayage en cours (arrêt du worker, tests). */
  async idle(): Promise<void> {
    await this.#sweeps?.idle();
  }

  #plan(nodeArgs: readonly string[], script: string | undefined, cpuSeconds: number): SpawnPlan {
    const { launcher, uid, gid, seccomp } = this.#options;
    return spawnPlan({ node: this.#options.node ?? process.execPath, nodeArgs, script, cpuSeconds, launcher, uid, gid, seccomp });
  }

  /**
   * Éprouve la frontière de l'OS : lance, par le même chemin que l'enfant (lanceur, uid, environnement vide, plafond
   * CPU) mais sans --permission, un Node qui tente de lire l'environnement du parent. Au démarrage du worker (1.6) :
   * refuser de servir si `parentEnviron` vaut `readable`.
   */
  probeIsolation(): Promise<IsolationProbe> {
    return this.#track(() => this.#probe());
  }

  async #probe(): Promise<IsolationProbe> {
    // Témoin : fichier 0600 du worker dans un dossier 0700 ; seul un processus du même uid (ou root) peut le lire.
    const dir = await mkdtemp(join(tmpdir(), 'sandbox-probe-'));
    try {
      const witness = join(dir, 'witness');
      await writeFile(witness, 'zz', { mode: 0o600 });
      const plan = this.#plan(['-e', PROBE_SCRIPT, witness], undefined, 5);
      return await new Promise<IsolationProbe>((resolve, reject) => {
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  run(code: string, bridges: SandboxBridges, limits: SandboxLimits, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    // Import dynamique en clair : refusé avant tout lancement (isolated-vm n'a pas de crochet d'import).
    if (FORBIDDEN_IMPORT.test(code)) {
      const v: SandboxViolation = { reason: 'forbidden_import', detail: 'import()' };
      bridges.violation(v);
      return Promise.resolve({ engine: this.id, outcome: 'violation', violations: [v], durationMs: 0, killed: false });
    }
    let started = false;
    return this.#track(() => {
      started = true;
      return this.#run(code, bridges, limits, options);
    }).catch((err: unknown) => {
      if (started) throw err;
      // Balayage de l'uid dédié en échec persistant (SweepScheduler) : aucun enfant n'est plus lancé.
      return { engine: this.id, outcome: 'crashed' as const, error: err instanceof Error ? err.message : String(err), violations: [], durationMs: 0, killed: false };
    });
  }

  #run(code: string, bridges: SandboxBridges, limits: SandboxLimits, options: SandboxRunOptions): Promise<SandboxResult> {
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
        if (outcome === undefined && child.signalCode === SIGNAL_OUTPUT_LIMIT) {
          // Arrêt voulu de l'enfant (file de journal saturée, boucle affamée) : même verdict qu'un dépassement vu de l'hôte.
          outcome = 'violation';
          killed = true;
          killRequestedAt = exitedAt;
          report({ reason: 'output_limit', detail: 'file IPC' });
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
