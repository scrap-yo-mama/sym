// SPDX-License-Identifier: AGPL-3.0-only
// Échoue si un test nommé de tests/invariants.json (table 15 §12) n'existe nulle part dans le code de test.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', 'dist', 'coverage', 'blob-report', 'test-results', '.git']);

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

const table = JSON.parse(readFileSync(join(root, 'tests/invariants.json'), 'utf8')) as {
  test: string;
}[];
const corpus = testFiles(root).map((f) => readFileSync(f, 'utf8')).join('\n');

const missing = table.map((r) => r.test).filter((name) => !corpus.includes(name));
if (missing.length > 0) {
  console.error(`Invariants sans test (ni test.todo) :\n${missing.map((m) => `  - ${m}`).join('\n')}`);
  process.exit(1);
}
console.log(`Invariants : ${table.length} tests nommés présents (au moins en test.todo).`);
