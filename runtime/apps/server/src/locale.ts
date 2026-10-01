// SPDX-License-Identifier: AGPL-3.0-only
// Langue du premier compte (06 § 1 : langues `en` et `fr`, `users.locale` ; U2 06-i18n : à défaut de préférence, la langue
// du navigateur). L'assistant de premier démarrage lit `Accept-Language` pour que l'owner ne tombe pas sur `en` par défaut
// alors que son navigateur est en français : une valeur `users.locale` posée par défaut l'emporterait sur le navigateur
// à chaque connexion.

const SUPPORTED = ['en', 'fr'] as const;
export type UserLocale = (typeof SUPPORTED)[number];

/** Première langue gérée de l'en-tête `Accept-Language` (par poids décroissant), sinon `en`. */
export function localeFromAcceptLanguage(header: string | undefined): UserLocale {
  if (!header) return 'en';
  const candidates = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p)?.[1]).find((v) => v !== undefined);
      const weight = q === undefined ? 1 : Number(q);
      return { base: tag.trim().toLowerCase().split(/[-_]/)[0] ?? '', weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const match = candidates.find((c) => (SUPPORTED as readonly string[]).includes(c.base));
  return (match?.base as UserLocale | undefined) ?? 'en';
}
