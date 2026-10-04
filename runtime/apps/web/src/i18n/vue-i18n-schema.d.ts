// SPDX-License-Identifier: AGPL-3.0-only
// Schéma global des messages de la console (vue-i18n 11, « Global resource schema type definition ») : `en.json` de
// `packages/i18n` est la source (21b § 2). Il donne la complétion des clés ; vue-i18n accepte toutefois toute chaîne dans `t()`
// (clés calculées comme `reason.${code}`) : le refus d'une clé littérale inexistante est porté par ESLint
// (`@intlify/vue-i18n/no-missing-keys`, bloquant) et, à l'exécution, par le gestionnaire `missing` qui lève en DEV et en E2E.
import type en from '@runtime/i18n/locales/en.json';

type MessageSchema = typeof en;

declare module 'vue-i18n' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefineLocaleMessage extends MessageSchema {}
}
