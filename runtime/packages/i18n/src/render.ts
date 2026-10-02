// SPDX-License-Identifier: AGPL-3.0-only
// Rendu d'un code et de ses paramètres dans une langue (`render`, 21b § 2). Même syntaxe de messages que la console
// (vue-i18n 11) : `@intlify/core-base` côté serveur (u6 R3). Code inconnu : texte générique localisé qui cite le code,
// jamais la clé brute. Repli chaîne par chaîne sur `en` ; `narrative.light.*` est omis, jamais remplacé (21 § 2).
import { compile, createCoreContext, fallbackWithLocaleChain, resolveValue, translate, type CoreContext } from '@intlify/core-base';
import { flatten, GHOST, type Catalog } from './catalog.js';
import { pluralRule } from './plural.js';
import { SOURCE_LOCALE, type Registry } from './registry.js';
import type { MessageKey } from '../keys.d.ts';

export type Params = Readonly<Record<string, unknown>>;

/**
 * Clé vérifiée au typecheck (21b § 2, `keys.d.ts` généré par `i18n:types`) : une clé LITTÉRALE doit exister dans `en.json`, sinon
 * `tsc` échoue ; une clé calculée (`string`, gabarit `narrative.${string}` : code d'événement lu en base) reste permise, le texte
 * générique d'un code inconnu la couvre à l'exécution.
 */
export type CheckedKey<K extends string> = K extends MessageKey ? K : Record<never, never> extends Record<K, 1> ? K : MessageKey;

export interface Renderer {
  /** Message rendu ; clé absente dans la langue → repli sur `en` ; clé absente partout → texte générique citant la clé. */
  render<K extends string>(key: K & CheckedKey<K>, params: Params, locale: string): string;
  /** Message rendu ou `null` si la clé manque dans la langue (clés en omission, jamais de repli sur l'anglais). */
  renderOptional<K extends string>(key: K & CheckedKey<K>, params: Params, locale: string): string | null;
  /** La clé existe-t-elle dans cette langue (sans repli) ? */
  has(key: string, locale: string): boolean;
  /** Langues chargées. */
  readonly locales: readonly string[];
}

/**
 * Signature de SYM sur les surfaces texte (MCP, CLI, M12) : `{sym}` dans un message devient la valeur de cette clé, rendue avec le
 * fantôme (U+1F47B, fourni par le code, jamais présent dans un catalogue) : « SYM 👻 : » en `fr`, « SYM 👻: » en `en`. La ponctuation
 * est une donnée de chaque catalogue (une 3e langue l'apporte par fichier). La console et l'extension passent leur propre `sym`
 * (composant SymSignature de packages/ui, SVG `aria-hidden`).
 */
export const SYM_SIGNATURE_KEY = 'mcp.user.sym_signature';

/** Clé du texte générique d'un code inconnu (serveur plus récent que le client, code retiré, faute de frappe). */
export const UNKNOWN_CODE_KEY = 'srv.unknown_code';

function quietly<T>(fn: () => T): T {
  // `@intlify/core-base` signale l'usage d'un compilateur personnalisé (fonction expérimentale) dans les versions de développement.
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[intlify]')) return;
    original(...args);
  };
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

/** Nombre qui choisit la forme de pluriel : `n`, sinon `count`. */
function pluralOf(params: Params): number | undefined {
  for (const name of ['n', 'count']) {
    const value = params[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function createRenderer(catalogs: Readonly<Record<string, Catalog>>, registry: Registry): Renderer {
  const flat = new Map<string, Map<string, string>>();
  for (const [code, tree] of Object.entries(catalogs)) flat.set(code, flatten(tree));
  const contexts = new Map<string, CoreContext>();
  const messages = Object.fromEntries(Object.entries(catalogs)) as Record<string, Catalog>;
  const omit = (key: string): boolean => Object.keys(registry.fallback).some((ns) => key.startsWith(`${ns}.`));

  function contextFor(locale: string): CoreContext {
    let ctx = contexts.get(locale);
    if (!ctx) {
      ctx = quietly(() =>
        createCoreContext({
          locale,
          fallbackLocale: SOURCE_LOCALE,
          messages: messages as never,
          messageCompiler: compile,
          messageResolver: resolveValue,
          localeFallbacker: fallbackWithLocaleChain,
          missingWarn: false,
          fallbackWarn: false,
          warnHtmlMessage: false,
          pluralRules: { [locale]: pluralRule(locale), [SOURCE_LOCALE]: pluralRule(SOURCE_LOCALE) },
        }),
      );
      contexts.set(locale, ctx);
    }
    return ctx;
  }

  const has = (key: string, locale: string): boolean => flat.get(locale)?.has(key) === true;
  const message = (key: string, locale: string): string => flat.get(locale)?.get(key) ?? flat.get(SOURCE_LOCALE)?.get(key) ?? '';
  /** `{sym}` des surfaces texte : la signature de la langue, ou `SYM 👻:` si aucun catalogue ne la porte. */
  const signature = (locale: string): string =>
    has(SYM_SIGNATURE_KEY, locale) || has(SYM_SIGNATURE_KEY, SOURCE_LOCALE) ? run(SYM_SIGNATURE_KEY, {}, locale) : `SYM ${GHOST}:`;

  function run(key: string, params: Params, locale: string): string {
    const plural = pluralOf(params);
    const named: Record<string, string | number> = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' || typeof v === 'number' ? v : v === null || v === undefined ? '' : String(v)]));
    if (!('sym' in params) && key !== SYM_SIGNATURE_KEY && message(key, locale).includes('{sym}')) named['sym'] = signature(locale);
    if (key === SYM_SIGNATURE_KEY && !('ghost' in params)) named['ghost'] = GHOST;
    const options = { locale, ...(plural === undefined ? {} : { plural }) };
    const out = quietly(() => translate(contextFor(locale), key, named, options));
    return typeof out === 'string' ? out : String(out);
  }

  return {
    locales: Object.keys(catalogs),
    has,
    render(key, params, locale) {
      const known = has(key, locale) || has(key, SOURCE_LOCALE);
      if (!known) return has(UNKNOWN_CODE_KEY, SOURCE_LOCALE) ? run(UNKNOWN_CODE_KEY, { code: key }, has(UNKNOWN_CODE_KEY, locale) ? locale : SOURCE_LOCALE) : `(${key})`;
      return run(key, params, flat.has(locale) ? locale : SOURCE_LOCALE);
    },
    renderOptional(key, params, locale) {
      if (omit(key) ? !has(key, locale) : !has(key, locale) && !has(key, SOURCE_LOCALE)) return null;
      return run(key, params, flat.has(locale) ? locale : SOURCE_LOCALE);
    },
  };
}
