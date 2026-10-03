// SPDX-License-Identifier: AGPL-3.0-only
// Lancement d'un Chromium du pool (04b § 1 et § 2, 03 § 7, 04c § 1.1, tâche 1.1) : `chromium.launchServer` sur 127.0.0.1,
// chemin WebSocket imprévisible (tiré par Playwright), bac à sable ACTIF, arguments et environnement FIGÉS dans le code.
// Repris des choix du worker de SYM (runtime/apps/worker/src/browser/launch.ts, non importable : frontière du module) :
// - `chromiumSandbox: true` : sans cette option Playwright ajoute `--no-sandbox` ; jamais en root, jamais de repli ;
// - proxy de lancement fermé local (`closed-proxy.ts`) ; chaque contexte recevra l'egress de sa session (1.3, 1.5) ;
// - résolveur DNS de Chromium coupé (l'egress résout), WebRTC sans UDP hors proxy (04c § 1.1) ;
// - Chromium silencieux (aucun trafic de fond) ; `--disable-features` unique qui reprend la liste de Playwright ;
// - environnement réduit à une liste blanche : ni MASTER_KEY, ni DATABASE_URL, ni NODE_TOKEN dans Chromium ;
// - signaux gardés par le nœud (drainage, 04b § 9).
// Les sessions `dedicated` de la tâche 1.4 ajouteront leur profil temporaire, `--remote-debugging-port` et `launchArgs`.
import { chromium, type Browser } from 'playwright-core';
import type { BrowserLauncher, LaunchedBrowser } from './pool.js';
import type { OwnedProcessGroups } from './process-group.js';

/** Arguments figés : 04c § 1.1 (DNS, WebRTC) puis Chromium silencieux (même liste que SYM). */
export const CHROMIUM_FROZEN_ARGS: readonly string[] = Object.freeze([
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-client-side-phishing-detection',
  '--safebrowsing-disable-auto-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--metrics-recording-only',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-pings',
  '--no-service-autorun',
  '--disable-search-engine-choice-screen',
  '--disable-dev-shm-usage',
  '--password-store=basic',
  '--use-mock-keychain',
]);

/** Liste `disabledFeatures` de Playwright 1.63, reprise telle quelle (vérifiée contre le paquet installé par le test). */
const PLAYWRIGHT_DISABLED_FEATURES: readonly string[] = Object.freeze([
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
]);

/** Prérendu, préchargement de prérendu et WebSocketStream : requêtes hors du contrôle de l'egress par contexte (comme SYM). */
const EXTRA_DISABLED_FEATURES: readonly string[] = Object.freeze(['Prerender2', 'Prerender2FallbackPrefetchSpecRules', 'WebSocketStream']);

const CHROMIUM_ENV_ALLOWLIST: readonly string[] = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']);

/** Désactiverait le passage forcé de la boucle locale par le proxy (04c § 1.1) : refusée. */
const FORBIDDEN_ENV = 'PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK';

export function chromiumEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CHROMIUM_ENV_ALLOWLIST) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export class ChromiumAsRootError extends Error {
  override name = 'ChromiumAsRootError';
}

export function assertNotRoot(getuid: (() => number) | undefined = process.getuid?.bind(process)): void {
  if (getuid !== undefined && getuid() === 0) {
    throw new ChromiumAsRootError('Chromium ne se lance pas en root : utilise l’utilisateur non root de l’image (pwuser).');
  }
}

/** Délai de lancement (chien de garde de lancement, 04b § 4 : 60 s, valeur SYM à valider). */
export const CHROMIUM_LAUNCH_TIMEOUT_MS = 60_000;

export type ChromiumLaunchOptions = {
  readonly headless: true;
  readonly chromiumSandbox: true;
  readonly host: '127.0.0.1';
  readonly proxy: { readonly server: string };
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly handleSIGINT: false;
  readonly handleSIGTERM: false;
  readonly handleSIGHUP: false;
  readonly timeout: number;
};

export function chromiumLaunchOptions(launchProxyUrl: string, env: Readonly<Record<string, string | undefined>> = process.env): ChromiumLaunchOptions {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(launchProxyUrl)) throw new RangeError('proxy de lancement : http://127.0.0.1:<port> attendu (proxy fermé local)');
  if (env[FORBIDDEN_ENV] !== undefined) throw new Error(`${FORBIDDEN_ENV} est définie : lancement refusé (04c § 1.1).`);
  return Object.freeze({
    headless: true,
    chromiumSandbox: true,
    host: '127.0.0.1',
    proxy: Object.freeze({ server: launchProxyUrl }),
    args: Object.freeze([...CHROMIUM_FROZEN_ARGS, `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, ...EXTRA_DISABLED_FEATURES].join(',')}`]),
    env: Object.freeze(chromiumEnv(env)),
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: CHROMIUM_LAUNCH_TIMEOUT_MS,
  });
}

export type PlaywrightLauncherOptions = {
  launchProxyUrl: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Registre des groupes de processus : kill forcé et balayage limités aux Chromium lancés ici. */
  groups: OwnedProcessGroups;
};

/** Lanceur de production : `launchServer` (processus tuable, WebSocket local) puis `connect` interne du nœud. */
export function playwrightLauncher(options: PlaywrightLauncherOptions): BrowserLauncher {
  let sequence = 0;
  return async () => {
    assertNotRoot();
    const launch = chromiumLaunchOptions(options.launchProxyUrl, options.env ?? process.env);
    const server = await chromium.launchServer({ ...launch, args: [...launch.args], proxy: { ...launch.proxy }, env: { ...launch.env } });
    const pid = server.process().pid;
    if (pid !== undefined) options.groups.add(pid);
    const kill = async (): Promise<void> => {
      // Groupe entier (processus principal, rendus, GPU, zygote) ; à défaut de pid, l'arrêt de Playwright (même groupe).
      if (pid === undefined || !(await options.groups.kill(pid))) await server.kill().catch(() => undefined);
    };
    let browser: Browser;
    try {
      browser = await chromium.connect(server.wsEndpoint(), { timeout: launch.timeout });
    } catch (error) {
      await kill();
      throw error;
    }
    sequence += 1;
    const launched: LaunchedBrowser = {
      id: `chromium-${pid ?? 'x'}-${sequence}`,
      pid,
      wsEndpoint: server.wsEndpoint(),
      browser,
      isConnected: () => browser.isConnected(),
      onDisconnected: (listener) => void browser.once('disconnected', () => listener()),
      close: async () => {
        await browser.close().catch(() => undefined);
        await server.close();
        if (pid !== undefined) options.groups.retire(pid);
      },
      kill,
    };
    return launched;
  };
}
