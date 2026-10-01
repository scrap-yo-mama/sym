// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm i18n:pseudo` : génère `qps-ploc` EN MÉMOIRE depuis `en.json` (jamais livrée ni versionnée) et vérifie que chaque message
// garde ses variables et ses formes de pluriel. `--print <clé>` affiche un message pseudo-localisé.
import { flatten, loadCatalogs, loadRegistry, placeholdersOf, pluralFormsOf, pseudoCatalog } from '../dist/index.js';

const registry = loadRegistry();
const en = loadCatalogs(registry)['en'];
if (!en) throw new Error('en.json introuvable');
const pseudo = flatten(pseudoCatalog(en));
const source = flatten(en);
const broken: string[] = [];
for (const [key, message] of source) {
  if (key.startsWith('mcp.model.')) continue;
  const out = pseudo.get(key) ?? '';
  if (placeholdersOf(out).join() !== placeholdersOf(message).join() || pluralFormsOf(out) !== pluralFormsOf(message)) broken.push(key);
}
const at = process.argv.indexOf('--print');
if (at !== -1) console.log(pseudo.get(process.argv[at + 1] ?? '') ?? '(clé inconnue)');
if (broken.length > 0) {
  console.error(`i18n:pseudo : variables ou pluriels perdus : ${broken.join(', ')}`);
  process.exit(1);
}
console.log(`i18n:pseudo : qps-ploc générée en mémoire, ${pseudo.size} messages.`);
