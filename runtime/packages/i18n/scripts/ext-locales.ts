// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm i18n:ext-locales [dossier]` : écrit `<dossier>/<code>/messages.json` (défaut : `.generated/_locales`) depuis `ext.manifest.*`.
// Le branchement au build de l'extension et la fiche du Store relèvent de la tâche 3.18.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExtensionLocales, loadCatalogs, loadRegistry } from '../dist/index.js';

const registry = loadRegistry();
const out = buildExtensionLocales(loadCatalogs(registry), registry);
const root = process.argv[2] ?? new URL('../.generated/_locales', import.meta.url).pathname;
for (const [code, messages] of Object.entries(out)) {
  mkdirSync(join(root, code), { recursive: true });
  writeFileSync(join(root, code, 'messages.json'), `${JSON.stringify(messages, null, 2)}\n`);
}
console.log(`i18n:ext-locales : ${Object.keys(out).join(', ')} écrites dans ${root}.`);
