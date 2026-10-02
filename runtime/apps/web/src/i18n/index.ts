// SPDX-License-Identifier: AGPL-3.0-only
// vue-i18n 11 (API Composition, `legacy: false`), chargement paresseux d'une langue à la fois. Les catalogues vivent dans
// `packages/i18n` (tâche 3.20) : la liste des langues est `registry.json` (seules les langues `shipped` entrent dans le sélecteur)
// et les fichiers sont trouvés par `import.meta.glob`, si bien qu'ajouter une langue ne touche à aucun code (M14). L'API renvoie
// des codes stables, jamais des phrases : l'interface les traduit (06 § 1, § 4.2). Pluriels : règle d'`Intl.PluralRules` par
// langue, syntaxe native de vue-i18n (`un | plusieurs`), ADR 0002.
import registryJson from '@runtime/i18n/locales/registry.json';
import { PSEUDO_LOCALE, SOURCE_LOCALE, languageEntry, matchLocale, parseRegistry, pluralRulesFor, pseudoCatalog, shippedCodes } from '@runtime/i18n/browser';
import type enMessages from '@runtime/i18n/locales/en.json';
import { createI18n, type Composer, type I18n } from 'vue-i18n';

type MessageSchema = typeof enMessages;

const REGISTRY = parseRegistry(registryJson);
/** Langues du sélecteur (`shipped`), `en` d'abord. */
const LOCALES: readonly string[] = shippedCodes(REGISTRY);
export type Locale = string;
const FALLBACK_LOCALE: Locale = SOURCE_LOCALE;
export const LOCALE_STORAGE_KEY = 'runtime.locale';

/** Sélecteur de langue : code et nom de la langue dans sa propre langue (il ne se traduit pas). */
export const LANGUAGE_CHOICES: readonly { code: string; endonym: string }[] = LOCALES.map((code) => ({ code, endonym: languageEntry(REGISTRY, code)?.endonym ?? code }));

const files = import.meta.glob(['../../../../packages/i18n/locales/*.json', '!../../../../packages/i18n/locales/registry.json']) as Record<string, () => Promise<{ default: MessageSchema }>>;
const loaders = new Map<string, () => Promise<{ default: MessageSchema }>>(
  Object.entries(files).map(([path, load]) => [/([^/]+)\.json$/.exec(path)?.[1] ?? '', load]),
);

/** Pseudo-locale `qps-ploc` (21 § 9) : développement et E2E seulement, générée depuis `en`, jamais livrée. */
const PSEUDO_ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_PSEUDO_LOCALE === 'true';

export type AppI18n = I18n<Record<string, MessageSchema>, Record<string, never>, Record<string, never>, string, false>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.includes(value);
}

/** `fr-CA` → `fr` ; toute langue non gérée → `en`. */
export function normalizeLocale(value: string | null | undefined): Locale {
  return matchLocale(value, LOCALES) ?? FALLBACK_LOCALE;
}

/** Langue initiale : choix mémorisé, sinon langue du navigateur, sinon `en` (la langue du compte la remplace après connexion). */
export function detectLocale(stored: string | null, navigatorLanguage: string | undefined): Locale {
  return isLocale(stored) ? stored : normalizeLocale(navigatorLanguage);
}

/**
 * Clé manquante (21b § 3) : en développement (`vite`, vitest) et en E2E (`VITE_I18N_STRICT=true` au build du banc), le gestionnaire
 * `missing` LÈVE : une clé absente ou mal écrite casse l'écran au lieu de passer inaperçue. En production, repli chaîne par chaîne
 * sur `en` et compteur local, aucune télémétrie (INV9). `te()` (codes dynamiques vérifiés avant affichage) ne le déclenche pas.
 */
const STRICT_MISSING: boolean = import.meta.env.DEV || import.meta.env.VITE_I18N_STRICT === 'true';

export class MissingMessageError extends Error {
  override name = 'MissingMessageError';
  readonly locale: string;
  readonly key: string;
  constructor(locale: string, key: string) {
    super(`clé de traduction absente : « ${key} » (${locale})`);
    this.locale = locale;
    this.key = key;
  }
}

let missingCount = 0;
/** Clés manquantes rencontrées dans ce navigateur depuis le chargement (compteur local, jamais envoyé). */
export function missingMessageCount(): number {
  return missingCount;
}

export function createAppI18n(options: { strictMissing?: boolean } = {}): AppI18n {
  const strict = options.strictMissing ?? STRICT_MISSING;
  return createI18n({
    legacy: false,
    pluralRules: pluralRulesFor([...LOCALES, PSEUDO_LOCALE]),
    locale: FALLBACK_LOCALE,
    fallbackLocale: FALLBACK_LOCALE,
    messages: {} as Record<string, MessageSchema>,
    missingWarn: false,
    fallbackWarn: false,
    missing: (locale: string, key: string): void => {
      missingCount += 1;
      if (strict) throw new MissingMessageError(locale, key);
    },
  });
}

/** Partie du composeur vue-i18n dont `setLocale` a besoin (`i18n.global` ou `useI18n()`). */
export type LocaleTarget = Pick<Composer, 'locale' | 'availableLocales' | 'setLocaleMessage'>;

async function load(code: string): Promise<MessageSchema> {
  if (code === PSEUDO_LOCALE) {
    if (!PSEUDO_ENABLED) throw new Error('pseudo-locale désactivée');
    return pseudoCatalog((await loaders.get(FALLBACK_LOCALE)!()).default) as MessageSchema;
  }
  const loader = loaders.get(code);
  if (!loader) throw new Error(`langue « ${code} » sans catalogue`);
  return (await loader()).default;
}

/** Charge (si besoin) puis active une langue ; met à jour `lang` et `dir` de <html>. */
export async function setLocale(target: LocaleTarget, locale: Locale, root: HTMLElement = document.documentElement): Promise<void> {
  for (const needed of new Set<Locale>([FALLBACK_LOCALE, locale])) {
    if (!target.availableLocales.includes(needed)) target.setLocaleMessage(needed, await load(needed));
  }
  target.locale.value = locale;
  root.lang = locale;
  root.dir = languageEntry(REGISTRY, locale)?.dir ?? 'ltr';
}
