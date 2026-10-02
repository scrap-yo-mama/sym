// SPDX-License-Identifier: AGPL-3.0-only
// Sessions `dedicated` (cdc/sym-browser 04b § 2, 04c § 3, 04f § 1, 03 § 7, tâche 1.4) : un Chromium à la session, lancé à
// la demande par `chromium.launchServer`, qui sert à la fois Playwright natif (`connect`, WebSocket local au chemin
// imprévisible) et CDP (`--remote-debugging-port=0`, écoute sur 127.0.0.1 seulement, point lu dans `DevToolsActivePort`).
// - Profil temporaire `SYMB_DATA_DIR/sessions/{id}/profile` (0700), artefacts et téléchargements de Playwright dans le même
//   répertoire de session : rien dans le répertoire temporaire du système. Le profil est passé par l'option interne
//   `_userDataDir` de `launchServer` (Playwright 1.63.0 épinglé, contexte persistant) : `--user-data-dir` en argument est
//   refusé par Playwright, et le test sur Chromium réel vérifie la ligne de commande effective.
// - Mêmes options figées que le pool (launch.ts : bac à sable actif, jamais root, proxy de lancement fermé, environnement
//   réduit) + les drapeaux de la liste fermée `launchArgs`.
// - Destruction (04c § 3.2, étapes 3, 4 et 6 ; BINV3), déclenchée par la libération, le plantage, le chien de garde ou
//   l'arrêt du nœud (le pool appelle `close` ou `kill`) : SIGKILL du groupe de processus et attente de sa sortie, PUIS
//   détachement de la connexion interne, PUIS suppression récursive de `sessions/{id}` (le port CDP meurt avec le processus).
import { mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { assertNotRoot, chromiumLaunchOptions, type PlaywrightLauncherOptions } from '../pool/launch.js';
import type { BrowserLauncher, LaunchedBrowser } from '../pool/pool.js';
import { dedicatedLaunchFlags } from './launch-args.js';

/** Destruction visée (04c § 3.2 : ≤ 5 s, à valider) ; attente de sortie du processus après SIGKILL. */
export const DEDICATED_TEARDOWN_TIMEOUT_MS = 5_000;

export class SessionDirError extends Error {
  override name = 'SessionDirError';
}

export type SessionDir = { root: string; profile: string; artifacts: string; downloads: string };

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** `SYMB_DATA_DIR/sessions/{id}` : identifiant sûr (ni `.`, ni `/`), racine absolue. */
export function sessionDir(dataDir: string, sessionId: string): SessionDir {
  if (!isAbsolute(dataDir)) throw new SessionDirError('SYMB_DATA_DIR : chemin absolu attendu');
  if (!SESSION_ID.test(sessionId)) throw new SessionDirError('identifiant de session hors format pour un répertoire');
  const root = join(dataDir, 'sessions', sessionId);
  return { root, profile: join(root, 'profile'), artifacts: join(root, 'artifacts'), downloads: join(root, 'downloads') };
}

/** Contenu de `DevToolsActivePort` (port, puis chemin du navigateur) → point CDP local ; `undefined` s'il est incomplet. */
export function parseDevToolsActivePort(content: string): { port: number; path: string; endpoint: string } | undefined {
  const [portLine = '', path = ''] = content.split('\n');
  if (!/^\d{1,5}$/.test(portLine) || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path)) return undefined;
  const port = Number(portLine);
  if (port < 1 || port > 65_535) return undefined;
  return { port, path, endpoint: `ws://127.0.0.1:${port}${path}` };
}

export type DedicatedTeardownSteps = {
  dir: SessionDir;
  /** SIGKILL du groupe de processus et attente de sa disparition ; vrai si le groupe est vide. */
  killGroup: () => Promise<boolean>;
  /** Arrêt de secours (Playwright) si le groupe n'a pas pu être vidé. */
  killFallback: () => Promise<void>;
  groupAlive: () => boolean;
  /** Détachement de la connexion interne du nœud (les clients tombent avec le processus). */
  disconnect: () => Promise<void>;
  /** Faux : `sessions/{id}` reste pour l'hôte des sessions (tâche 1.7, étapes 5 et 6 de 04c § 3.2). Défaut : vrai. */
  removeDir?: boolean;
};

/** Destruction ordonnée, idempotente une fois réussie ; un échec (processus survivant) peut être retenté. */
export function createDedicatedTeardown(steps: DedicatedTeardownSteps): () => Promise<void> {
  let done = false;
  let running: Promise<void> | null = null;
  const run = async (): Promise<void> => {
    if (!(await steps.killGroup().catch(() => false))) await steps.killFallback().catch(() => undefined);
    await steps.disconnect().catch(() => undefined);
    if (steps.removeDir ?? true) await rm(steps.dir.root, { recursive: true, force: true });
    if (steps.groupAlive()) throw new Error('destruction : processus Chromium encore vivants après SIGKILL');
  };
  return () => {
    if (done) return Promise.resolve();
    running ??= run()
      .then(() => {
        done = true;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
}

export type DedicatedLauncherOptions = PlaywrightLauncherOptions & {
  /** `SYMB_DATA_DIR` (chemin absolu). */
  dataDir: string;
  pollMs?: number;
  /**
   * Vrai (défaut) : `sessions/{id}` est supprimé avec le processus (pool seul, tâche 1.4). Faux : le nœud complet, où l'hôte
   * des sessions (tâche 1.7) copie d'abord les objets demandés puis supprime le répertoire (04c § 3.2, étapes 5 et 6).
   */
  removeSessionDir?: boolean;
};

type LaunchServerOptions = NonNullable<Parameters<typeof chromium.launchServer>[0]>;

async function waitDevToolsActivePort(profile: string, timeoutMs: number, pollMs: number, exited: () => boolean): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const parsed = parseDevToolsActivePort(content);
    if (parsed) return parsed.endpoint;
    if (exited()) throw new Error('Chromium s’est arrêté avant d’ouvrir son port CDP');
    if (Date.now() >= deadline) throw new Error(`port CDP non publié en ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Lanceur des sessions dedicated, à passer au pool (`launchDedicated`). */
export function dedicatedLauncher(options: DedicatedLauncherOptions): BrowserLauncher {
  return async (purpose) => {
    if (purpose.role !== 'dedicated' || purpose.sessionId === undefined) throw new RangeError('lanceur dedicated : session dedicated et identifiant requis');
    assertNotRoot();
    const dir = sessionDir(options.dataDir, purpose.sessionId);
    const flags = dedicatedLaunchFlags(purpose.launchArgs ?? []);
    const launch = chromiumLaunchOptions(options.launchProxyUrl, options.env ?? process.env);

    await mkdir(join(options.dataDir, 'sessions'), { recursive: true, mode: 0o700 });
    try {
      await mkdir(dir.root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SessionDirError('répertoire de session déjà présent : identifiant réutilisé ou destruction inachevée');
      throw error;
    }
    for (const sub of [dir.profile, dir.artifacts, dir.downloads]) await mkdir(sub, { mode: 0o700 });

    const serverOptions: LaunchServerOptions & { _userDataDir: string; artifactsDir: string } = {
      ...launch,
      args: [...launch.args, '--remote-debugging-port=0', ...flags],
      proxy: { ...launch.proxy },
      env: { ...launch.env },
      downloadsPath: dir.downloads,
      artifactsDir: dir.artifacts,
      _userDataDir: dir.profile,
    };
    let server: Awaited<ReturnType<typeof chromium.launchServer>>;
    try {
      server = await chromium.launchServer(serverOptions);
    } catch (error) {
      await rm(dir.root, { recursive: true, force: true });
      throw error;
    }
    const pid = server.process().pid;
    if (pid !== undefined) options.groups.add(pid);
    let exited = false;
    server.once('close', () => (exited = true));

    let browser: Browser | undefined;
    const teardown = createDedicatedTeardown({
      dir,
      killGroup: async () => (pid === undefined ? false : options.groups.kill(pid)),
      killFallback: async () => {
        await server.kill();
      },
      groupAlive: () => pid !== undefined && options.groups.members(pid).length > 0,
      disconnect: async () => {
        await browser?.close();
      },
      removeDir: options.removeSessionDir ?? true,
    });

    let cdpEndpoint: string;
    try {
      cdpEndpoint = await waitDevToolsActivePort(dir.profile, launch.timeout, options.pollMs ?? 20, () => exited);
      browser = await chromium.connect(server.wsEndpoint(), { timeout: launch.timeout });
    } catch (error) {
      await teardown().catch(() => undefined);
      throw error;
    }
    const internal = browser;
    const launched: LaunchedBrowser = {
      id: `dedicated-${pid ?? 'x'}-${purpose.sessionId}`,
      pid,
      wsEndpoint: server.wsEndpoint(),
      cdpEndpoint,
      browser: internal,
      isConnected: () => internal.isConnected(),
      onDisconnected: (listener) => void internal.once('disconnected', () => listener()),
      close: teardown,
      kill: teardown,
    };
    return launched;
  };
}
