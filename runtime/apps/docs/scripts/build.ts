// SPDX-License-Identifier: AGPL-3.0-only
// Construction du site de doc (tâche 4.8) : pages générées, VitePress, versions Markdown et llms.txt, vérificateur de liens,
// index Pagefind. Rien n'est publié : la sortie reste dans apps/docs/dist. Échoue au premier problème.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vitepress';
import { buildSearchIndex, checkSite, normalizeBase, writeLlmsFiles } from '../src/site.ts';
import { generateReference } from './gen-reference.ts';
import { writeFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const content = fileURLToPath(new URL('content/', new URL('../', import.meta.url)));
const dist = fileURLToPath(new URL('dist/', new URL('../', import.meta.url)));
const base = normalizeBase(process.env['DOCS_BASE']);

rmSync(dist, { recursive: true, force: true });
const { rest, reasons } = generateReference();
writeFileSync(`${content}reference/rest.md`, rest);
writeFileSync(`${content}reference/codes-de-raison.md`, reasons);

await build(content);
const distDir = dist.replace(/\/$/, '');
writeLlmsFiles(content, distDir, base, process.env['DOCS_SITE_URL']);

const problems = checkSite(distDir, base);
if (problems.length > 0) {
  console.error(`docs : ${problems.length} problème(s) dans le site construit :`);
  for (const p of problems) console.error(`  - ${p.page} : ${p.problem}`);
  process.exit(1);
}
const pages = await buildSearchIndex(distDir);
console.log(`docs : site construit dans ${root}dist (${pages} pages indexées par Pagefind, 0 lien mort, llms.txt et llms-full.txt présents).`);
