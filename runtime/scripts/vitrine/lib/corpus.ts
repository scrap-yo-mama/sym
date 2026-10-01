// SPDX-License-Identifier: AGPL-3.0-only
// Texte de tous les fichiers de test du monorepo : sert de preuve aux noms `assert_…` cités par le registre des allégations.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeDir } from './paths.ts';

const SKIP = new Set(['node_modules', 'dist', 'coverage', 'blob-report', 'test-results', '.git', '.wxt', '.output']);

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

export const readTestCorpus = (): string => testFiles(runtimeDir).map((file) => readFileSync(file, 'utf8')).join('\n');
