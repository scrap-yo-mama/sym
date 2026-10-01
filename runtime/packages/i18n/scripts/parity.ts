// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm i18n:parity` : parité de toutes les surfaces (21b M1), listes de mots interdits par langue livrée (M13) et clés
// `ext.manifest.*` du `_locales` généré. Échoue (code 1) au premier écart. Lit `dist/` : `pnpm build` d'abord.
import { existsSync } from 'node:fs';
import { checkParity, flatten, loadCatalogs, loadRegistry, localesDir, shippedCodes } from '../dist/index.js';

const dir = localesDir();
const registry = loadRegistry(dir);
const catalogs = loadCatalogs(registry, dir);
const locales = shippedCodes(registry);
const problems = checkParity(catalogs, registry, locales).map((p) => `${p.locale} ${p.kind} ${p.key}${p.detail ? ` (${p.detail})` : ''}`);
for (const code of locales) {
  if (!existsSync(`${dir}${dir.endsWith('/') ? '' : '/'}forbidden.${code}.txt`)) problems.push(`${code} forbidden.${code}.txt absent (M13)`);
}
if (![...flatten(catalogs['en'] ?? {}).keys()].some((k) => k.startsWith('ext.manifest.'))) problems.push('en ext.manifest.* absent');
if (problems.length > 0) {
  console.error(`i18n:parity : ${problems.length} écart(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`i18n:parity : ${locales.join(', ')} à parité (${flatten(catalogs['en'] ?? {}).size} clés en).`);
