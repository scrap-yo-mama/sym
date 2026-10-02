// SPDX-License-Identifier: AGPL-3.0-only
// Chaque test nommé de tests/invariants.json (06-taches §1) existe dans un fichier de test du module.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? testFiles(path) : /\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

test('invariants.json : chaque test nommé est présent dans le code de test du module', () => {
  const table = JSON.parse(readFileSync(join(MODULE_ROOT, 'tests/invariants.json'), 'utf8')) as { test: string }[];
  const corpus = testFiles(MODULE_ROOT)
    .filter((file) => !file.endsWith('invariants.unit.test.ts'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  expect(table.length).toBeGreaterThan(0);
  expect(table.filter((row) => !corpus.includes(row.test))).toEqual([]);
});
