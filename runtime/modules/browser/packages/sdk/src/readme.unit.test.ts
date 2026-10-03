// SPDX-License-Identifier: MIT
// Forme de l'exemple du README (recette étape 4 : « exemple d'environ 20 lignes ») ; son exécution contre le mode `all`
// est `sdk_readme_example` (tests/sdk-readme.chromium.test.ts, racine du module).
import { describe, expect, test } from 'vitest';
import { readmeExample } from './testing/readme.js';

describe('exemple du README', () => {
  const example = readmeExample();
  const lines = example.split('\n').filter((line) => line.trim() !== '');

  test('environ 20 lignes, sans type TypeScript à effacer (exécutable tel quel par Node)', () => {
    expect(lines.length).toBeGreaterThanOrEqual(15);
    expect(lines.length).toBeLessThanOrEqual(25);
    expect(example).not.toMatch(/:\s*(string|number|boolean|Session|Browser)\b|\bas\s+\w+|<\w+>/);
  });

  test('importe le SDK seul, crée, connecte, lit un titre, libère par await using ; aucune clé en clair', () => {
    expect([...example.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['@sym-browser/sdk']);
    for (const piece of ['new SymBrowser(', 'symb.sessions.create(', 'await using', 'symb.connect(', 'page.title()', 'symb.sessions.get(']) expect(example).toContain(piece);
    expect(example).not.toMatch(/symb_[A-Za-z0-9]{8,}|apiKey:\s*'/);
  });
});
