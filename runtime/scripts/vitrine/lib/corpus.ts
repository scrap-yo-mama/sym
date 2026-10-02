// SPDX-License-Identifier: AGPL-3.0-only
// Preuves `assert_…` du registre des allégations : les titres des tests réels du monorepo (`test`, `it`, `describe`, y compris
// conditionnels), jamais un `test.todo`, un `test.skip`, un commentaire ni une chaîne quelconque, et jamais les tests de la
// vitrine eux-mêmes (tests/vitrine), qui citent ces noms dans leurs cas négatifs.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { runtimeDir } from './paths.ts';

const SKIP = new Set(['node_modules', 'dist', 'coverage', 'blob-report', 'test-results', '.git', '.wxt', '.output']);
const VITRINE_TESTS = `tests${sep}vitrine${sep}`;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (/\.test\.(ts|tsx|mts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Fichiers de test qui peuvent prouver une allégation (hors tests/vitrine). */
export const testCorpusFiles = (): string[] => testFiles(runtimeDir).filter((file) => !relative(runtimeDir, file).startsWith(VITRINE_TESTS));

/**
 * Titres des tests réels d'un fichier source : `describe(`, `test(`, `it(`, avec modificateurs (`.only`, `.concurrent`,
 * `.sequential`, `.skipIf(…)`, `.runIf(…)`, `.each(…)`, `.for(…)`). `.todo` et `.skip` ne comptent pas : un test non écrit ou
 * désactivé ne prouve rien.
 */
export function testTitles(source: string): string[] {
  const titles: string[] = [];
  const call = /\b(?:describe|test|it)((?:\.(?:only|concurrent|sequential|fails|skipIf|runIf|each|for|todo|skip)(?:\((?:[^()]|\([^()]*\))*\))?)*)\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const m of stripComments(source).matchAll(call)) {
    const modifiers = m[1] ?? '';
    if (/\.(?:todo|skip)\b(?!If)/.test(modifiers)) continue;
    titles.push(m[3] ?? '');
  }
  return titles;
}

/** Titres de tous les tests réels du monorepo (hors tests/vitrine), un par ligne. */
export const readTestCorpus = (): string => testCorpusFiles().flatMap((file) => testTitles(readFileSync(file, 'utf8'))).join('\n');

/** Retire les commentaires de ligne et de bloc (approximation suffisante pour des fichiers de test). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}
