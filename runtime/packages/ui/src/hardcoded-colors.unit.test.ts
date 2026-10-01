// SPDX-License-Identifier: AGPL-3.0-only
// assert_no_hardcoded_colors (20b § 3.1, U1, règle de 20b § 1 « jetons ») : aucune couleur en dur dans les styles de
// apps/web et d'apps/extension, ni dans les composants de packages/ui, hors des jetons de packages/ui/src/theme.css (seul
// fichier qui écrit des valeurs de couleur). Couleurs hexadécimales, rgb()/hsl()/oklch(), classes de la palette de Tailwind,
// text-white, couleurs nommées dans une déclaration : toutes refusées.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { hardcodedColors, listFiles } from './testing/color-rules.ts';

const runtimeRoot = join(new URL('..', import.meta.url).pathname, '../..');
const SOURCES = /\.(vue|ts|css|html|js|svg)$/;

/** Fichiers de style et de gabarit où une couleur pourrait se glisser. */
function styledFiles(): string[] {
  const roots = ['apps/web/src', 'apps/web/public', 'apps/extension/src', 'packages/ui/src'].map((dir) => join(runtimeRoot, dir));
  const files = roots.flatMap((dir) => listFiles(dir, SOURCES, /(^|\/)(node_modules|dist|\.wxt|\.output|testing|__snapshots__)(\/|$)/));
  files.push(join(runtimeRoot, 'apps/web/index.html'));
  return files.filter((file) => !file.endsWith('packages/ui/src/theme.css'));
}

describe('assert_no_hardcoded_colors', () => {
  test('aucune couleur en dur dans apps/web, apps/extension et les composants de packages/ui', () => {
    const files = styledFiles();
    expect(files.length).toBeGreaterThan(80);
    const findings = files.flatMap((file) => hardcodedColors(readFileSync(file, 'utf8'), file.replace(`${runtimeRoot}/`, '')));
    expect(findings.map((f) => `${f.file}:${f.line} ${f.rule} « ${f.text} »`)).toEqual([]);
  });

  test('theme.css est le seul fichier à écrire des valeurs de couleur (et il en écrit)', () => {
    const theme = readFileSync(join(runtimeRoot, 'packages/ui/src/theme.css'), 'utf8');
    expect(hardcodedColors(theme, 'theme.css').length).toBeGreaterThan(20);
  });

  test('le contrôle refuse chaque forme de couleur en dur', () => {
    const bad: [string, string][] = [
      ['hexadécimale', '.a { color: #3A33F0; }'],
      ['hexadécimale courte', '.a { background: #fff; }'],
      ['hexadécimale entre guillemets', "const c = '#FF5A1F';"],
      ['hexadécimale courte entre guillemets', "const c = '#000';"],
      ['hexadécimale de 4 chiffres entre guillemets', 'const c = "#fff8";'],
      ['hexadécimale courte en attribut SVG', '<path fill="#fff"/>'],
      ['hexadécimale courte en attribut SVG (stroke)', "<circle stroke='#0af' />"],
      ['rgb', '.a { color: rgb(0 0 0); }'],
      ['rgba', '.a { color: rgba(0,0,0,.5); }'],
      ['hsl', '.a { color: hsl(10 20% 30%); }'],
      ['oklch', '.a { color: oklch(0.5 0.1 20); }'],
      ['palette Tailwind', '<p class="text-emerald-800 dark:text-emerald-300">'],
      ['palette Tailwind en dégradé', '<p class="from-sky-500 to-violet-600/50">'],
      ['blanc Tailwind', '<p class="bg-destructive text-white">'],
      ['noir Tailwind', '<p class="bg-black/50">'],
      ['couleur nommée', '.a { color: red; }'],
      ['attribut SVG nommé', '<path fill="black" />'],
      // Ombres de Tailwind : rgb noir écrit en dur dans Tailwind, contraires aux ombres plates de la charte (20 § 1.2).
      ['ombre Tailwind xs', '<input class="h-11 shadow-xs">'],
      ['ombre Tailwind sm en variante', '<p class="hover:shadow-sm">'],
      ['ombre Tailwind md', "const c = 'shadow-md';"],
      ['ombre Tailwind lg', '<div class="rounded-xl shadow-lg">'],
    ];
    for (const [label, source] of bad) expect(hardcodedColors(source, 'zz').length, label).toBeGreaterThan(0);
  });

  test('le contrôle laisse passer les jetons, les ancres, les identifiants et les couleurs héritées', () => {
    const good = [
      '<a href="#main" class="bg-primary text-primary-foreground">',
      '.a { color: var(--foreground); background-color: var(--sym-orange); }',
      '.a { border-color: currentColor; background: transparent; }',
      "locator('#identity'); const id = '#add-key';",
      '<svg fill="currentColor" aria-hidden="true" />',
      '.a { color: color-mix(in oklab, var(--card) 50%, transparent); }',
      '<p class="bg-status-sain text-status-sain-foreground border-status-border bg-muted/50">',
      '<div class="rounded-xl shadow-flat">',
    ];
    for (const source of good) expect(hardcodedColors(source, 'zz'), source).toEqual([]);
  });
});
