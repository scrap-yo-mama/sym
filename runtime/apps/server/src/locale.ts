// SPDX-License-Identifier: AGPL-3.0-only
// Langue du premier compte (06 § 1 : `users.locale` ; 21 § 3) : l'assistant de premier démarrage lit `Accept-Language` pour que
// l'owner ne tombe pas sur `en` alors que son navigateur est en français ; une valeur `users.locale` posée par défaut
// l'emporterait ensuite sur le navigateur à chaque connexion. La liste des langues est le registre de `@runtime/i18n`.
import { matchLocale } from '@runtime/i18n';
import { supportedLocales } from './i18n.js';

/** Meilleure langue gérée de l'en-tête `Accept-Language` (par poids décroissant), sinon `en`. */
export function localeFromAcceptLanguage(header: string | undefined): string {
  return matchLocale(header, supportedLocales()) ?? 'en';
}
