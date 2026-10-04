// SPDX-License-Identifier: AGPL-3.0-only
// Détection du fournisseur de navigateur (tâche 4.2 ; cdc/sym-browser 04g §2 et §8) : une seule variable, `BROWSER_URL`
// (+ `BROWSER_API_KEY` ou `BROWSER_API_KEY_FILE`).
// - absente : `local` ;
// - présente : forme normalisée (`http://` ajouté sans schéma), puis `GET /v1/version` (sans clé) :
//   `product: "sym-browser"` => fournisseur `sym-browser` (Playwright de même majeure.mineure exigé) ; autre réponse, URL
//   `ws(s)://` ou `BROWSER_CDP_ADAPTER` => CDP générique (tâche 4.7, provider-cdp.ts), accepté SEULEMENT avec
//   `BROWSER_ALLOW_GENERIC_CDP=true` : sans lui, arrêt qui nomme la variable et donne les capacités absentes ;
// - SYM Browser qui ne répond pas encore : le worker démarre quand même (fournisseur `sym-browser` dont l'ouverture des
//   sessions attend et réessaie, provider-sym-browser.ts).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { secretValues } from '@runtime/core';
import type { BrowserProvider } from '@sym/contracts/browser';
import { SymBrowser } from '@sym-browser/sdk';
import { browserbaseAdapter, CDP_ABSENT_CAPABILITIES, createCdpProvider, steelAdapter, type CdpMode, type CdpSessionAdapter } from './provider-cdp.js';
import { BrowserProviderError, checkVersion, createSymBrowserProvider, type SymBrowserLike } from './provider-sym-browser.js';

const PROBE_TIMEOUT_MS = 5000;

export type DetectDeps = {
  /** Fournisseur `local` (construit seulement quand `BROWSER_URL` est absente). */
  readonly createLocal: () => BrowserProvider;
  /** Version de `playwright-core` du worker (défaut : celle installée). */
  readonly playwrightVersion?: string;
  readonly createClient?: (options: { url: string; apiKey: string; fetch: typeof fetch }) => SymBrowserLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly workerId?: string;
};

/** `BROWSER_URL` : `http(s)://hôte[:port]`, `hôte:port` sans schéma (complété par `http://`), ou `ws(s)://…`. */
export function normalizeBrowserUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed === '') throw new BrowserProviderError('BROWSER_URL est vide.');
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new BrowserProviderError('BROWSER_URL invalide : http(s)://hôte[:port], hôte:port ou ws(s)://… attendu.');
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new BrowserProviderError('BROWSER_URL invalide : http(s)://hôte[:port], hôte:port ou ws(s)://… attendu.');
  return url;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Secret d'une variable `NOM` ou `NOM_FILE` (les deux posées : refus) ; `undefined` si aucune. Enregistré au masquage ; jamais repris dans un message. */
function secretEnv(env: Env, name: string): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  const hasDirect = direct !== undefined && direct !== '';
  const hasFile = file !== undefined && file !== '';
  if (hasDirect && hasFile) throw new BrowserProviderError(`${name} et ${name}_FILE sont posées toutes les deux : n'en gardez qu'une.`);
  let value: string | undefined;
  if (hasFile) {
    try {
      value = readFileSync(file, 'utf8').replace(/\s+$/, '');
    } catch (error) {
      throw new BrowserProviderError(`${name}_FILE illisible : ${(error as NodeJS.ErrnoException).code ?? 'erreur'}.`);
    }
  } else if (hasDirect) value = direct;
  if (value !== undefined && value !== '') secretValues.add(value);
  return value === '' ? undefined : value;
}

/** Clé de SYM Browser (`BROWSER_API_KEY` ou `_FILE`, lue plus tôt) : requise. */
function requireApiKey(key: string | undefined): string {
  if (key === undefined) throw new BrowserProviderError('BROWSER_API_KEY (ou BROWSER_API_KEY_FILE) est requise avec BROWSER_URL : clé d’API de SYM Browser.');
  return key;
}

const genericCdpRefused = (reason: string): BrowserProviderError =>
  new BrowserProviderError(
    `${reason} Un navigateur CDP générique exige BROWSER_ALLOW_GENERIC_CDP=true. Capacités côté navigateur absentes avec un fournisseur CDP : ${CDP_ABSENT_CAPABILITIES.join(' ; ')}. ` +
      'Choisissez SYM Browser, ou retirez BROWSER_URL pour le Chromium local.',
  );

/** Variables `BROWSER_CDP_*` : liste fermée de la tâche 4.7 (04g §3), jamais de réglage libre du fournisseur. */
const CDP_VARIABLES: ReadonlySet<string> = new Set(['BROWSER_CDP_ADAPTER', 'BROWSER_CDP_PROJECT_ID', 'BROWSER_CDP_PROJECT_ID_FILE', 'BROWSER_CDP_SESSION_TIMEOUT_SECONDS', 'BROWSER_CDP_ACCOUNT_PROXY']);
const CDP_TIMEOUT_DEFAULT_SECONDS = 900;
const CDP_TIMEOUT_MIN_SECONDS = 60;
const CDP_TIMEOUT_MAX_SECONDS = 21_600;

/** Masquage d'une URL CDP : identifiants et valeurs de la requête (jeton) enregistrés ; jamais journalisée. */
function maskUrlSecrets(url: URL): void {
  for (const value of [url.username, url.password, ...url.searchParams.values()]) if (value.length >= 8) secretValues.add(value);
}

/** Fournisseur `cdp` : activation exacte (`true`), liste fermée des paramètres, durée bornée, adaptateur connu. */
function createCdp(env: Env, url: URL, fetchFn: typeof fetch, workerId: string): BrowserProvider {
  for (const name of Object.keys(env)) {
    if (name.startsWith('BROWSER_CDP_') && !CDP_VARIABLES.has(name)) throw new BrowserProviderError(`${name} : paramètre inconnu. Paramètres acceptés : ${[...CDP_VARIABLES].filter((n) => !n.endsWith('_FILE')).join(', ')}.`);
  }
  const accountProxyRaw = env['BROWSER_CDP_ACCOUNT_PROXY'];
  if (accountProxyRaw !== undefined && accountProxyRaw !== '' && accountProxyRaw !== 'true' && accountProxyRaw !== 'false') throw new BrowserProviderError('BROWSER_CDP_ACCOUNT_PROXY invalide : true ou false attendu.');
  const timeoutRaw = env['BROWSER_CDP_SESSION_TIMEOUT_SECONDS'];
  const timeoutSeconds = timeoutRaw === undefined || timeoutRaw === '' ? CDP_TIMEOUT_DEFAULT_SECONDS : Number(timeoutRaw);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < CDP_TIMEOUT_MIN_SECONDS || timeoutSeconds > CDP_TIMEOUT_MAX_SECONDS) {
    throw new BrowserProviderError(`BROWSER_CDP_SESSION_TIMEOUT_SECONDS invalide : entier de ${CDP_TIMEOUT_MIN_SECONDS} à ${CDP_TIMEOUT_MAX_SECONDS} attendu.`);
  }
  const adapterName = env['BROWSER_CDP_ADAPTER'];
  let mode: CdpMode;
  if (adapterName !== undefined && adapterName !== '') {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowserProviderError('BROWSER_URL invalide avec BROWSER_CDP_ADAPTER : adresse http(s) de l’API du fournisseur attendue.');
    const key = secretEnv(env, 'BROWSER_API_KEY');
    if (key === undefined) throw new BrowserProviderError('BROWSER_API_KEY (ou BROWSER_API_KEY_FILE) est requise avec BROWSER_CDP_ADAPTER : clé d’API du fournisseur.');
    const projectId = secretEnv(env, 'BROWSER_CDP_PROJECT_ID');
    const base = { apiKey: key, fetch: fetchFn, baseUrl: url.origin };
    let adapter: CdpSessionAdapter;
    if (adapterName === 'browserbase') adapter = browserbaseAdapter({ ...base, ...(projectId === undefined ? {} : { projectId }) });
    else if (adapterName === 'steel') adapter = steelAdapter(base);
    else throw new BrowserProviderError('BROWSER_CDP_ADAPTER invalide : browserbase ou steel attendu.');
    mode = { kind: 'adapter', adapter, timeoutSeconds, accountProxy: accountProxyRaw === 'true' };
  } else {
    maskUrlSecrets(url);
    const token = secretEnv(env, 'BROWSER_API_KEY');
    mode = { kind: 'url', url: url.href, ...(token === undefined ? {} : { token }) };
  }
  return createCdpProvider({ mode, workerId });
}

type Probe = { kind: 'sym-browser'; playwright: string } | { kind: 'other' } | { kind: 'unreachable' };

/** `GET /v1/version` sans clé : SYM Browser, autre service, ou pas de réponse. */
async function probe(url: URL, fetchFn: typeof fetch): Promise<Probe> {
  let response: Response;
  try {
    response = await fetchFn(new URL('/v1/version', url), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return { kind: 'unreachable' };
  }
  if (response.status >= 500) return { kind: 'unreachable' };
  try {
    const body = (await response.json()) as { product?: unknown; playwright?: unknown };
    return body.product === 'sym-browser' && typeof body.playwright === 'string' ? { kind: 'sym-browser', playwright: body.playwright } : { kind: 'other' };
  } catch {
    return { kind: 'other' };
  }
}

export async function detectProvider(env: Env, fetchFn: typeof fetch, deps: DetectDeps): Promise<BrowserProvider> {
  const raw = env['BROWSER_URL'];
  if (raw === undefined || raw.trim() === '') return deps.createLocal();
  const url = normalizeBrowserUrl(raw);
  const allowGenericCdp = env['BROWSER_ALLOW_GENERIC_CDP'] === 'true';
  const workerId = deps.workerId ?? `${hostname()}-${process.pid}`;
  const adapter = env['BROWSER_CDP_ADAPTER'];
  if (adapter !== undefined && adapter !== '') {
    if (!allowGenericCdp) throw genericCdpRefused('BROWSER_CDP_ADAPTER est posée.');
    return createCdp(env, url, fetchFn, workerId);
  }
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    if (!allowGenericCdp) throw genericCdpRefused('BROWSER_URL est une adresse CDP (ws/wss).');
    return createCdp(env, url, fetchFn, workerId);
  }
  // Lue (et conflit refusé) avant la détection ; requise seulement pour SYM Browser, facultative comme jeton d'un CDP générique.
  const configuredKey = secretEnv(env, 'BROWSER_API_KEY');
  const found = await probe(url, fetchFn);
  if (found.kind === 'other') {
    if (!allowGenericCdp) throw genericCdpRefused('BROWSER_URL ne répond pas comme SYM Browser (GET /v1/version).');
    return createCdp(env, url, fetchFn, workerId);
  }
  const key = requireApiKey(configuredKey);
  const playwrightVersion = deps.playwrightVersion ?? (createRequire(import.meta.url)('playwright-core/package.json') as { version: string }).version;
  if (found.kind === 'sym-browser') checkVersion({ product: 'sym-browser', playwright: found.playwright }, playwrightVersion);
  const origin = url.origin;
  const client = deps.createClient?.({ url: origin, apiKey: key, fetch: fetchFn }) ?? new SymBrowser({ url: origin, apiKey: key, fetch: fetchFn, releaseOnExit: false });
  return createSymBrowserProvider({
    url,
    client,
    workerId,
    playwrightVersion,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
}
