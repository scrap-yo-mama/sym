// SPDX-License-Identifier: AGPL-3.0-only
// Étapes après `vitepress build` (16 § 4) : version Markdown de chaque page, llms.txt et llms-full.txt, vérificateur de
// liens et de ressources sur le site construit. Fonctions pures ou presque : testées sans construire le site.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { PAGES, QUADRANTS, type PageEntry } from './nav.ts';

export const SITE_TITLE = 'Scrapyomama Runtime';
export const SITE_SUMMARY =
  'Un outil open source, appelé en MCP. Un agent enquête pour trouver la méthode la moins chère qui produit la sortie demandée, l’enregistre comme une API du catalogue, la rejoue à coût de code et la répare quand elle casse. Auto-hébergé : PostgreSQL, modèle IA et proxys à vous.';

/** Dossier de sortie sous apps/docs : `DOCS_OUT_DIR` (un nom simple, défaut `dist`). */
export function outDirName(env: Record<string, string | undefined> = process.env): string {
  const name = (env['DOCS_OUT_DIR'] ?? 'dist').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new Error(`DOCS_OUT_DIR invalide : « ${name} »`);
  return name;
}

export const stripFrontmatter = (markdown: string): string => markdown.replace(/^---\n[\s\S]*?\n---\n/, '');

/** Préfixe commun des liens du site : `DOCS_BASE` (défaut `/`), toujours avec une barre au début et à la fin. */
export function normalizeBase(base: string | undefined): string {
  const trimmed = (base ?? '/').trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

/** URL d'une ressource du site : absolue si `siteUrl` est connu, sinon le chemin avec la base. */
export function siteLink(path: string, base: string, siteUrl?: string): string {
  const full = `${normalizeBase(base)}${path.replace(/^\/+/, '')}`;
  return siteUrl ? `${siteUrl.replace(/\/+$/, '')}${full}` : full;
}

export const markdownPath = (page: PageEntry): string => `${page.path}.md`;

export function buildLlmsTxt(base: string, siteUrl?: string): string {
  const lines = [`# ${SITE_TITLE}`, '', `> ${SITE_SUMMARY}`, '', 'Cette documentation suit Diátaxis. Chaque page existe aussi en Markdown (même chemin, extension `.md`). `llms-full.txt` réunit toutes les pages.', ''];
  for (const quadrant of QUADRANTS) {
    lines.push(`## ${quadrant.title}`, '');
    for (const page of PAGES.filter((p) => p.quadrant === quadrant.id)) {
      lines.push(`- [${page.title}](${siteLink(markdownPath(page), base, siteUrl)}): ${page.summary}`);
    }
    lines.push('');
  }
  lines.push('## Optionnel', '', `- [Tout le contenu en un seul fichier](${siteLink('llms-full.txt', base, siteUrl)}): les pages ci-dessus, concaténées.`, '');
  return lines.join('\n');
}

export function buildLlmsFull(read: (page: PageEntry) => string): string {
  const parts = [`# ${SITE_TITLE}`, '', `> ${SITE_SUMMARY}`, ''];
  for (const page of PAGES) {
    parts.push(`<page path="${page.path}" quadrant="${page.quadrant}">`, '', stripFrontmatter(read(page)).trim(), '', '</page>', '');
  }
  return parts.join('\n');
}

/** Écrit `<page>.md`, `llms.txt` et `llms-full.txt` dans le dossier construit. */
export function writeLlmsFiles(contentDir: string, distDir: string, base: string, siteUrl?: string): void {
  const read = (page: PageEntry): string => readFileSync(join(contentDir, `${page.path}.md`), 'utf8');
  for (const page of PAGES) {
    const target = join(distDir, markdownPath(page));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${stripFrontmatter(read(page)).trim()}\n`);
  }
  writeFileSync(join(distDir, 'llms.txt'), buildLlmsTxt(base, siteUrl));
  writeFileSync(join(distDir, 'llms-full.txt'), `${buildLlmsFull(read)}\n`);
}

function walk(dir: string, filter: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

const attrs = (html: string, tag: string, attr: string): string[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*?\\s${attr}="([^"]*)"`, 'g'))].map((m) => m[1] ?? '');

const ids = (html: string): Set<string> => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ''));

export type SiteProblem = { page: string; problem: string };

/**
 * Contrôle du site construit : 0 lien interne mort (fichier ET ancre), aucune ressource chargée hors du site (INV9 : la
 * page n'appelle personne), llms.txt cité dans chaque page. Les liens externes (`<a href="https://…">`) ne sont pas
 * suivis : la CI n'ouvre aucune connexion sortante.
 */
export function checkSite(distDir: string, base: string): SiteProblem[] {
  const problems: SiteProblem[] = [];
  const normalized = normalizeBase(base);
  const pages = walk(distDir, (f) => f.endsWith('.html') && !f.includes(`${join(distDir, 'pagefind')}`));
  const cache = new Map<string, string>();
  const htmlOf = (file: string): string => {
    let html = cache.get(file);
    if (html === undefined) {
      html = readFileSync(file, 'utf8');
      cache.set(file, html);
    }
    return html;
  };
  const resolveFile = (urlPath: string): string | undefined => {
    const relative = decodeURIComponent(urlPath.slice(normalized.length));
    const candidates = [relative, `${relative}.html`, posix.join(relative, 'index.html')];
    return candidates.map((c) => join(distDir, c)).find((c) => existsSync(c) && statSync(c).isFile());
  };
  for (const file of pages) {
    const rel = file.slice(distDir.length + 1);
    const html = htmlOf(file);
    const here = `${normalized}${rel.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '')}`;
    const refs = [...attrs(html, 'a', 'href').map((r) => ({ r, kind: 'lien' })), ...attrs(html, 'img', 'src').map((r) => ({ r, kind: 'image' }))];
    for (const { r, kind } of refs) {
      if (r === '' || /^(mailto|tel|javascript):/.test(r)) continue;
      if (/^https?:\/\//.test(r) || r.startsWith('//')) {
        if (kind === 'image') problems.push({ page: rel, problem: `image chargée hors du site : ${r}` });
        continue;
      }
      const [pathPart = '', fragment] = r.split('#') as [string, string | undefined];
      const target = pathPart === '' ? here : pathPart.startsWith('/') ? pathPart : posix.join(posix.dirname(here + (here.endsWith('/') ? 'x' : '')), pathPart);
      const query = target.split('?')[0] ?? target;
      if (!query.startsWith(normalized)) {
        problems.push({ page: rel, problem: `${kind} hors de la base du site : ${r}` });
        continue;
      }
      const resolved = resolveFile(query);
      if (!resolved) {
        problems.push({ page: rel, problem: `${kind} mort : ${r}` });
        continue;
      }
      if (fragment && resolved.endsWith('.html') && !ids(htmlOf(resolved)).has(decodeURIComponent(fragment))) {
        problems.push({ page: rel, problem: `ancre introuvable : ${r}` });
      }
    }
    // Une balise <link> canonique ou d'alternative de langue désigne une page (adresse absolue voulue), elle ne charge rien.
    const resourceLinks = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !/\brel="(?:canonical|alternate)"/.test(tag));
    for (const tag of resourceLinks) {
      const href = /\shref="([^"]*)"/.exec(tag)?.[1] ?? '';
      if (/^(https?:)?\/\//.test(href)) problems.push({ page: rel, problem: `ressource chargée hors du site : ${href}` });
    }
    for (const src of attrs(html, 'script', 'src')) {
      if (/^(https?:)?\/\//.test(src)) problems.push({ page: rel, problem: `ressource chargée hors du site : ${src}` });
    }
    if (rel !== '404.html' && !html.includes('llms.txt')) problems.push({ page: rel, problem: 'aucun lien vers llms.txt' });
  }
  for (const required of ['llms.txt', 'llms-full.txt']) if (!existsSync(join(distDir, required))) problems.push({ page: required, problem: 'fichier absent' });
  for (const page of PAGES) {
    if (!existsSync(join(distDir, markdownPath(page)))) problems.push({ page: page.path, problem: 'version .md absente' });
    if (!resolveFile(`${normalized}${page.path}`)) problems.push({ page: page.path, problem: 'page HTML absente' });
  }
  return problems;
}

/** Index Pagefind du site construit (statique, sans tiers) : écrit `dist/pagefind/`. */
export async function buildSearchIndex(distDir: string): Promise<number> {
  const pagefind = await import('pagefind');
  const { index, errors: createErrors } = await pagefind.createIndex({ rootSelector: '.vp-doc', forceLanguage: 'fr' });
  if (!index) throw new Error(`Pagefind : index non créé (${createErrors.join('; ')})`);
  const added = await index.addDirectory({ path: distDir, glob: '**/*.html' });
  if (added.errors.length > 0) throw new Error(`Pagefind : ${added.errors.join('; ')}`);
  const written = await index.writeFiles({ outputPath: join(distDir, 'pagefind') });
  if (written.errors.length > 0) throw new Error(`Pagefind : ${written.errors.join('; ')}`);
  await pagefind.close();
  return added.page_count;
}
