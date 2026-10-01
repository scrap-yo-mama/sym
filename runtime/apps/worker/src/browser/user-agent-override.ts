// SPDX-License-Identifier: AGPL-3.0-only
// User-Agent réel du moteur dans un contexte de run (17 §5 et §11, 08b, D-33, revue de fix-ua-engine, D-39).
// L'option `userAgent` de Playwright est écartée : Playwright y joint un `userAgentMetadata` qu'il DÉDUIT de la chaîne
// (`calculateUserAgentMetadata` : architecture « x86 » par défaut, version de plateforme tirée de la chaîne ou vide), qui
// écrase les vrais indices clients du moteur (constaté sur Chromium 153, darwin arm64 : architecture=x86,
// platformVersion=10_15_7 au lieu de arm et 15.6.1). `--user-agent` au lancement ne convient pas davantage : Chromium vide
// alors les indices à haute entropie (architecture, bitness, platformVersion, versions complètes).
// Ce module pose donc lui-même `Emulation.setUserAgentOverride` : la chaîne du moteur (`buildUserAgent`), avec un
// `userAgentMetadata` RELU sur le moteur, tel quel : `navigator.userAgentData` d'un contexte vierge du même navigateur
// (aucun User-Agent, aucune émulation), marques comprises (« HeadlessChrome » n'est pas réécrit, 17 §12). Aucune valeur
// n'est écrite dans le code (porte statique `assert_no_fingerprint_spoofing`). Ni langue, ni plateforme surchargées.
// Portée : la page du run (cadres du même processus compris) et, par attachement automatique (cible retenue jusqu'à la
// pose), chaque cadre hors processus, imbriqué ou non ; les workers dédiés héritent du User-Agent de leur cadre. Échec
// fermé : la page sans surcharge fait échouer l'ouverture du contexte ; un cadre hors processus sans surcharge reste
// suspendu (il ne charge rien). La session vit jusqu'à la fermeture du contexte : détachée, la surcharge tomberait.
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { childChannels, sessionChannel, type Channel } from './request-guard.js';

/** Brand CDP (`Emulation.UserAgentBrandVersion`). */
type Brand = { readonly brand: string; readonly version: string };

/** `Emulation.UserAgentMetadata` du moteur, relu tel quel sur `navigator.userAgentData`. */
export type EngineUserAgentMetadata = {
  readonly brands: readonly Brand[];
  readonly fullVersionList: readonly Brand[];
  readonly fullVersion: string;
  readonly platform: string;
  readonly platformVersion: string;
  readonly architecture: string;
  readonly model: string;
  readonly mobile: boolean;
  readonly bitness: string;
  readonly wow64: boolean;
  readonly formFactors?: readonly string[];
};

class EngineClientHintsError extends Error {
  override name = 'EngineClientHintsError';
}

/**
 * Médias jamais émulés : Playwright envoie toujours `Emulation.setEmulatedMedia` ; avec ces options, il ne porte aucune
 * valeur (type de média et préférences vides : celles du moteur). Sans elles, il émulerait `prefers-color-scheme: light`.
 */
export const NO_MEDIA_EMULATION = Object.freeze({ colorScheme: null, reducedMotion: null, forcedColors: null, contrast: null } as const);

/** Indices à haute entropie demandés au moteur : tous ceux de `Emulation.UserAgentMetadata`. */
const HIGH_ENTROPY_HINTS: readonly string[] = Object.freeze(['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64']);

/** Origine de confiance (contexte sécurisé, sans lequel `navigator.userAgentData` n'existe pas), servie par une route. */
const PROBE_URL = 'http://localhost/';

const isBrands = (value: unknown): value is Brand[] =>
  Array.isArray(value) && value.every((b) => typeof b === 'object' && b !== null && typeof (b as Brand).brand === 'string' && typeof (b as Brand).version === 'string');

/** Valeurs lues dans la page → `Emulation.UserAgentMetadata` ; toute valeur absente ou d'un autre type est refusée. */
function metadataFromHints(hints: Record<string, unknown>): EngineUserAgentMetadata {
  const text = (name: string): string => {
    const value = hints[name];
    if (typeof value !== 'string') throw new EngineClientHintsError(`indice client « ${name} » illisible`);
    return value;
  };
  const flag = (name: string): boolean => {
    const value = hints[name];
    if (typeof value !== 'boolean') throw new EngineClientHintsError(`indice client « ${name} » illisible`);
    return value;
  };
  const brands = hints['brands'];
  const fullVersionList = hints['fullVersionList'];
  if (!isBrands(brands) || !isBrands(fullVersionList)) throw new EngineClientHintsError('marques des indices clients illisibles');
  const formFactors = hints['formFactors'];
  if (formFactors !== undefined && !(Array.isArray(formFactors) && formFactors.every((f) => typeof f === 'string'))) throw new EngineClientHintsError('indice client « formFactors » illisible');
  return Object.freeze({
    brands: brands.map((b) => ({ brand: b.brand, version: b.version })),
    fullVersionList: fullVersionList.map((b) => ({ brand: b.brand, version: b.version })),
    fullVersion: text('uaFullVersion'),
    platform: text('platform'),
    platformVersion: text('platformVersion'),
    architecture: text('architecture'),
    model: text('model'),
    mobile: flag('mobile'),
    bitness: text('bitness'),
    wow64: flag('wow64'),
    ...(formFactors === undefined ? {} : { formFactors: [...(formFactors as string[])] }),
  });
}

const read = new WeakMap<Browser, Promise<EngineUserAgentMetadata>>();

/**
 * Indices clients réels du moteur de `browser` : lus une fois par navigateur, dans un contexte vierge (aucun User-Agent,
 * aucune émulation) dont la seule page est servie par une route (aucune connexion). Échec : rejet, rien en cache.
 */
export function engineUserAgentMetadata(browser: Browser): Promise<EngineUserAgentMetadata> {
  let pending = read.get(browser);
  if (pending === undefined) {
    pending = readEngineMetadata(browser);
    read.set(browser, pending);
    pending.catch(() => read.delete(browser));
  }
  return pending;
}

async function readEngineMetadata(browser: Browser): Promise<EngineUserAgentMetadata> {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, ...NO_MEDIA_EMULATION });
  try {
    await context.route('**/*', (route) =>
      route.request().url() === PROBE_URL ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title></title>' }) : route.abort('blockedbyclient'),
    );
    const page = await context.newPage();
    await page.goto(PROBE_URL);
    const hints = await page.evaluate(async (names) => {
      const data = (
        navigator as unknown as {
          userAgentData?: { brands: unknown; mobile: unknown; platform: unknown; getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> };
        }
      ).userAgentData;
      if (data === undefined) return null;
      return { brands: data.brands, mobile: data.mobile, platform: data.platform, ...(await data.getHighEntropyValues(names)) };
    }, HIGH_ENTROPY_HINTS as string[]);
    if (hints === null) throw new EngineClientHintsError('navigator.userAgentData absent du moteur');
    return metadataFromHints(hints);
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Attachement automatique aux seuls cadres hors processus, retenus jusqu'à la pose de la surcharge (mode non aplati). */
const AUTO_ATTACH_FRAMES = { autoAttach: true, waitForDebuggerOnStart: true, flatten: false, filter: [{ type: 'iframe' }] } as const;

/**
 * Pose le User-Agent `userAgent` et les indices clients réels `metadata` sur `page` (et ses cadres hors processus) AVANT
 * toute navigation. Lève si la page ne peut pas la recevoir.
 */
export async function installUserAgentOverride(context: BrowserContext, page: Page, userAgent: string, metadata: EngineUserAgentMetadata): Promise<void> {
  const override = { userAgent, userAgentMetadata: metadata };
  const session = await context.newCDPSession(page);
  /** Surcharge, puis attachement automatique des cadres enfants ; `true` si la surcharge est posée. */
  const arm = async (channel: Channel): Promise<boolean> => {
    const child = childChannels(channel);
    channel.on('Target.attachedToTarget', (params) => {
      const target = child(String(params['sessionId']));
      void (async () => {
        // Échec fermé : un cadre sans la surcharge reste suspendu, aucune requête ne part.
        if (!(await arm(target))) return;
        await target.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
      })();
    });
    const armed = await channel.send('Emulation.setUserAgentOverride', override).then(
      () => true,
      () => false,
    );
    if (armed) await channel.send('Target.setAutoAttach', AUTO_ATTACH_FRAMES).catch(() => undefined);
    return armed;
  };
  try {
    if (!(await arm(sessionChannel(session)))) throw new EngineClientHintsError('surcharge du User-Agent impossible sur la page du run');
  } catch (error) {
    await session.detach().catch(() => undefined);
    throw error;
  }
}
