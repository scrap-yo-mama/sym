// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm i18n:types` : écrit `keys.d.ts` depuis `en.json` (type `MessageKey`) : une clé inexistante fait échouer `tsc`.
// `--check` : n'écrit rien, échoue si le fichier n'est pas à jour (CI).
import { readFileSync, writeFileSync } from 'node:fs';
import { flatten, loadCatalogs, loadRegistry } from '../dist/index.js';

const target = new URL('../keys.d.ts', import.meta.url);
const en = loadCatalogs(loadRegistry())['en'];
if (!en) throw new Error('en.json introuvable');
const keys = [...flatten(en).keys()].sort();
const text = `// SPDX-License-Identifier: AGPL-3.0-only
// GÉNÉRÉ par \`pnpm i18n:types\` depuis locales/en.json : ne pas modifier à la main.
/** Clé du catalogue source (\`en.json\`) ; une clé inexistante fait échouer \`tsc\`. */
export type MessageKey =
${keys.map((k) => `  | '${k}'`).join('\n')};
`;
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // absent
  }
  if (current !== text) {
    console.error('i18n:types : keys.d.ts périmé : lancez `pnpm i18n:types`.');
    process.exit(1);
  }
  console.log(`i18n:types : keys.d.ts à jour (${keys.length} clés).`);
} else {
  writeFileSync(target, text);
  console.log(`i18n:types : keys.d.ts écrit (${keys.length} clés).`);
}
