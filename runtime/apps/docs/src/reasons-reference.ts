// SPDX-License-Identifier: AGPL-3.0-only
// Référence des codes de raison : produite depuis les textes français de la console (apps/web/src/i18n/locales/fr.json) et la
// liste figée de 06 § 4.2 (apps/web/src/testing/spec-reason-codes.json). La doc n'a donc pas sa propre copie des phrases :
// ce que la console affiche est ce que la doc publie.
import { plain } from './rest-reference.ts';

type Messages = {
  reasons: Record<string, string>;
  reasonLabel: Record<string, string>;
  failureClass: Record<string, string>;
};

export function renderReasonsReference(fr: Messages, specCodes: readonly string[]): string {
  const all = Object.keys(fr.reasons);
  const spec = specCodes.filter((c) => c in fr.reasons);
  const extras = all.filter((c) => !specCodes.includes(c));
  const row = (code: string): string => `| \`${code}\` | ${plain(fr.reasonLabel[code] ?? '—')} | ${plain(fr.reasons[code])} |`;
  const lines = [
    '---',
    'title: Codes de raison',
    '---',
    '',
    '# Codes de raison',
    '',
    '<!-- Page générée par scripts/gen-reference.ts depuis les textes de la console : ne pas la modifier à la main. -->',
    '',
    'Le statut d\'une API s\'accompagne toujours d\'un **code de raison stable** : jamais une phrase traduite. La console et le serveur MCP traduisent ce code en texte ; un script peut s\'appuyer sur le code sans risquer qu\'une reformulation le casse. Les accolades des textes (`{n}`, `{domain}`) sont des valeurs remplies à l\'affichage.',
    '',
    '## Codes de la table de référence',
    '',
    '| Code | Libellé court | Texte affiché |',
    '|---|---|---|',
    ...spec.map(row),
    '',
    '## Codes complémentaires',
    '',
    'Ces codes accompagnent l\'état courant d\'une API (enquête en cours, réparation, prérequis manquant) plutôt qu\'un événement.',
    '',
    '| Code | Libellé court | Texte affiché |',
    '|---|---|---|',
    ...extras.map(row),
    '',
    '## Classes d\'échec',
    '',
    'Chaque essai et chaque run porte aussi une `failure_class`, le résultat du classifieur d\'échec. Les classes d\'erreur du modèle IA s\'écrivent `llm_` suivi du motif. La page [Statuts et classes d\'échec](./statuts-et-raisons.md) explique ce que chaque classe déclenche.',
    '',
    '| Classe | Texte affiché |',
    '|---|---|',
    ...Object.entries(fr.failureClass).map(([code, text]) => `| \`${code}\` | ${plain(text)} |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}
