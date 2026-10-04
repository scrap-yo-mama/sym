// SPDX-License-Identifier: AGPL-3.0-only
// Résolution de la langue (21 § 3, 21b § 2) : fonction pure, testée par tableau (`assert_locale_resolution_order`).
// La langue du compte gagne ; `Accept-Language` ne sert qu'à initialiser une valeur stockée (premier démarrage, pages
// avant connexion) ; à défaut, `en`. L'en-tête brut n'est JAMAIS rendu en sortie (vecteur d'empreinte) : seules la langue
// résolue et sa source sortent d'ici, et seules elles peuvent être journalisées.
import { SOURCE_LOCALE } from './registry.js';

export type Surface = 'console' | 'prelogin' | 'extension' | 'mcp' | 'rest' | 'email_invite' | 'email_user' | 'reader' | 'llm';
export type Source = 'explicit_url' | 'request' | 'user' | 'cookie' | 'browser' | 'invitation' | 'run' | 'instance' | 'default';

export interface ResolveInput {
  surface: Surface;
  /** `?lang=` de l'adresse du connecteur (MCP). */
  urlHint?: string | undefined;
  /** `Accept-Language` (REST, pages avant connexion) ; `_meta` `acceptLanguage` du MCP en V1.1. */
  request?: string | undefined;
  /** `users.locale`. */
  user?: string | null | undefined;
  /** Cookie `sym_locale`. */
  cookie?: string | undefined;
  /** `chrome.i18n.getUILanguage()` (extension). */
  browser?: string | undefined;
  /** `invitations.locale`. */
  invitation?: string | undefined;
  /** `runs.locale`. */
  run?: string | undefined;
  /** `settings.default_locale`. */
  instance?: string | undefined;
}

/** Ordre de consultation par surface (tableau de 21 § 3) ; `default` (`en`) termine toujours la chaîne. */
const ORDER: Readonly<Record<Surface, readonly Exclude<Source, 'default'>[]>> = {
  console: ['user', 'instance'],
  prelogin: ['cookie', 'request', 'instance'],
  // Extension appairée : langue du compte ; non appairée (pas de `user`) : langue du navigateur.
  extension: ['user', 'browser'],
  // MCP V1 : `?lang=` puis compte du propriétaire de la clé ; `acceptLanguage` (SEP-2792) arrive en V1.1.
  mcp: ['explicit_url', 'user', 'instance'],
  rest: ['request', 'user', 'instance'],
  email_invite: ['invitation', 'instance'],
  email_user: ['user', 'instance'],
  reader: ['user'],
  llm: ['run'],
};

const FIELD: Readonly<Record<Exclude<Source, 'default'>, keyof ResolveInput>> = {
  explicit_url: 'urlHint',
  request: 'request',
  user: 'user',
  cookie: 'cookie',
  browser: 'browser',
  invitation: 'invitation',
  run: 'run',
  instance: 'instance',
};

type Range = { tag: string; weight: number; index: number };

/** Plages de langues d'un `Accept-Language` (ou d'une étiquette seule), par poids décroissant ; `*` et q=0 écartés. */
export function parseLanguageRanges(header: string | null | undefined): string[] {
  if (typeof header !== 'string' || header.length === 0 || header.length > 1024) return [];
  const ranges: Range[] = [];
  header.split(',').forEach((part, index) => {
    const [rawTag = '', ...params] = part.trim().split(';');
    const tag = rawTag.trim().toLowerCase().replace(/_/g, '-');
    if (tag === '' || tag === '*' || !/^[a-z]{1,8}(-[a-z0-9]{1,8})*$/.test(tag)) return;
    const q = params.map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p)?.[1]).find((v) => v !== undefined);
    const weight = q === undefined ? 1 : Number(q);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) return;
    ranges.push({ tag, weight, index });
  });
  return ranges.sort((a, b) => b.weight - a.weight || a.index - b.index).map((r) => r.tag);
}

/**
 * Meilleure langue gérée pour une plage : étiquette exacte, sinon langue de base (`fr-CA` → `fr`, variantes régionales
 * repliées, 21 § 1). Renvoie `undefined` si rien ne correspond.
 */
export function matchLocale(header: string | null | undefined, supported: readonly string[]): string | undefined {
  const set = new Map(supported.map((code) => [code.toLowerCase(), code]));
  for (const tag of parseLanguageRanges(header)) {
    const exact = set.get(tag);
    if (exact !== undefined) return exact;
    const base = set.get(tag.split('-')[0] ?? '');
    if (base !== undefined) return base;
  }
  return undefined;
}

/**
 * Langue et source pour une surface. `supported` = codes `shipped` du registre ; la sortie est toujours l'un d'eux (sinon
 * `en`). Une valeur stockée devenue non gérée (langue retirée du registre) est sautée : repli sur la source suivante,
 * la valeur stockée étant conservée par l'appelant (21 § 3, cas limites).
 */
export function resolveLocale(input: ResolveInput, supported: readonly string[]): { locale: string; source: Source } {
  for (const source of ORDER[input.surface]) {
    const raw = input[FIELD[source]];
    if (typeof raw !== 'string' || raw === '') continue;
    const locale = matchLocale(raw, supported);
    if (locale !== undefined) return { locale, source };
  }
  return { locale: supported.includes(SOURCE_LOCALE) ? SOURCE_LOCALE : (supported[0] ?? SOURCE_LOCALE), source: 'default' };
}
