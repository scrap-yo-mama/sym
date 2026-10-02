// SPDX-License-Identifier: AGPL-3.0-only
// Branchement de la landing sur VitePress (Node, au build) : quelle page est une page d'accueil ou une page juridique, contenu
// injecté dans le frontmatter, balises du `head` (canonique, hreflang, OG, JSON-LD), CSP sur le HTML final, sitemap et robots.txt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseQuickstart } from '../quickstart.ts';
import { loadClaims } from './claims.ts';
import { buildLanding, buildLegalChrome, type BuildInputs } from './content.ts';
import { withCsp } from './csp.ts';
import { HOME_PATHS, LEGAL_PATHS, withBasePath } from './href.ts';
import { pagesOrigin, publicRepository, repositoryUrl } from './identity.ts';
import type { Lang, LandingData, LegalPage } from './types.ts';
import { LANGS } from './types.ts';

const docsRoot = new URL('../../', import.meta.url);
const QUICKSTART_FILE = new URL('content/tutoriels/quickstart.md', docsRoot);
export const STARS_FILE = new URL('landing/stars.json', docsRoot);

type PageKind = { kind: 'home'; lang: Lang } | { kind: 'legal'; lang: Lang; page: LegalPage };

/** Page d'accueil ou page juridique d'après le chemin source (`relativePath` de VitePress), sinon `undefined` : une page de doc. */
export function pageKind(relativePath: string): PageKind | undefined {
  const path = relativePath.replace(/\.md$/, '');
  for (const lang of LANGS) {
    if (path === `${HOME_PATHS[lang]}index`) return { kind: 'home', lang };
    for (const page of ['privacy', 'notice'] as const) if (path === LEGAL_PATHS[lang][page]) return { kind: 'legal', lang, page };
  }
  return undefined;
}

export type StarsFile = { stars: number; version: string | null; updatedAt: string | null };

/** Étoiles et version écrites au build (landing/stars.json) : lues, jamais demandées au navigateur (assert_landing_stars_build_time). */
export function readStars(url: URL = STARS_FILE): StarsFile {
  if (!existsSync(url)) return { stars: 0, version: null, updatedAt: null };
  return JSON.parse(readFileSync(url, 'utf8')) as StarsFile;
}

export type SiteEnv = { base: string; siteUrl: string; repository: string; compare: boolean };

/** Réglages du build : `DOCS_BASE` (défaut `/`), `DOCS_SITE_URL` (défaut : l'adresse GitHub Pages du dépôt), `LANDING_COMPARE=1` (tableau par catégories). */
export function siteEnv(env: Record<string, string | undefined> = process.env, base = '/'): SiteEnv {
  const repository = publicRepository(env);
  return { base, siteUrl: (env['DOCS_SITE_URL'] || pagesOrigin(repository)).replace(/\/+$/, ''), repository, compare: env['LANDING_COMPARE'] === '1' };
}

export function buildInputs(site: SiteEnv, quickstartSource: string = readFileSync(QUICKSTART_FILE, 'utf8'), stars: StarsFile = readStars()): BuildInputs {
  const steps = parseQuickstart(quickstartSource);
  const script = (id: string): string => {
    const step = steps.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`tutoriel « Démarrage rapide » : étape « ${id} » absente (la commande de la landing en vient)`);
    return step.script;
  };
  return { registry: loadClaims(), repository: site.repository, stars: stars.stars, version: stars.version, quickstart: { secrets: script('secrets'), start: script('start') }, compare: site.compare };
}

/** Adresse absolue d'une page du site : origine + base + chemin. */
const absoluteUrl = (site: SiteEnv, path: string): string => `${site.siteUrl}${withBasePath(site.base, path)}`;

/** Chemin de la page dans l'autre langue (même page juridique, ou l'accueil). */
const pathOf = (kind: PageKind): string => (kind.kind === 'home' ? HOME_PATHS[kind.lang] : LEGAL_PATHS[kind.lang][kind.page]);
const sibling = (kind: PageKind, lang: Lang): PageKind => (kind.kind === 'home' ? { kind: 'home', lang } : { kind: 'legal', lang, page: kind.page });

const LOCALES: Record<Lang, string> = { en: 'en_US', fr: 'fr_FR' };
const OG_IMAGE: Record<Lang, string> = { en: 'og/og-en.png', fr: 'og/og-fr.png' };
const OG_SIZE = { width: 1200, height: 630 } as const;

type HeadTag = [string, Record<string, string>, string?];

/** Balises du `head` d'une page d'accueil ou juridique : icône, canonique, hreflang réciproque avec x-default, OG, JSON-LD de l'accueil. */
export function landingHead(kind: PageKind, data: { title: string; description: string; imageAlt: string; definition?: string }, site: SiteEnv): HeadTag[] {
  const url = absoluteUrl(site, pathOf(kind));
  const image = absoluteUrl(site, OG_IMAGE[kind.lang]);
  const tags: HeadTag[] = [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: withBasePath(site.base, 'favicon.svg') }],
    ['link', { rel: 'canonical', href: url }],
    ...LANGS.map((lang): HeadTag => ['link', { rel: 'alternate', hreflang: lang, href: absoluteUrl(site, pathOf(sibling(kind, lang))) }]),
    ['link', { rel: 'alternate', hreflang: 'x-default', href: absoluteUrl(site, pathOf(sibling(kind, 'en'))) }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Scrapyomama' }],
    ['meta', { property: 'og:title', content: data.title }],
    ['meta', { property: 'og:description', content: data.description }],
    ['meta', { property: 'og:url', content: url }],
    ['meta', { property: 'og:image', content: image }],
    ['meta', { property: 'og:image:type', content: 'image/png' }],
    ['meta', { property: 'og:image:width', content: String(OG_SIZE.width) }],
    ['meta', { property: 'og:image:height', content: String(OG_SIZE.height) }],
    ['meta', { property: 'og:image:alt', content: data.imageAlt }],
    ['meta', { property: 'og:locale', content: LOCALES[kind.lang] }],
    ...LANGS.filter((lang) => lang !== kind.lang).map((lang): HeadTag => ['meta', { property: 'og:locale:alternate', content: LOCALES[lang] }]),
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: data.title }],
    ['meta', { name: 'twitter:description', content: data.description }],
    ['meta', { name: 'twitter:image', content: image }],
    ['meta', { name: 'twitter:image:alt', content: data.imageAlt }],
  ];
  if (kind.kind === 'home') {
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'Scrapyomama',
      alternateName: 'SYM',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux, macOS, Windows (Docker)',
      description: data.definition ?? data.description,
      url,
      inLanguage: kind.lang,
      isAccessibleForFree: true,
      license: repositoryUrl(site.repository, '/blob/main/LICENSE'),
      sameAs: [repositoryUrl(site.repository)],
    };
    tags.push(['script', { type: 'application/ld+json' }, JSON.stringify(jsonLd).replace(/</g, '\\u003c')]);
  }
  return tags;
}

/** Contenu injecté dans le frontmatter d'une page d'accueil ou juridique (`transformPageData`). */
export function landingData(kind: PageKind, inputs: BuildInputs): LandingData {
  const data = buildLanding(kind.lang, inputs);
  return kind.kind === 'home' ? data : { ...data, chrome: buildLegalChrome(kind.lang, kind.page, inputs) };
}

/** Preload de la police du thème de doc (Inter) : inutile sur la landing, qui a ses polices ; il alourdit la première vue. */
const INTER_PRELOAD = /\s*<link rel="preload" href="[^"]*inter-[^"]*\.woff2"[^>]*>/g;

/** HTML final d'une page d'accueil ou juridique : CSP calculée sur ses scripts en ligne, sans le preload d'Inter. */
export function transformLandingHtml(html: string): string {
  return withCsp(html.replace(INTER_PRELOAD, ''));
}

/** `sitemap.xml` : toutes les pages du site, avec les alternatives de langue (et x-default) des pages d'accueil et juridiques. */
export function buildSitemap(paths: readonly string[], site: SiteEnv): string {
  const kinds: PageKind[] = [{ kind: 'home', lang: 'en' }, { kind: 'home', lang: 'fr' }, ...LANGS.flatMap((lang) => (['privacy', 'notice'] as const).map((page): PageKind => ({ kind: 'legal', lang, page })))];
  const byPath = new Map(kinds.map((kind) => [pathOf(kind), kind]));
  const entries = [...new Set(paths)].sort().map((path) => {
    const kind = byPath.get(path);
    const links = kind
      ? [...LANGS.map((lang) => [lang, pathOf(sibling(kind, lang))] as const), ['x-default', pathOf(sibling(kind, 'en'))] as const].map(([hreflang, target]) => `    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${absoluteUrl(site, target)}"/>`)
      : [];
    return `  <url>\n    <loc>${absoluteUrl(site, path)}</loc>${links.length > 0 ? `\n${links.join('\n')}` : ''}\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`;
}

/** `robots.txt` ouvert, robots d'entraînement compris (u7 D12, à valider) ; le sitemap en adresse absolue. */
export const buildRobots = (site: SiteEnv): string => `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl(site, 'sitemap.xml')}\n`;

/** Favicon : l'icône SYM (même tracé que partout) en `fill` de jeton, sur la pastille jaune de la signature ; les couleurs sont lues dans theme.css. */
export function buildFavicon(themeCss: string, path: string, viewBox: string): string {
  const color = (name: string): string => new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(themeCss)?.[1] ?? '';
  const yellow = color('sym-yellow');
  const ink = color('sym-ink');
  if (!yellow || !ink) throw new Error('theme.css : jetons --sym-yellow et --sym-ink introuvables (favicon)');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${yellow}"/><svg x="4" y="4" width="24" height="24" viewBox="${viewBox}"><path fill="${ink}" fill-rule="evenodd" d="${path}"/></svg></svg>\n`;
}

/** Écrit un fichier en créant ses dossiers. */
export function writeFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

