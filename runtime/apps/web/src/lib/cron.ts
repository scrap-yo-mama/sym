// SPDX-License-Identifier: AGPL-3.0-only
import { describeCronLocalized } from '@runtime/i18n/browser';

// Aide à la saisie d'une expression cron (06 § 2, Planifications) : la phrase vient de `cronstrue` (via packages/i18n), chargée à la demande
// (le paquet de langues pèse lourd et seul l'onglet Planifications s'en sert). Les prochaines exécutions, elles, sont
// calculées côté serveur (06 § 1) : aucun composant cron dans la console.

/** Phrase lisible d'une expression cron à 5 champs, ou null quand l'expression est invalide. */
export async function describeCron(expression: string, locale: string): Promise<string | null> {
  // `cronstrue` localisé de packages/i18n : langue absente de `cronstrue` → phrase en anglais (repli signalé par le paquet).
  return (await describeCronLocalized(expression, locale))?.text ?? null;
}
