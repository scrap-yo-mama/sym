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
  stage?: string;
}[];
const files = testFiles(root).map((f) => ({ path: f, text: readFileSync(f, 'utf8') }));
const corpus = files.map((f) => f.text).join('\n');

const missing = table.map((r) => r.test).filter((name) => !corpus.includes(name));
if (missing.length > 0) {
  console.error(`Invariants sans test (ni test.todo) :\n${missing.map((m) => `  - ${m}`).join('\n')}`);
  process.exit(1);
}
// Étage « contract » déclaré : le test nommé doit vivre dans un fichier du projet contract (*.contract.test.ts), sinon
// `vitest --project contract` ne le joue jamais et l'étage annoncé est faux.
const contractFiles = files.filter((f) => /\.contract\.test\.(ts|tsx|mts)$/.test(f.path));
const wrongStage = table
  .filter((r) => (r.stage ?? '').split(',').some((s) => s.trim() === 'contract'))
  .filter((r) => !contractFiles.some((f) => f.text.includes(r.test)))
  .map((r) => r.test);
if (wrongStage.length > 0) {
  console.error(`Étage « contract » déclaré sans test du projet contract :\n${wrongStage.map((m) => `  - ${m}`).join('\n')}`);
  process.exit(1);
}
console.log(`Invariants : ${table.length} tests nommés présents (au moins en test.todo).`);
