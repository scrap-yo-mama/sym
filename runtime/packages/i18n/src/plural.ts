// SPDX-License-Identifier: AGPL-3.0-only
// Pluriels : règle dérivée d'`Intl.PluralRules` pour toute langue (ajouter une langue ne touche à aucun code, M14).
// Messages à deux formes (`un | plusieurs`) : la première pour la catégorie CLDR `one` (en : 1 ; fr : 0 et 1), la seconde
// sinon. Messages à trois formes (`aucun | un | plusieurs`) : zéro, `one`, autres. Format de choix de vue-i18n 11.

/** Indice de la forme à servir (convention de `pluralRules` de vue-i18n : choice, nombre de formes). */
export function pluralRule(locale: string): (choice: number, choicesLength: number) => number {
  let rules: Intl.PluralRules;
  try {
    rules = new Intl.PluralRules(locale);
  } catch {
    rules = new Intl.PluralRules('en');
  }
  return (choice, choicesLength) => {
    const one = rules.select(Math.abs(choice)) === 'one';
    if (choicesLength === 3) return choice === 0 ? 0 : one ? 1 : 2;
    if (choicesLength === 2) return one ? 0 : 1;
    // Une seule forme, ou plus de trois : l'indice le plus proche de la catégorie.
    return Math.min(one ? 0 : 1, Math.max(0, choicesLength - 1));
  };
}

/** `pluralRules` pour `createI18n` : une règle par code du registre. */
export function pluralRulesFor(locales: readonly string[]): Record<string, (choice: number, choicesLength: number) => number> {
  return Object.fromEntries(locales.map((code) => [code, pluralRule(code)]));
}
