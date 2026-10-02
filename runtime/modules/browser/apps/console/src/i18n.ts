// SPDX-License-Identifier: AGPL-3.0-only
// vue-i18n 11 (API Composition), langues `fr` et `en` (cdc/sym-browser 04d § 5.1). Français au tutoiement. `en` fait foi
// pour la forme des messages ; la parité des clés est testée.
import { createI18n } from 'vue-i18n';

export const LOCALES = ['fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

const en = {
  app: {
    title: 'SYM Browser',
    soon: 'The console is on its way. You will follow your sessions, their network egress and their usage here.',
  },
};

type MessageSchema = typeof en;

const fr: MessageSchema = {
  app: {
    title: 'SYM Browser',
    soon: 'La console arrive bientôt. Tu y suivras tes sessions, leur sortie réseau et leur consommation.',
  },
};

export const messages: Record<Locale, MessageSchema> = { fr, en };

export function normalizeLocale(value: string | undefined): Locale {
  return value?.toLowerCase().startsWith('fr') === true ? 'fr' : 'en';
}

export function createConsoleI18n(locale: Locale) {
  return createI18n<[MessageSchema], Locale, false>({ legacy: false, locale, fallbackLocale: 'en', messages });
}
