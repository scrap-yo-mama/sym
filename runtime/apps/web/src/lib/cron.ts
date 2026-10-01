// SPDX-License-Identifier: AGPL-3.0-only
// Aide à la saisie d'une expression cron (06 § 2, Planifications) : la phrase vient de `cronstrue`, chargée à la demande
// (le paquet de langues pèse lourd et seul l'onglet Planifications s'en sert). Les prochaines exécutions, elles, sont
// calculées côté serveur (06 § 1) : aucun composant cron dans la console.

/** Phrase lisible d'une expression cron à 5 champs, ou null quand l'expression est invalide. */
export async function describeCron(expression: string, locale: string): Promise<string | null> {
  const trimmed = expression.trim();
  if (trimmed === '') return null;
  const { default: cronstrue } = await import('cronstrue/i18n');
  try {
    return cronstrue.toString(trimmed, { locale, use24HourTimeFormat: true, throwExceptionOnParseError: true });
  } catch {
    return null;
  }
}
