// SPDX-License-Identifier: AGPL-3.0-only
// Langue de la console côté navigateur (04d § 5.1) : choix mémorisé dans localStorage, attribut `lang` de <html> tenu à
// jour (WCAG 3.1.1). Sans navigateur (rendu serveur, tests) : seule la langue de vue-i18n change.
import type { WritableComputedRef, Ref } from 'vue';
import { LOCALE_STORAGE_KEY, type Locale } from './i18n.js';

export function readStoredLocale(): string | null {
  try {
    return globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function applyLocale(target: Ref<string> | WritableComputedRef<string>, locale: Locale): void {
  target.value = locale;
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Stockage refusé (navigation privée stricte) : la langue vaut pour la page ouverte seulement.
  }
}
