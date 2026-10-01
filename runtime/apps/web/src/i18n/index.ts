// SPDX-License-Identifier: AGPL-3.0-only
// vue-i18n 11 (API Composition, `legacy: false`), langues `en` et `fr` (`users.locale`), chargement paresseux : seul le
// fichier de la langue active (plus `en`, langue de repli) est téléchargé. L'API renvoie des codes stables, jamais des
// phrases : l'interface les traduit (06 § 1, § 4.2). Pluriels : syntaxe native de vue-i18n (`un | plusieurs`), ADR 0002.
import { createI18n, type Composer, type I18n } from 'vue-i18n';
import type enMessages from './locales/en.json';

export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];
const FALLBACK_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'runtime.locale';

/** Forme des messages : `en.json` fait foi (la parité `fr`/`en` est testée). */
type MessageSchema = typeof enMessages;

const loaders: Record<Locale, () => Promise<{ default: MessageSchema }>> = {
  en: () => import('./locales/en.json'),
  fr: () => import('./locales/fr.json'),
};

export type AppI18n = I18n<{ [K in Locale]: MessageSchema }, Record<string, never>, Record<string, never>, Locale, false>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** `fr-CA` → `fr` ; toute langue non gérée → `en`. */
export function normalizeLocale(value: string | null | undefined): Locale {
  const base = value?.toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : FALLBACK_LOCALE;
}

/** Langue initiale : choix mémorisé, sinon langue du navigateur, sinon `en` (la préférence du compte la remplace après connexion). */
export function detectLocale(stored: string | null, navigatorLanguage: string | undefined): Locale {
  return isLocale(stored) ? stored : normalizeLocale(navigatorLanguage);
}

/**
 * Pluriel du français (CLDR : 0 et 1 sont au singulier) pour les messages à deux formes `un | plusieurs`. Les messages
 * à trois formes (`aucun | un | plusieurs`) gardent la règle par défaut de vue-i18n.
 */
export function frenchPlural(choice: number, choicesLength: number): number {
  if (choicesLength !== 2) return choice === 0 ? 0 : choice === 1 ? 1 : 2;
  return choice === 0 || choice === 1 ? 0 : 1;
}

export function createAppI18n(): AppI18n {
  return createI18n({
    legacy: false,
    pluralRules: { fr: frenchPlural },
    locale: FALLBACK_LOCALE,
    fallbackLocale: FALLBACK_LOCALE,
    messages: {} as { [K in Locale]: MessageSchema },
  });
}

/** Partie du composeur vue-i18n dont `setLocale` a besoin (`i18n.global` ou `useI18n()`). */
export type LocaleTarget = Pick<Composer, 'locale' | 'availableLocales' | 'setLocaleMessage'>;

/** Charge (si besoin) puis active une langue ; met à jour l'attribut `lang` de <html>. */
export async function setLocale(target: LocaleTarget, locale: Locale, root: HTMLElement = document.documentElement): Promise<void> {
  for (const needed of new Set<Locale>([FALLBACK_LOCALE, locale])) {
    if (!target.availableLocales.includes(needed)) target.setLocaleMessage(needed, (await loaders[needed]()).default);
  }
  target.locale.value = locale;
  root.lang = locale;
}
