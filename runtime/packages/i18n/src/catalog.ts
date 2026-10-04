// SPDX-License-Identifier: AGPL-3.0-only
// Catalogues (`locales/<code>.json`) : arbre de messages, clés à plat, espaces de noms (21b § 2) et contrôles de parité
// (`assert_i18n_key_parity_all_surfaces`, `assert_i18n_placeholders_match`, `assert_model_facing_namespace_untranslated`).
// Le catalogue de la console (tâche 3.9) garde ses clés d'origine : tout ce qui n'a pas un des préfixes ci-dessous est
// l'espace `web` (déplacé sans réécriture des clés, 10 § 3.20).
import { SOURCE_LOCALE, type Registry } from './registry.js';

export type CatalogTree = { readonly [key: string]: string | CatalogTree };
export type Catalog = CatalogTree;

/** Espaces de noms de 21b § 2 ; `web` regroupe les clés historiques de la console. */
export const NAMESPACES = ['web', 'reason', 'ext', 'srv', 'narrative', 'email', 'mcp.user', 'mcp.model'] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** Espace d'une clé à plat. `narrative.light.*` est reconnu à part (omission permise, 21 § 2). */
export function namespaceOf(key: string): Namespace | 'narrative.light' {
  if (key.startsWith('narrative.light.')) return 'narrative.light';
  if (key.startsWith('narrative.')) return 'narrative';
  if (key.startsWith('mcp.model.')) return 'mcp.model';
  if (key.startsWith('mcp.user.')) return 'mcp.user';
  if (key.startsWith('ext.')) return 'ext';
  if (key.startsWith('srv.')) return 'srv';
  if (key.startsWith('email.')) return 'email';
  if (/^(reasons|reasonLabel|reasonShort|reason)\./.test(key)) return 'reason';
  return 'web';
}

/** Arbre → clés à plat (`a.b.c` → message). */
export function flatten(tree: CatalogTree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') out.set(prefix + key, value);
    else for (const [k, v] of flatten(value, `${prefix}${key}.`)) out.set(k, v);
  }
  return out;
}

/** Variables nommées `{nom}` d'un message, triées (les littéraux `{'@'}` de vue-i18n ne sont pas des variables). */
export function placeholdersOf(message: string): string[] {
  return [...message.matchAll(/\{([A-Za-z_]\w*)\}/g)].map((m) => m[1] ?? '').sort();
}

/** Messages liés `@:clé` d'un message, triés. */
export function linksOf(message: string): string[] {
  return [...message.matchAll(/@(?:\.\w+)?:([\w.]+)/g)].map((m) => m[1] ?? '').sort();
}

/** Nombre de formes de pluriel (`un | plusieurs`). */
export function pluralFormsOf(message: string): number {
  return message.split(' | ').length;
}

export type ParityProblem = {
  readonly kind: 'missing_key' | 'extra_key' | 'placeholders' | 'plural_forms' | 'links' | 'empty' | 'model_facing_translated' | 'dangling_link' | 'ghost_character';
  readonly locale: string;
  readonly key: string;
  readonly detail?: string;
};

/** U+1F47B : aucun catalogue ne le contient ; `{sym}` en tient lieu (D-45, M12). */
export const GHOST = '\u{1F47B}';

/**
 * Parité de toutes les langues `shipped` contre `en` (M1) : mêmes clés, mêmes variables, mêmes formes de pluriel et messages
 * liés dans tous les espaces ; `narrative.light.*` peut être omis (jamais remplacé par l'anglais) ; `mcp.model.*` n'existe
 * qu'en `en` ; aucun message vide ; aucun U+1F47B.
 */
export function checkParity(catalogs: Readonly<Record<string, Catalog>>, registry: Registry, locales: readonly string[]): ParityProblem[] {
  const problems: ParityProblem[] = [];
  const source = catalogs[SOURCE_LOCALE];
  if (!source) return [{ kind: 'missing_key', locale: SOURCE_LOCALE, key: '*', detail: 'catalogue source `en` absent' }];
  const english = flatten(source);
  const nonTranslatable = (key: string): boolean => registry.non_translatable.some((ns) => key.startsWith(`${ns}.`));
  for (const [key, message] of english) {
    if (message.trim() === '') problems.push({ kind: 'empty', locale: SOURCE_LOCALE, key });
    if (message.includes(GHOST)) problems.push({ kind: 'ghost_character', locale: SOURCE_LOCALE, key });
    for (const target of linksOf(message)) if (!english.has(target)) problems.push({ kind: 'dangling_link', locale: SOURCE_LOCALE, key, detail: target });
  }
  for (const locale of locales) {
    if (locale === SOURCE_LOCALE) continue;
    const tree = catalogs[locale];
    if (!tree) {
      problems.push({ kind: 'missing_key', locale, key: '*', detail: `catalogue ${locale}.json absent` });
      continue;
    }
    const other = flatten(tree);
    for (const key of other.keys()) {
      if (nonTranslatable(key)) problems.push({ kind: 'model_facing_translated', locale, key });
      else if (!english.has(key)) problems.push({ kind: 'extra_key', locale, key });
    }
    for (const [key, message] of english) {
      if (nonTranslatable(key)) continue;
      const translated = other.get(key);
      if (translated === undefined) {
        if (namespaceOf(key) !== 'narrative.light') problems.push({ kind: 'missing_key', locale, key });
        continue;
      }
      if (translated.trim() === '') problems.push({ kind: 'empty', locale, key });
      if (translated.includes(GHOST)) problems.push({ kind: 'ghost_character', locale, key });
      if (placeholdersOf(translated).join() !== placeholdersOf(message).join()) problems.push({ kind: 'placeholders', locale, key, detail: `${placeholdersOf(message).join(',')} ≠ ${placeholdersOf(translated).join(',')}` });
      if (pluralFormsOf(translated) !== pluralFormsOf(message)) problems.push({ kind: 'plural_forms', locale, key });
      if (linksOf(translated).join() !== linksOf(message).join()) problems.push({ kind: 'links', locale, key });
    }
  }
  return problems;
}
