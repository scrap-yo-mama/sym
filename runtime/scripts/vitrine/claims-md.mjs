// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm vitrine:claims` : régénère .github/CLAIMS.md depuis .github/claims.json ; `--check` : échoue s'il n'est pas à jour.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimsMarkdown, loadClaims } from './lib/claims.ts';
import { githubDir } from './lib/paths.ts';

const target = join(githubDir, 'CLAIMS.md');
const expected = claimsMarkdown(loadClaims());
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // absent : traité comme périmé
  }
  if (current !== expected) {
    console.error('.github/CLAIMS.md n\'est pas à jour de claims.json : lancer `pnpm vitrine:claims`.');
    process.exit(1);
  }
  console.log('.github/CLAIMS.md est à jour de claims.json.');
} else {
  writeFileSync(target, expected);
  console.log('.github/CLAIMS.md régénéré.');
}
