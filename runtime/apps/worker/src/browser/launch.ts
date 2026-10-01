// SPDX-License-Identifier: AGPL-3.0-only
// Lancement de Chromium 153 (Playwright 1.63) pour le worker (tâche 1.6 ; 03 ; 08 §3 ; 08b §1 ; 14 §11) :
// - arguments et options de proxy FIGÉS dans le code (aucune entrée de stratégie, de prompt ou de membre) ;
// - silencieux : trafic de fond coupé (mises à jour de composants, Safe Browsing, métriques, suggestions, rapports) ;
//   les commutateurs par défaut de Playwright restent (dont son `--disable-features`, qu'un second exemplaire écraserait) ;
// - tout le trafic passe par un proxy d'egress local : au lancement, un proxy FERMÉ (rien ne sort hors d'un contexte de
//   run) ; chaque contexte de run reçoit son propre proxy d'egress (`browser.newContext({ proxy })`) ;
// - bac à sable de Chromium ACTIF (`chromiumSandbox: true`) : sans cette option, Playwright ajoute lui-même
//   `--no-sandbox` à la ligne de commande. Un rendu compromis par une page hostile resterait sinon sous l'uid du worker
//   (lecture de /proc/<worker>/environ, donc DATABASE_URL). Dans le conteneur (non root), le bac à sable exige les
//   espaces de noms utilisateur : profil seccomp de Playwright ou userns autorisés (à valider sur l'image, tâche 4.1).
//   Sans eux, le lancement échoue (échec fermé), jamais de repli sur `--no-sandbox` ;
// - jamais en root (Chromium exigerait alors `--no-sandbox`) ; environnement réduit (ni MASTER_KEY, ni DATABASE_URL, ni
//   clé LLM dans le processus Chromium) ; `--disable-dev-shm-usage` (conteneur).
import { chromiumEgressLaunchOptions } from '@runtime/core/net';

/**
 * Liste figée (08 §3 « Chromium silencieux »). Doublons des défauts de Playwright volontaires : la liste ne dépend pas
 * de ceux-ci. Le test « Chromium à vide : 0 requête sortante » en vérifie l'effet au proxy de lancement.
 */
export const CHROMIUM_SILENT_ARGS: readonly string[] = Object.freeze([
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

/** Variables d'environnement transmises au processus Chromium : rien d'autre (secrets exclus par construction). */
const CHROMIUM_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
]);

export function chromiumEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CHROMIUM_ENV_ALLOWLIST) {
    const v = env[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

export class ChromiumAsRootError extends Error {
  override name = 'ChromiumAsRootError';
}

/** Refus de lancer Chromium sous l'uid 0 (03 : « exécuté en non-root »). */
export function assertNotRoot(getuid: (() => number) | undefined = process.getuid?.bind(process)): void {
  if (getuid !== undefined && getuid() === 0) {
    throw new ChromiumAsRootError('Chromium ne se lance pas en root : utilisez l’utilisateur non root de l’image (pwuser).');
  }
}

export type ChromiumLaunchOptions = {
  readonly headless: true;
  /** Bac à sable de Chromium : jamais `--no-sandbox`. */
  readonly chromiumSandbox: true;
  readonly host: '127.0.0.1';
  readonly proxy: { readonly server: string };
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly handleSIGINT: false;
  readonly handleSIGTERM: false;
  readonly handleSIGHUP: false;
  readonly timeout: number;
};

/**
 * Options de `chromium.launchServer` : proxy de lancement (fermé), résolveur DNS local coupé (le proxy résout), WebRTC
 * sans UDP hors proxy, liste silencieuse. Le serveur WebSocket de Playwright n'écoute que sur 127.0.0.1, chemin
 * imprévisible. Les signaux restent au worker (arrêt propre, 14 §1).
 */
export function chromiumLaunchOptions(
  launchProxyUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChromiumLaunchOptions {
  const egress = chromiumEgressLaunchOptions(launchProxyUrl, env);
  return Object.freeze({
    headless: true,
    chromiumSandbox: true,
    host: '127.0.0.1',
    proxy: egress.proxy,
    args: Object.freeze([...egress.args, ...CHROMIUM_SILENT_ARGS]),
    env: chromiumEnv(env),
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: 60_000,
  });
}
