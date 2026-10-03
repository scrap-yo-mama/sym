// SPDX-License-Identifier: AGPL-3.0-only
// Outils de la documentation de SYM Browser (tâche 3.8), partagés par les tests et le générateur de référence : liste des
// pages (mêmes pages en fr et en en), blocs de code d'une page Markdown, texte hors code, extraction du quickstart.

export const DOC_LOCALES = ['fr', 'en'] as const;
export type DocLocale = (typeof DOC_LOCALES)[number];

/** Pages de chaque langue, dans l'ordre de lecture (docs/<langue>/…). */
export const DOC_PAGES = [
  'README.md',
  'quickstart.md',
  'sdk.md',
  'deployment.md',
  'nodes.md',
  'topologies.md',
  'clients/README.md',
  'clients/playwright.md',
  'clients/puppeteer.md',
  'clients/stagehand.md',
  'clients/browser-use.md',
  'clients/skyvern.md',
  'clients/playwright-mcp.md',
  'clients/chrome-devtools-mcp.md',
  'reference/api.md',
  'reference/configuration.md',
] as const;

export type CodeBlock = { info: string; code: string };

const FENCE = /^(`{3,})([^\n`]*)\n([\s\S]*?)\n\1[ \t]*$/gm;

/** Blocs de code délimités par ``` : chaîne d'information (`js quickstart`, `python`, `bash`…) et contenu. */
export function codeBlocks(markdown: string): CodeBlock[] {
  return [...markdown.matchAll(FENCE)].map((m) => ({ info: m[2]!.trim(), code: m[3]! }));
}

/** Texte hors blocs de code et hors commentaires HTML (relecture de la langue, liens, titres). */
export function proseOf(markdown: string): string {
  return markdown.replace(FENCE, '').replace(/<!--[\s\S]*?-->/g, '');
}

/** Info des blocs du quickstart : ils forment, dans l'ordre, un script ESM que la CI exécute tel quel. */
export const QUICKSTART_INFO = 'js quickstart';

/**
 * Code du quickstart : blocs `js quickstart` dans l'ordre, lignes de commentaire retirées (seuls les commentaires diffèrent
 * entre le français et l'anglais ; le code, donc ce qui s'exécute et s'affiche, est le même).
 */
export function extractQuickstart(markdown: string): { code: string; blocks: number } {
  const blocks = codeBlocks(markdown).filter((b) => b.info === QUICKSTART_INFO);
  const code = blocks
    .map((b) =>
      b.code
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n')
        .trim(),
    )
    .join('\n\n');
  return { code: `${code}\n`, blocks: blocks.length };
}
