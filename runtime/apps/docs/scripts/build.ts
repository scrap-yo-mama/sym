// SPDX-License-Identifier: AGPL-3.0-only
// Construction du site de doc (tâche 4.8) : pages générées, VitePress, versions Markdown et llms.txt, vérificateur de liens,
// index Pagefind. Rien n'est publié : la sortie reste dans apps/docs/dist. Échoue au premier problème.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vitepress';
import { buildSearchIndex, checkSite, normalizeBase, outDirName, writeLlmsFiles } from '../src/site.ts';
import { generateReference } from './gen-reference.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { SYM_GHOST_PATH, SYM_GHOST_VIEWBOX } from '@runtime/ui/sym-ghost';
import { buildFavicon, buildRobots, buildSitemap, siteEnv, writeFile } from '../src/landing/site.ts';
import { HOME_PATHS, LEGAL_PATHS, withBasePath } from '../src/landing/href.ts';
import { buildHeadersFile, cspOf } from '../src/landing/csp.ts';
import { PAGES } from '../src/nav.ts';

const content = fileURLToPath(new URL('content/', new URL('../', import.meta.url)));
const dist = fileURLToPath(new URL(`${outDirName()}/`, new URL('../', import.meta.url)));
const base = normalizeBase(process.env['DOCS_BASE']);

rmSync(dist, { recursive: true, force: true });
const { rest, reasons } = generateReference();
writeFileSync(`${content}reference/rest.md`, rest);
writeFileSync(`${content}reference/codes-de-raison.md`, reasons);

await build(content);
const distDir = dist.replace(/\/$/, '');
writeLlmsFiles(content, distDir, base, process.env['DOCS_SITE_URL']);

// Fichiers de la landing (22 § 2.8) : sitemap, robots.txt ouvert, icône. Tous calculés au build, avec l'adresse et le chemin de base du site.
const site = siteEnv(process.env, base);
const landingPaths = [...Object.values(HOME_PATHS), ...Object.values(LEGAL_PATHS).flatMap((legal) => Object.values(legal))];
writeFile(`${distDir}/sitemap.xml`, buildSitemap([...landingPaths, ...PAGES.map((page) => page.path)], site));
const homeCsp = cspOf(readFileSync(`${distDir}/index.html`, 'utf8'));
if (!homeCsp) throw new Error('la page d\'accueil construite n\'a pas de balise CSP');
writeFile(`${distDir}/_headers`, buildHeadersFile(landingPaths.map((path) => withBasePath(base, path)), homeCsp));
writeFile(`${distDir}/robots.txt`, buildRobots(site));
writeFile(`${distDir}/favicon.svg`, buildFavicon(readFileSync(new URL('../../../packages/ui/src/theme.css', import.meta.url), 'utf8'), SYM_GHOST_PATH, SYM_GHOST_VIEWBOX));

const problems = checkSite(distDir, base);
if (problems.length > 0) {
  console.error(`docs : ${problems.length} problème(s) dans le site construit :`);
  for (const p of problems) console.error(`  - ${p.page} : ${p.problem}`);
  process.exit(1);
}
const pages = await buildSearchIndex(distDir);
console.log(`docs : site construit dans ${dist.replace(/\/$/, '')} (${pages} pages indexées par Pagefind, 0 lien mort, llms.txt et llms-full.txt présents).`);
