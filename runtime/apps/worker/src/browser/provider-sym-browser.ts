// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur de navigateur `sym-browser` (tâche 4.2 ; cdc/sym-browser 04e §2.2 et §4, 04g §1 et §2) : le Chromium d'une session
// SYM Browser (même hôte ou autre serveur) derrière `BrowserProvider`, par le SDK (`@sym-browser/sdk`).
// - `launchShared` : session `shared` EXPLICITE (le défaut de l'API est `dedicated`) à egress fermé (`allowedHosts: []`),
//   `chromium.connect` ; `close()` et `kill()` libèrent la session ;
// - `launchDedicated` : session `dedicated` (User-Agent, arguments, egress, métadonnées), `connectOverCDP` ; `cdpUrl` est l'URL
//   de la passerelle, transmise à Stagehand ;
// - `engineIdentity` : `GET /v1/version` ;
// - `openEgress` : politique d'egress de la session distante, tâche 4.3 (refus explicite d'ici là).
// Le worker lit `/v1/version` à chaque ouverture de session : SYM Browser pas encore démarré => attente (1 s puis doublement
// jusqu'à 30 s) bornée, puis erreur `retryable` (04g §2, démarrage indépendant). Une version de Playwright de majeure.mineure
// différente n'est jamais attendue : erreur fermée (AD2). L'origine des URL WebSocket rendues est ramenée à `BROWSER_URL`.
import type { BrowserProvider, EngineIdentity, LaunchedBrowser, LaunchedDedicated, ProviderCapabilities, VersionInfo } from '@sym/contracts/browser';
import type { SymBrowser } from '@sym-browser/sdk';
import type { CreateSessionRequest, Session } from '@sym/contracts/browser';

/** SYM Browser tient toutes les capacités côté navigateur (04g §1). */
const SYM_BROWSER_CAPABILITIES: ProviderCapabilities = Object.freeze({
  egressPolicy: true,
  launchArgs: true,
  freshContextPerRun: true,
  killBeforeDetach: true,
  sandboxProbe: true,
  engineUserAgent: true,
  privateLatency: true,
});

/** Part du client SDK que le fournisseur utilise (les tests en fournissent une doublure). */
export type SymBrowserLike = Pick<SymBrowser, 'version' | 'connect' | 'connectCDP'> & { sessions: Pick<SymBrowser['sessions'], 'create' | 'release'> };

/** Configuration refusée ou version incompatible : arrêt du démarrage, jamais réessayé. */
export class BrowserProviderError extends Error {
  override name = 'BrowserProviderError';
}

/** SYM Browser injoignable au-delà de l'attente : le run est à réessayer. */
class BrowserUnavailableError extends Error {
  override name = 'BrowserUnavailableError';
  readonly retryable = true;
}

const majorMinor = (version: string): string => version.split('.').slice(0, 2).join('.');

/** Contrôle d'une réponse de `/v1/version` : produit SYM Browser et Playwright de même majeure.mineure que le worker (AD2). */
export function checkVersion(info: Pick<VersionInfo, 'product' | 'playwright'>, playwrightVersion: string): void {
  if (info.product !== 'sym-browser') throw new BrowserProviderError(`BROWSER_URL ne répond pas comme SYM Browser (product « ${String(info.product)} »).`);
  if (majorMinor(info.playwright) !== majorMinor(playwrightVersion)) {
    throw new BrowserProviderError(
      `SYM Browser sert Playwright ${info.playwright} et le worker embarque ${playwrightVersion} : majeure.mineure différentes (AD2). Utilisez la même version de SYM et de SYM Browser (même tag d'image).`,
    );
  }
}

export type SymBrowserProviderOptions = {
  /** `BROWSER_URL` normalisée. */
  readonly url: URL;
  readonly client: SymBrowserLike;
  /** Identifiant du worker, en métadonnée de chaque session (nettoyage après redémarrage). */
  readonly workerId: string;
  /** Version de `playwright-core` du worker. */
  readonly playwrightVersion: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Attente maximale d'un SYM Browser qui ne répond pas (défaut 120 s). */
  readonly waitMs?: number;
};

const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 30_000;
const WAIT_DEFAULT_MS = 120_000;

/** `ws(s)` à l'origine de BROWSER_URL, chemin et jeton de l'URL rendue par la passerelle conservés. */
function withBrowserOrigin(value: string, base: URL): string {
  const url = new URL(value);
  url.protocol = base.protocol === 'https:' || base.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.host = base.host;
  return url.href;
}

function rewritten(session: Session, base: URL): Session {
  if (session.connectUrls === undefined) return session;
  const { cdp, playwright } = session.connectUrls;
  return Object.assign(Object.create(Object.getPrototypeOf(session) as object) as Session, session, {
    connectUrls: { ...session.connectUrls, playwright: withBrowserOrigin(playwright, base), cdp: cdp === null ? null : withBrowserOrigin(cdp, base) },
  });
}

export function createSymBrowserProvider(options: SymBrowserProviderOptions): BrowserProvider {
  const { client, url } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? WAIT_DEFAULT_MS;

  /** `GET /v1/version`, attendue : réessayée tant que SYM Browser ne répond pas, version incompatible refusée tout de suite. */
  async function readVersion(): Promise<VersionInfo> {
    const deadline = now() + waitMs;
    for (let delay = RETRY_FIRST_MS; ; delay = Math.min(delay * 2, RETRY_MAX_MS)) {
      let info: VersionInfo;
      try {
        info = await client.version();
      } catch {
        if (now() >= deadline) throw new BrowserUnavailableError('SYM Browser ne répond pas (BROWSER_URL) : run à réessayer.');
        await sleep(delay);
        continue;
      }
      checkVersion(info, options.playwrightVersion);
      return info;
    }
  }

  async function open(request: CreateSessionRequest, connect: (session: Session) => Promise<LaunchedBrowserLike>): Promise<{ session: Session; browser: LaunchedBrowserLike }> {
    await readVersion();
    const session = await client.sessions.create(request);
    try {
      return { session, browser: await connect(rewritten(session, url)) };
    } catch (error) {
      await client.sessions.release(session.id).catch(() => undefined);
      throw error;
    }
  }
  type LaunchedBrowserLike = LaunchedBrowser['browser'];

  return {
    kind: 'sym-browser',
    capabilities: SYM_BROWSER_CAPABILITIES,
    launchShared: async (): Promise<LaunchedBrowser> => {
      const { session, browser } = await open({ type: 'shared', egress: { allowedHosts: [] }, metadata: { workerId: options.workerId } }, (s) => client.connect(s));
      const release = async () => void (await client.sessions.release(session.id));
      return { browser, close: release, kill: release };
    },
    launchDedicated: async (launch): Promise<LaunchedDedicated> => {
      const { session, browser } = await open(
        {
          type: 'dedicated',
          userAgent: launch.userAgent,
          launchArgs: [...launch.launchArgs] as NonNullable<CreateSessionRequest['launchArgs']>,
          egress: launch.egress,
          metadata: { workerId: options.workerId, ...launch.metadata },
        },
        (s) => client.connectCDP(s),
      );
      const release = async () => void (await client.sessions.release(session.id));
      const cdp = rewritten(session, url).connectUrls?.cdp;
      if (cdp === null || cdp === undefined) {
        await release().catch(() => undefined);
        throw new BrowserProviderError("SYM Browser n'a pas rendu d'URL CDP pour la session dedicated.");
      }
      return { cdpUrl: cdp, browser, close: release, kill: release };
    },
    engineIdentity: async (): Promise<EngineIdentity> => {
      const info = await readVersion();
      return { version: info.chromium, platform: info.platform };
    },
    openEgress: () => Promise.reject(new BrowserProviderError("fournisseur sym-browser : openEgress distant livré par la tâche 4.3 (politique d'egress de la session).")),
  };
}
