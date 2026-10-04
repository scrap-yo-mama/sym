// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur de navigateur `cdp` générique (tâche 4.7 ; cdc/sym-browser 04g §3 et §8) : un navigateur derrière une adresse CDP
// (Browserbase, Steel, Browserless, Chromium exposé en CDP…), sur activation explicite de l'admin (`BROWSER_ALLOW_GENERIC_CDP=true`,
// provider-detect.ts). SYM y applique tout ce qui relève de SYM (enquête, schéma, robots.txt à chaque requête, gardes du worker par
// CDP, masquage des secrets) ; seules les capacités côté navigateur, celles que SYM Browser fournit, sont absentes et déclarées
// telles (`CDP_CAPABILITIES`), jamais simulées.
// - adaptateur (`browserbase`, `steel`) : une session créée par l'API du fournisseur à chaque ouverture (une session par run),
//   `connectOverCDP` sur l'URL rendue, libération par l'API puis détachement ;
// - URL fixe (avec jeton facultatif en `Authorization: Bearer`) : `connectOverCDP` sur BROWSER_URL, `Browser.close` puis détachement ;
// - paramètres de session envoyés (liste fermée) : durée maximale, corrélation `runId` et `attemptId` en métadonnées (là où le
//   fournisseur en porte), proxy du compte quand l'admin l'active. Tout autre réglage reste celui du compte chez le fournisseur.
// - `openEgress` : egress local réservé aux requêtes de Node ; le navigateur distant n'en dépend pas (`server: null`).
// Secrets (clé du fournisseur, jeton) : jamais dans un message d'erreur ni dans un journal ; l'erreur d'un fournisseur ne rend que le
// code HTTP, jamais le corps de sa réponse.
import { openBrowserEgress, type BrowserEgressOptions } from '@runtime/core/net';
import type { BrowserProvider, EngineIdentity, LaunchedBrowser, LaunchedDedicated, ProviderCapabilities } from '@sym/contracts/browser';
import { chromium, type Browser } from 'playwright-core';
import { installedEngineIdentity } from './engine-identity.js';
import type { RunEgress } from './run-egress.js';

/** Capacités côté navigateur d'un fournisseur CDP : toutes absentes (04g §1). */
export const CDP_CAPABILITIES: ProviderCapabilities = Object.freeze({
  egressPolicy: false,
  launchArgs: false,
  freshContextPerRun: false,
  killBeforeDetach: false,
  sandboxProbe: false,
  engineUserAgent: false,
  privateLatency: false,
});

/** Capacités côté navigateur absentes avec un fournisseur CDP (04g §3) : message de refus du démarrage, journal et console. */
export const CDP_ABSENT_CAPABILITIES: readonly string[] = Object.freeze([
  "egress par session et garde SSRF au niveau réseau (INV10 : la garde reste tenue par SYM pour les requêtes de Node)",
  'verrou de domaines sur les sauts de redirection et les sous-ressources dans le réseau (le worker coupe les sauts par CDP)',
  "budget d'octets par session (plafond max_cost_usd)",
  'arguments de lancement INV11 (le worker neutralise WebSocketStream par script d’init)',
  'proxy de lancement fermé (Chromium oisif muet)',
  'contexte neuf par run avec proxy imposé (une session fournisseur par run)',
  'ordre « tuer avant détacher »',
  'bac à sable vérifié (assert_chromium_sandboxed)',
  'User-Agent réel posé au lancement',
  'latence des gardes dans les seuils de 04e §7',
]);

/** Métadonnées d'une session à créer chez le fournisseur (liste fermée, 04g §3). */
export type CdpSessionMeta = {
  readonly runId?: string;
  readonly attemptId?: string;
  readonly workerId: string;
  readonly timeoutSeconds: number;
  readonly accountProxy: boolean;
};

/** Création et libération d'une session chez un fournisseur d'hébergement de navigateurs. */
export interface CdpSessionAdapter {
  create(meta: CdpSessionMeta): Promise<{ cdpUrl: string; release(): Promise<void> }>;
}

/** Refus d'un fournisseur : jamais le corps de sa réponse (il peut citer la clé). */
export class CdpAdapterError extends Error {
  override name = 'CdpAdapterError';
}

const REQUEST_TIMEOUT_MS = 30_000;

type AdapterOptions = { readonly apiKey: string; readonly fetch?: typeof fetch; readonly baseUrl?: string };

async function call(fetchFn: typeof fetch, provider: string, action: string, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new CdpAdapterError(`fournisseur CDP (${provider}) : ${action} impossible (fournisseur injoignable).`);
  }
  if (!response.ok) throw new CdpAdapterError(`fournisseur CDP (${provider}) : ${action} refusé (HTTP ${response.status}).`);
  try {
    const parsed = (await response.json()) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Browserbase : `POST /v1/sessions` (durée en secondes, `userMetadata`, `proxies`), `connectUrl` déjà authentifiée. */
export function browserbaseAdapter(options: AdapterOptions & { readonly projectId?: string }): CdpSessionAdapter {
  const fetchFn = options.fetch ?? fetch;
  const base = (options.baseUrl ?? 'https://api.browserbase.com').replace(/\/+$/, '');
  const headers = { 'x-bb-api-key': options.apiKey };
  return {
    create: async (meta) => {
      const userMetadata: Record<string, string> = { ...(meta.runId === undefined ? {} : { runId: meta.runId }), ...(meta.attemptId === undefined ? {} : { attemptId: meta.attemptId }), workerId: meta.workerId };
      const created = await call(fetchFn, 'browserbase', 'création de session', `${base}/v1/sessions`, headers, {
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        timeout: meta.timeoutSeconds,
        userMetadata,
        ...(meta.accountProxy ? { proxies: true } : {}),
      });
      const id = text(created['id']);
      const cdpUrl = text(created['connectUrl']);
      if (id === undefined || cdpUrl === undefined) throw new CdpAdapterError('fournisseur CDP (browserbase) : réponse sans identifiant ni connectUrl.');
      return {
        cdpUrl,
        release: async () => void (await call(fetchFn, 'browserbase', 'libération de session', `${base}/v1/sessions/${encodeURIComponent(id)}`, headers, { ...(options.projectId === undefined ? {} : { projectId: options.projectId }), status: 'REQUEST_RELEASE' })),
      };
    },
  };
}

/** Steel : `POST /v1/sessions` (durée en millisecondes, `useProxy`), URL CDP = `websocketUrl` avec la clé. */
export function steelAdapter(options: AdapterOptions): CdpSessionAdapter {
  const fetchFn = options.fetch ?? fetch;
  const base = (options.baseUrl ?? 'https://api.steel.dev').replace(/\/+$/, '');
  const headers = { 'steel-api-key': options.apiKey };
  return {
    create: async (meta) => {
      const created = await call(fetchFn, 'steel', 'création de session', `${base}/v1/sessions`, headers, { timeout: meta.timeoutSeconds * 1000, ...(meta.accountProxy ? { useProxy: true } : {}) });
      const id = text(created['id']);
      const websocketUrl = text(created['websocketUrl']);
      if (id === undefined || websocketUrl === undefined) throw new CdpAdapterError('fournisseur CDP (steel) : réponse sans identifiant ni websocketUrl.');
      return {
        cdpUrl: `${websocketUrl}${websocketUrl.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(options.apiKey)}`,
        release: async () => void (await call(fetchFn, 'steel', 'libération de session', `${base}/v1/sessions/${encodeURIComponent(id)}/release`, headers, {})),
      };
    },
  };
}

export type CdpMode =
  | { readonly kind: 'url'; readonly url: string; readonly token?: string }
  | { readonly kind: 'adapter'; readonly adapter: CdpSessionAdapter; readonly timeoutSeconds: number; readonly accountProxy: boolean };

export type CdpProviderOptions = {
  readonly mode: CdpMode;
  readonly workerId: string;
  /** `chromium.connectOverCDP` (tests : doublure). */
  readonly connect?: (url: string, options: { headers?: Record<string, string> }) => Promise<Browser>;
};

type Opened = { readonly cdpUrl: string; readonly browser: Browser; readonly teardown: () => Promise<void> };

export function createCdpProvider(options: CdpProviderOptions): BrowserProvider<BrowserEgressOptions, RunEgress> {
  const { mode } = options;
  const connect = options.connect ?? ((url, connectOptions) => chromium.connectOverCDP(url, connectOptions));

  /** Détachement : `Browser.close` demandé au navigateur (URL fixe), puis connexion fermée. Jamais rejeté. */
  const detach = async (browser: Browser, closeRemote: boolean): Promise<void> => {
    if (closeRemote) {
      try {
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close');
      } catch {
        // Déjà fermé ou connexion coupée.
      }
    }
    await browser.close().catch(() => undefined);
  };

  async function open(metadata: Record<string, string> | undefined): Promise<Opened> {
    if (mode.kind === 'url') {
      const browser = await connect(mode.url, mode.token === undefined ? {} : { headers: { authorization: `Bearer ${mode.token}` } });
      let done: Promise<void> | undefined;
      return { cdpUrl: mode.url, browser, teardown: () => (done ??= detach(browser, true)) };
    }
    const session = await mode.adapter.create({
      ...(metadata?.['runId'] === undefined ? {} : { runId: metadata['runId'] }),
      ...(metadata?.['attemptId'] === undefined ? {} : { attemptId: metadata['attemptId'] }),
      workerId: options.workerId,
      timeoutSeconds: mode.timeoutSeconds,
      accountProxy: mode.accountProxy,
    });
    let browser: Browser;
    try {
      browser = await connect(session.cdpUrl, {});
    } catch (error) {
      await session.release().catch(() => undefined);
      throw error;
    }
    let done: Promise<void> | undefined;
    // Libération par l'API du fournisseur, puis détachement.
    return {
      cdpUrl: session.cdpUrl,
      browser,
      teardown: () =>
        (done ??= (async () => {
          await session.release().catch(() => undefined);
          await detach(browser, false);
        })()),
    };
  }

  return {
    kind: 'cdp',
    capabilities: CDP_CAPABILITIES,
    launchShared: async (): Promise<LaunchedBrowser> => {
      const opened = await open(undefined);
      return { browser: opened.browser, close: opened.teardown, kill: opened.teardown };
    },
    // Ni User-Agent, ni arguments, ni egress au lancement : le navigateur distant n'en reçoit pas (capacités absentes déclarées).
    launchDedicated: async (launch): Promise<LaunchedDedicated> => {
      const opened = await open(launch.metadata);
      return { cdpUrl: opened.cdpUrl, browser: opened.browser, close: opened.teardown, kill: opened.teardown };
    },
    // Le moteur distant n'est pas lisible avant la connexion : identité du Chromium installé (jamais posée au lancement, `engineUserAgent` absente).
    engineIdentity: (): Promise<EngineIdentity> => Promise.resolve(installedEngineIdentity()),
    openEgress: async (egressOptions) => {
      const egress = await openBrowserEgress(egressOptions);
      // Le proxy local ne sert qu'aux requêtes de Node : un navigateur distant ne peut pas l'atteindre.
      return { ...egress, server: null, capabilities: CDP_CAPABILITIES };
    },
  };
}
