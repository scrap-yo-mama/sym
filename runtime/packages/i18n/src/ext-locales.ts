// SPDX-License-Identifier: AGPL-3.0-only
// `_locales/<code>/messages.json` de l'extension (21 § 4.2, voie hybride) : générés depuis les clés `ext.manifest.*` (nom,
// description, titre d'action, libellés des raccourcis). Ces textes suivent la langue du NAVIGATEUR (limite de `chrome.i18n`) ;
// le reste de l'interface suit le compte appairé. Le branchement au build et la fiche du Store relèvent de la tâche 3.18.
import { flatten, type Catalog } from './catalog.js';
import { SOURCE_LOCALE, shippedCodes, type Registry } from './registry.js';

export type ChromeMessages = Record<string, { message: string }>;

const PREFIX = 'ext.manifest.';

/** Nom de message `chrome.i18n` d'une clé du catalogue (`ext.manifest.name` → `ext_manifest_name`). */
export function chromeMessageName(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, '_');
}

/** `messages.json` de chaque langue livrée ; une clé absente d'une langue retombe sur `en` (le dossier doit être complet). */
export function buildExtensionLocales(catalogs: Readonly<Record<string, Catalog>>, registry: Registry): Record<string, ChromeMessages> {
  const english = flatten(catalogs[SOURCE_LOCALE] ?? {});
  const keys = [...english.keys()].filter((k) => k.startsWith(PREFIX));
  const out: Record<string, ChromeMessages> = {};
  for (const code of shippedCodes(registry)) {
    const own = flatten(catalogs[code] ?? {});
    out[code] = Object.fromEntries(keys.map((key) => [chromeMessageName(key), { message: own.get(key) ?? english.get(key) ?? '' }]));
  }
  return out;
}
