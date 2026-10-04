// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur de navigateur `local` (tâche 4.1 ; cdc/sym-browser 04e §2.2) : le Chromium du worker derrière
// `BrowserProvider` (`@sym/contracts/browser`). Code DÉPLACÉ tel quel, sans changement de comportement :
// - `launchShared` : `playwrightLauncher` de pool.ts (`chromium.launchServer` derrière le proxy de lancement fermé, puis
//   `chromium.connect`) ;
// - `launchDedicated` : `spawn` du Chromium dédié, lecture de `DevToolsActivePort`, `connectOverCDP` de agent-browser.ts
//   (arguments figés, profil et HOME jetables, processus tué avant tout détachement) ;
// - `engineIdentity` : `installedEngineIdentity()` ; `openEgress` : `openBrowserEgress` (proxy d'egress local par essai).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumEgressLaunchOptions, openBrowserEgress, type BrowserEgress, type BrowserEgressOptions } from '@runtime/core/net';
import type { BrowserProvider, DedicatedLaunchOptions, LaunchedBrowser, LaunchedDedicated, ProviderCapabilities } from '@sym/contracts/browser';
import { chromium, type Browser } from 'playwright-core';
import { installedEngineIdentity } from './engine-identity.js';
import { assertNotRoot, chromiumEnv, chromiumLaunchOptions, CHROMIUM_LAUNCH_TIMEOUT_MS, CHROMIUM_SILENT_ARGS, GUARD_DISABLED_FEATURES } from './launch.js';

/** Fin de la sortie d'erreur de Chromium gardée pour dire la cause d'un lancement raté (bornée, sans le bruit D-Bus). */
const STDERR_TAIL_CHARS = 4000;

/**
 * Lancement raté du Chromium agentique. Le message est un CODE FERMÉ (`chromium_launch_signal:SIGTRAP`,
 * `chromium_launch_exit:3`, `chromium_launch_timeout`, `chromium_not_started:ENOENT`) : il remonte jusqu'à `error_detail`,
 * lisible par le propriétaire du run. La fin du stderr de Chromium (chemins, arguments, port du proxy d'egress) reste sur
 * `stderr`, pour le journal de l'opérateur seulement.
 */
export class ChromiumLaunchError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'ChromiumLaunchError';
    this.stderr = stderr;
  }
}

/** Sortie d'erreur du Chromium lue en continu (le tube ne se remplit jamais) ; seule sa fin est gardée. */
function stderrTail(child: ChildProcess): () => string {
  let tail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  return () =>
    tail
      .split('\n')
      .filter((line) => line.trim() !== '' && !/dbus|OOM score/i.test(line))
      .join(' | ')
      .replace(/[^\x20-\x7e]/g, '?')
      .slice(-300);
}

/** Code système (ENOENT, SIGTRAP) restreint à des majuscules, chiffres et tiret bas : jamais un texte libre. */
const closedCode = (value: string): string => (/^[A-Z0-9_]{1,20}$/.test(value) ? value : 'UNKNOWN');

/**
 * Attend le port CDP du Chromium dédié. Un Chromium arrêté au lancement (code de sortie, SIGNAL : un CHECK de Chromium ou
 * de crashpad finit en SIGTRAP, `exitCode` reste alors null) ou jamais lancé (binaire absent) échoue AUSSITÔT, avec un
 * code fermé (UX-23 ; la fin du stderr reste sur l'erreur pour l'opérateur), au lieu d'attendre tout le délai de lancement.
 */
async function waitForFile(path: string, timeoutMs: number, child: ChildProcess, spawnError: () => Error | undefined, stderr: () => string): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await readFile(path, 'utf8');
      if (text.includes('\n')) return text;
    } catch {
      // pas encore écrit
    }
    const failed = spawnError();
    if (failed !== undefined) throw new ChromiumLaunchError(`chromium_not_started:${closedCode((failed as NodeJS.ErrnoException).code ?? failed.name)}`, stderr());
    if (child.exitCode !== null) throw new ChromiumLaunchError(`chromium_launch_exit:${child.exitCode}`, stderr());
    if (child.signalCode !== null) throw new ChromiumLaunchError(`chromium_launch_signal:${closedCode(child.signalCode)}`, stderr());
    if (Date.now() > end) throw new ChromiumLaunchError('chromium_launch_timeout', stderr());
    await new Promise((r) => setTimeout(r, 50));
  }
}


/** Arguments figés du Chromium agentique (aucune entrée de stratégie, de prompt ni de membre). */
export function agentChromiumArgs(egressServer: string, profileDir: string, userAgent: string, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const egress = chromiumEgressLaunchOptions(egressServer, env);
  return [
    ...egress.args,
    `--proxy-server=${egress.proxy.server}`,
    // Sans cette règle, Chromium contournerait le proxy pour la boucle locale.
    '--proxy-bypass-list=<-loopback>',
    ...CHROMIUM_SILENT_ARGS,
    // Garde des requêtes (revue de 1.11) : mêmes fonctions coupées que le Chromium du pool (launch.ts).
    `--disable-features=${GUARD_DISABLED_FEATURES.join(',')}`,
    '--headless=new',
    `--user-agent=${userAgent}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--window-size=1280,900',
    'about:blank',
  ];
}

/** Le Chromium du worker tient toutes les capacités (04g §1). */
const LOCAL_CAPABILITIES: ProviderCapabilities = Object.freeze({
  egressPolicy: true,
  launchArgs: true,
  freshContextPerRun: true,
  killBeforeDetach: true,
  sandboxProbe: true,
  engineUserAgent: true,
  privateLatency: true,
});

export type LocalProviderOptions = {
  /** Proxy de lancement FERMÉ du Chromium partagé (`startEgressProxy({ refuseAll: true })`). */
  readonly launchProxyUrl: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Exécutable du Chromium dédié (défaut : celui de Playwright). */
  readonly executablePath?: string;
};

export function createLocalProvider(options: LocalProviderOptions): BrowserProvider<BrowserEgressOptions, BrowserEgress> {
  const env = options.env ?? process.env;
  return {
    kind: 'local',
    capabilities: LOCAL_CAPABILITIES,
    launchShared: () => launchSharedChromium(options.launchProxyUrl, env),
    launchDedicated: (launch) => launchDedicatedChromium(launch, env, options.executablePath),
    engineIdentity: () => Promise.resolve(installedEngineIdentity()),
    openEgress: openBrowserEgress,
  };
}

/** Chromium partagé : `launchServer` (processus tuable) puis `connect`, options figées (`launch.ts`). */
async function launchSharedChromium(launchProxyUrl: string, env: Readonly<Record<string, string | undefined>>): Promise<LaunchedBrowser> {
  assertNotRoot();
  const options = chromiumLaunchOptions(launchProxyUrl, env);
  const server = await chromium.launchServer({ ...options, args: [...options.args], proxy: { ...options.proxy } });
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    return {
      browser,
      close: async () => {
        await browser.close().catch(() => undefined);
        await server.close();
      },
      kill: () => server.kill(),
    };
  } catch (error) {
    await server.kill().catch(() => undefined);
    throw error;
  }
}

/** Étape de fermeture bornée (jamais rejetée). */
function settle(step: Promise<unknown>, ms = 5000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    void step.then(
      () => (clearTimeout(timer), resolve()),
      () => (clearTimeout(timer), resolve()),
    );
  });
}

/** Chromium dédié d'un essai agentique : processus propre, profil jetable, port CDP sur 127.0.0.1 pour la durée de l'essai. */
async function launchDedicatedChromium(launch: DedicatedLaunchOptions, env: Readonly<Record<string, string | undefined>>, executablePath: string | undefined): Promise<LaunchedDedicated> {
  if (launch.egressServer === null) throw new Error("fournisseur local : egressServer requis (le Chromium local passe par le proxy d'egress de l'essai)");
  assertNotRoot();
  const profile = await mkdtemp(join(tmpdir(), 'zz_agent_chromium_'));
  // HOME à lui, dans le profil jetable (UX-23) : le HOME hérité du worker peut être illisible (Render : le conteneur part
  // en root, HOME=/root, et le point d'entrée descend sur pwuser sans le changer) ; Chromium complet et son gestionnaire
  // crashpad s'y arrêtent alors en SIGTRAP. Le Chromium du pool (headless shell) n'en dépend pas.
  const home = join(profile, 'home');
  await mkdir(home, { mode: 0o700 });
  const child = spawn(executablePath ?? chromium.executablePath(), agentChromiumArgs(launch.egressServer, profile, launch.userAgent, env), {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...chromiumEnv(env), HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache') },
  });
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const stderr = stderrTail(child);
  /** Processus tué et attendu : plus rien ne part, aucune requête suspendue par une interception ne peut repartir. */
  const kill = async () => {
    if (spawnError === undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  };
  let browser: Browser | undefined;
  try {
    const [port, path] = (await waitForFile(join(profile, 'DevToolsActivePort'), launch.launchTimeoutMs ?? CHROMIUM_LAUNCH_TIMEOUT_MS, child, () => spawnError, stderr)).trim().split('\n');
    const cdpUrl = `ws://127.0.0.1:${Number(port)}${path ?? ''}`;
    browser = await chromium.connectOverCDP(cdpUrl);
    const opened = browser;
    return {
      cdpUrl,
      browser: opened,
      // Processus tué AVANT tout détachement CDP (voir agent-browser.ts `close`) ; connexion constatée fermée ensuite.
      close: async () => {
        await kill();
        await settle(opened.close());
      },
      kill,
    };
  } catch (error) {
    await kill();
    if (browser !== undefined) await settle(browser.close());
    throw error;
  }
}
