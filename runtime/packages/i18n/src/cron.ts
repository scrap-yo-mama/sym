// SPDX-License-Identifier: AGPL-3.0-only
// Description d'une expression cron par `cronstrue` localisé (21 § 5, M11 `assert_cron_description_locale`) : langues du
// paquet importées à la demande (il pèse lourd), 24 h dérivé de la langue, repli `en` signalé quand la langue n'existe pas
// dans `cronstrue` (la date de prochaine exécution, formatée par `Intl`, la complète alors, u6 R35). Les phrases de
// `cronstrue` sont une donnée tierce : hors parité et hors ton.

export interface CronDescription {
  /** Phrase lisible. */
  readonly text: string;
  /** Langue réellement rendue (`en` quand `cronstrue` n'a pas la langue demandée). */
  readonly locale: string;
  /** Vrai quand la langue demandée manque dans `cronstrue` : la phrase est en anglais. */
  readonly fallback: boolean;
}

/** Vrai si la langue affiche l'heure sur 24 h par défaut (dérivé de `Intl`, jamais d'une liste codée en dur). */
export function uses24Hour(locale: string): boolean {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 === false;
  } catch {
    return true;
  }
}

type CronLib = { toString(expression: string, options: Record<string, unknown>): string };

/** Phrase d'une expression à 5 champs, ou null si l'expression est invalide ou vide. */
export async function describeCronLocalized(expression: string, locale: string): Promise<CronDescription | null> {
  const trimmed = expression.trim();
  if (trimmed === '') return null;
  const loaded = (await import('cronstrue/i18n.js')) as unknown as { default?: CronLib } & CronLib;
  const cronstrue: CronLib = loaded.default ?? loaded;
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const text = cronstrue.toString(trimmed, { locale, use24HourTimeFormat: uses24Hour(locale), throwExceptionOnParseError: true });
    const fallback = warnings.some((w) => w.includes('could not be found'));
    return { text, locale: fallback ? 'en' : locale, fallback };
  } catch {
    return null;
  } finally {
    console.warn = original;
  }
}
