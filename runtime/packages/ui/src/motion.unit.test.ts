// SPDX-License-Identifier: AGPL-3.0-only
// assert_reduced_motion_respected, volet feuille (20b § 3.1 ; le volet navigateur est apps/web/e2e/brand.e2e.ts) : la couche
// d'animations de packages/ui est unique, courte, coupée par `prefers-reduced-motion: reduce` et par le réglage Animations
// « Réduites », et chaque animation a pour état final son état de repos (rien n'est caché tant qu'elle n'a pas joué).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const uiRoot = new URL('..', import.meta.url).pathname;
const theme = readFileSync(join(uiRoot, 'src/theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Corps du bloc qui suit `header` (accolades équilibrées). */
function block(header: string): string {
  const start = theme.indexOf(header);
  if (start < 0) throw new Error(`bloc absent : ${header}`);
  let depth = 0;
  for (let at = theme.indexOf('{', start); at < theme.length; at += 1) {
    if (theme[at] === '{') depth += 1;
    if (theme[at] === '}' && --depth === 0) return theme.slice(theme.indexOf('{', start) + 1, at);
  }
  throw new Error(`bloc non fermé : ${header}`);
}

describe('assert_reduced_motion_respected (feuille)', () => {
  test('prefers-reduced-motion: reduce coupe animations et transitions de tout le document', () => {
    const reduced = block('@media (prefers-reduced-motion: reduce)');
    expect(reduced).toMatch(/animation:\s*none\s*!important/);
    expect(reduced).toMatch(/transition:\s*none\s*!important/);
    expect(reduced).toMatch(/scroll-behavior:\s*auto\s*!important/);
    expect(reduced).toMatch(/\*,\s*::before,\s*::after/);
  });

  test('le réglage Animations « Réduites » (data-motion="reduced" sur html) coupe la même chose', () => {
    expect(theme).toMatch(/:root\[data-motion='reduced'\] \*,\s*:root\[data-motion='reduced'\] ::before,\s*:root\[data-motion='reduced'\] ::after\s*\{/);
    const setting = block(":root[data-motion='reduced'] *,");
    expect(setting).toMatch(/animation:\s*none\s*!important/);
    expect(setting).toMatch(/transition:\s*none\s*!important/);
  });

  test('aucune animation ne boucle ni ne dure plus de 5 s (WCAG 2.2.2) ; aucune n’est déclarée hors de la couche de theme.css', () => {
    for (const match of theme.matchAll(/animation:\s*([^;]+);/g)) {
      const declaration = match[1] ?? '';
      if (declaration.trim() === 'none !important') continue;
      expect(declaration, declaration).not.toMatch(/infinite/);
      const seconds = Number(/([\d.]+)s\b/.exec(declaration)?.[1]);
      expect(seconds, declaration).toBeGreaterThan(0);
      expect(seconds, declaration).toBeLessThanOrEqual(5);
    }
  });

  test('état final = état de repos : la coche tracée et l’apparition reposent sur leur valeur finale (sans animation, tout est affiché)', () => {
    expect(block('.sym-check path')).toMatch(/stroke-dashoffset:\s*0/);
    expect(block('@keyframes sym-fade-in')).toMatch(/to\s*\{[^}]*opacity:\s*1/);
    expect(block('.sym-fade-in')).not.toMatch(/opacity/);
  });
});
