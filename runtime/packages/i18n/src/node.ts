// SPDX-License-Identifier: AGPL-3.0-only
// Chargement des catalogues depuis le disque (serveur, worker, scripts, tests) : `locales/registry.json` puis un
// `locales/<code>.json` par langue du registre. Le dossier est identique depuis src/ et dist/ ; `I18N_LOCALES_DIR` le
// remplace (essais d'une 3e langue par fichiers de données seulement, M14).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SOURCE_LOCALE, englishName, parseRegistry, shippedCodes, type Registry } from './registry.js';
import { createRenderer, type Params, type Renderer } from './render.js';
import type { Catalog } from './catalog.js';

export const DEFAULT_LOCALES_DIR = fileURLToPath(new URL('../locales/', import.meta.url));

export function localesDir(): string {
  const override = process.env.I18N_LOCALES_DIR;
  return override !== undefined && override !== '' ? (override.endsWith('/') ? override : `${override}/`) : DEFAULT_LOCALES_DIR;
}

const withSlash = (dir: string): string => (dir.endsWith('/') ? dir : `${dir}/`);

export function loadRegistry(dir: string = localesDir()): Registry {
  return parseRegistry(JSON.parse(readFileSync(`${withSlash(dir)}registry.json`, 'utf8')));
}

/** Catalogues de toutes les langues du registre (une langue sans fichier est omise : la parité la signale). */
export function loadCatalogs(registry: Registry, dir: string = localesDir()): Record<string, Catalog> {
  const out: Record<string, Catalog> = {};
  for (const { code } of registry.languages) {
    try {
      out[code] = JSON.parse(readFileSync(`${withSlash(dir)}${code}.json`, 'utf8')) as Catalog;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
  }
  return out;
}

export interface I18n {
  readonly registry: Registry;
  readonly catalogs: Readonly<Record<string, Catalog>>;
  readonly renderer: Renderer;
  /** Langues `shipped` (sélecteurs, `resolveLocale`). */
  readonly supported: readonly string[];
}

export function createI18n(dir: string = localesDir()): I18n {
  const registry = loadRegistry(dir);
  const catalogs = loadCatalogs(registry, dir);
  if (catalogs[SOURCE_LOCALE] === undefined) throw new Error(`catalogue ${SOURCE_LOCALE}.json introuvable dans ${dir}`);
  return { registry, catalogs, renderer: createRenderer(catalogs, registry), supported: shippedCodes(registry).filter((c) => catalogs[c] !== undefined) };
}

let shared: { dir: string; i18n: I18n } | null = null;

/** Instance partagée (cache par dossier). */
export function defaultI18n(): I18n {
  const dir = localesDir();
  if (shared === null || shared.dir !== dir) shared = { dir, i18n: createI18n(dir) };
  return shared.i18n;
}

export function supportedLocales(): readonly string[] {
  return defaultI18n().supported;
}

/** `render(code, params, locale)` de 21b § 2 sur les catalogues du paquet. Code inconnu : texte générique qui cite le code. */
export function render(code: string, params: Params, locale: string): string {
  return defaultI18n().renderer.render(code, params, locale);
}

export function languageNameEn(locale: string): string {
  return englishName(defaultI18n().registry, locale);
}
