// SPDX-License-Identifier: AGPL-3.0-only
// assert_landing_links_resolve, volet externe (22b § 2) : les liens externes de la landing construite répondent 200, hors exceptions
// documentées ci-dessous. Seul script de la landing à ouvrir des connexions sortantes : il ne tourne ni en CI de PR ni dans ci:local
// (aucune connexion hors machine), mais à la release et chaque semaine après la mise en ligne (job `vitrine`).
//   node scripts/landing-links.ts [dossier construit, défaut dist]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExternalLinks } from '../src/landing/checks.ts';

/** Exceptions documentées : aucune pour l'instant (liste de l'hôte, ou adresse complète, à justifier ici avant d'en ajouter). */
const EXCEPTIONS = new Set<string>();

const dist = process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url));
const pages = (dir: string): string[] => readdirSync(dir).flatMap((entry) => (statSync(join(dir, entry)).isDirectory() ? (entry === 'pagefind' || entry === 'assets' ? [] : pages(join(dir, entry))) : entry.endsWith('.html') ? [join(dir, entry)] : []));
const landing = pages(dist).filter((file) => /(?:^|\/)(?:index|privacy|legal-notice|confidentialite|mentions-legales)\.html$/.test(file));
const urls = landing.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/<a\b[^>]*\shref="(https?:\/\/[^"#]+)/g)].map((match) => (match[1] ?? '').replace(/&amp;/g, '&')));
const failures = await checkExternalLinks(urls, async (url, method) => (await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(20_000) })).status, EXCEPTIONS);
console.log(`${new Set(urls).size} liens externes vérifiés, ${failures.length} en échec.`);
for (const failure of failures) console.log(`  ${failure.status}  ${failure.url}`);
process.exitCode = failures.length === 0 ? 0 : 1;
