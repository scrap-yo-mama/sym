// SPDX-License-Identifier: MIT
// `exports` fermés (ADR 23 § 3) : seul `@sym/contracts/browser` se résout ; tout chemin interne est refusé par Node. Et
// `contracts` est une feuille : aucune dépendance, aucun import hors du paquet.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const pkgDir = new URL('../..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
  license: string;
};
const require = createRequire(import.meta.url);

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

describe('@sym/contracts : exports fermés', () => {
  test('un seul sous-chemin publié : ./browser', () => {
    expect(Object.keys(manifest.exports)).toEqual(['./browser']);
  });

  test('@sym/contracts/browser se résout vers le build', () => {
    expect(require.resolve('@sym/contracts/browser')).toMatch(/\/dist\/browser\/index\.js$/);
  });

  test.each(['@sym/contracts', '@sym/contracts/src/browser/index.ts', '@sym/contracts/dist/browser/index.js', '@sym/contracts/dist/browser/openapi.js', '@sym/contracts/package.json', '@sym/contracts/strategy'])(
    'chemin non exporté refusé : %s',
    (specifier) => {
      expect(() => require.resolve(specifier)).toThrow(expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }) as Error);
    },
  );

  test('feuille : aucune dépendance, seuls des imports relatifs internes au paquet et le type `Browser` de playwright-core (pair, import type)', () => {
    expect(manifest.dependencies ?? {}).toEqual({});
    const offenders: string[] = [];
    for (const file of sources(join(pkgDir, 'src')).filter((f) => !f.endsWith('.test.ts'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(?:^|\s)(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        const typeOnlyPlaywright = match[1] === 'playwright-core' && match[0].includes('import type');
        if (!match[1]?.startsWith('./') && !typeOnlyPlaywright) offenders.push(`${file} : ${match[1] ?? ''}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('licence MIT (un SDK MIT peut en dépendre ; à valider par l’avocat, ADR 23 § 7)', () => {
    expect(manifest.license).toBe('MIT');
  });
});
