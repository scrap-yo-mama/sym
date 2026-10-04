// SPDX-License-Identifier: AGPL-3.0-only
// Détection du fournisseur de navigateur (tâche 4.2 ; cdc/sym-browser 04g §2 et §8) : une seule variable, `BROWSER_URL`
// (+ `BROWSER_API_KEY` ou `BROWSER_API_KEY_FILE`).
// - absente : `local` ;
// - présente : forme normalisée (`http://` ajouté sans schéma), puis `GET /v1/version` (sans clé) :
//   `product: "sym-browser"` => fournisseur `sym-browser` (Playwright de même majeure.mineure exigé) ; autre réponse, ou URL
//   `ws(s)://` => CDP générique, réservé à la tâche 4.7 (`BROWSER_ALLOW_GENERIC_CDP`) : arrêt qui nomme la variable ;
// - SYM Browser qui ne répond pas encore : le worker démarre quand même (fournisseur `sym-browser` dont l'ouverture des
//   sessions attend et réessaie, provider-sym-browser.ts).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import type { BrowserProvider } from '@sym/contracts/browser';
import { SymBrowser } from '@sym-browser/sdk';
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

/** `BROWSER_API_KEY` ou `BROWSER_API_KEY_FILE` (les deux posées : refus). Jamais reprise dans un message. */
function apiKey(env: Readonly<Record<string, string | undefined>>): string {
  const direct = env['BROWSER_API_KEY'];
  const file = env['BROWSER_API_KEY_FILE'];
  const hasDirect = direct !== undefined && direct !== '';
  const hasFile = file !== undefined && file !== '';
  if (hasDirect && hasFile) throw new BrowserProviderError("BROWSER_API_KEY et BROWSER_API_KEY_FILE sont posées toutes les deux : n'en gardez qu'une.");
  if (hasFile) {
    try {
      return readFileSync(file, 'utf8').replace(/\s+$/, '');
    } catch (error) {
      throw new BrowserProviderError(`BROWSER_API_KEY_FILE illisible : ${(error as NodeJS.ErrnoException).code ?? 'erreur'}.`);
    }
  }
  if (hasDirect) return direct;
  throw new BrowserProviderError('BROWSER_API_KEY (ou BROWSER_API_KEY_FILE) est requise avec BROWSER_URL : clé d’API de SYM Browser.');
}

const genericCdpRefused = (reason: string): BrowserProviderError =>
  new BrowserProviderError(`${reason} Un navigateur CDP générique exige BROWSER_ALLOW_GENERIC_CDP=true et son fournisseur n’est pas encore disponible dans cette version : utilisez SYM Browser, ou retirez BROWSER_URL pour le Chromium local.`);

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

export async function detectProvider(env: Readonly<Record<string, string | undefined>>, fetchFn: typeof fetch, deps: DetectDeps): Promise<BrowserProvider> {
  const raw = env['BROWSER_URL'];
  if (raw === undefined || raw.trim() === '') return deps.createLocal();
  const url = normalizeBrowserUrl(raw);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') throw genericCdpRefused('BROWSER_URL est une adresse CDP (ws/wss).');
  const key = apiKey(env);
  const playwrightVersion = deps.playwrightVersion ?? (createRequire(import.meta.url)('playwright-core/package.json') as { version: string }).version;
  const found = await probe(url, fetchFn);
  if (found.kind === 'other') throw genericCdpRefused('BROWSER_URL ne répond pas comme SYM Browser (GET /v1/version).');
  if (found.kind === 'sym-browser') checkVersion({ product: 'sym-browser', playwright: found.playwright }, playwrightVersion);
  const origin = url.origin;
  const client = deps.createClient?.({ url: origin, apiKey: key, fetch: fetchFn }) ?? new SymBrowser({ url: origin, apiKey: key, fetch: fetchFn, releaseOnExit: false });
  return createSymBrowserProvider({
    url,
    client,
    workerId: deps.workerId ?? `${hostname()}-${process.pid}`,
    playwrightVersion,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
}
