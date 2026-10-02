// SPDX-License-Identifier: AGPL-3.0-only
// Registre des tests nommés du module (cdc/sym-browser 06 § 1, 04e § 3) : chaque entrée de tests/invariants.json nomme un
// invariant BINVn et un test présent dans au moins un fichier de test du module.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';

type Entry = { test: string; invariant: string; tasks: string[]; stage: string };
const SKIP = new Set(['node_modules', 'dist', '.vite', 'coverage']);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? testFiles(path) : /\.test\.ts$/.test(e.name) ? [path] : [];
  });
}

describe('registre tests/invariants.json', () => {
  const entries = JSON.parse(readFileSync(join(MODULE_ROOT, 'tests/invariants.json'), 'utf8')) as Entry[];
  const sources = testFiles(MODULE_ROOT)
    .filter((f) => !f.endsWith('invariants.unit.test.ts'))
    .map((f) => readFileSync(f, 'utf8'));

  test('entrées bien formées, noms uniques', () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((e) => e.test)).size).toBe(entries.length);
    for (const e of entries) {
      // Invariant BINVn (test `assert_*`) ou exigence nommée d'une spec (`04b § 9`, tâche 2.7) : jamais une entrée libre.
      expect(e.test, e.test).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(e.invariant, e.test).toMatch(/^(BINV\d+|[A-Z]\d+ |0\d[a-g]? § \d)/);
      if (e.test.startsWith('assert_')) expect(e.invariant, e.test).toMatch(/^BINV\d+/);
      expect(e.tasks.length, e.test).toBeGreaterThan(0);
    }
  });

  test('chaque test nommé existe dans un fichier de test du module', () => {
    for (const e of entries) expect(sources.some((s) => s.includes(e.test)), e.test).toBe(true);
  });
});
