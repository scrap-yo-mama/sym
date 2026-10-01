// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.1 : génère la référence des variables (docs/variables-env.md) et `.env.example` depuis le catalogue du code
// (packages/core/src/config/env-catalog.ts). `--check` : échoue si les fichiers du dépôt diffèrent (assert_env_docs_in_sync).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderEnvExample, renderEnvReference } from '@runtime/core';

const runtimeDir = new URL('..', import.meta.url).pathname;
export const GENERATED_FILES = { 'docs/variables-env.md': renderEnvReference(), '.env.example': renderEnvExample() } as const;

const check = process.argv.includes('--check');
let stale = 0;
for (const [file, expected] of Object.entries(GENERATED_FILES)) {
  const path = join(runtimeDir, file);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === expected) continue;
  if (check) {
    console.error(`${file} diffère du catalogue : lancez \`pnpm gen:env-docs\`.`);
    stale += 1;
  } else {
    writeFileSync(path, expected);
    console.log(`${file} régénéré.`);
  }
}
if (stale > 0) process.exit(1);
if (check) console.log('Référence des variables et .env.example : à jour.');
