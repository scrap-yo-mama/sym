// SPDX-License-Identifier: AGPL-3.0-only
// Adresses de la landing : chemins des pages (relatifs au chemin de base du site) et résolution d'un `Href`. Pur : utilisé par
// le rendu (navigateur et serveur), par la configuration VitePress (head, sitemap) et par les tests.
import type { Href, Lang, LegalPage } from './types.ts';

/** Page d'accueil par langue : l'anglais à `/`, le français à `/fr/` (22 § 2.1). */
export const HOME_PATHS: Record<Lang, string> = { en: '', fr: 'fr/' };

/** Pages juridiques propres à la landing, par langue (22 § 2.11). */
export const LEGAL_PATHS: Record<Lang, Record<LegalPage, string>> = {
  en: { privacy: 'legal/privacy', notice: 'legal/legal-notice' },
  fr: { privacy: 'fr/legal/confidentialite', notice: 'fr/legal/mentions-legales' },
};

/** Langue de la version qui fait foi (22b : « En cas de divergence, la version … fait foi »), à décider avec l'avocat. */
export const LEGAL_REFERENCE_LANGUAGE: Lang = 'fr';

/** Préfixe `base` (« /sym/ ») + chemin (« fr/ ») → « /sym/fr/ ». */
export const withBasePath = (base: string, path: string): string => `${base.endsWith('/') ? base : `${base}/`}${path.replace(/^\/+/, '')}`;

/**
 * Adresses qui servent chaque page de la landing sous `base`, pour `_headers` du repli Cloudflare Pages (22 § 2.9) : l'URL propre et le
 * fichier lui-même (`index.html` d'un dossier, `.html` d'une page), sinon une page jointe par son fichier perd en silence frame-ancestors
 * et nosniff. `base` est celle du build (DOCS_BASE) : le repli construit le site avec le chemin qu'il sert (`/` à la racine d'un domaine),
 * les liens et `_headers` en dérivent ensemble.
 */
export function landingHeaderPaths(base: string): string[] {
  const pages = [...Object.values(HOME_PATHS), ...Object.values(LEGAL_PATHS).flatMap((legal) => Object.values(legal))];
  return pages.flatMap((path) => {
    const clean = withBasePath(base, path);
    return [clean, path === '' || path.endsWith('/') ? `${clean}index.html` : `${clean}.html`];
  });
}

/** Chemin (sans base) vers lequel pointe un lien interne ; `undefined` pour une ancre ou un lien externe. */
export function internalPath(href: Href): string | undefined {
  switch (href.to) {
    case 'doc':
      return href.path;
    case 'home':
      return HOME_PATHS[href.lang];
    case 'legal':
      return LEGAL_PATHS[href.lang][href.page];
    case 'asset':
      return href.path;
    default:
      return undefined;
  }
}

export function hrefOf(href: Href, base: string): string {
  if (href.to === 'anchor') return `#${href.id}`;
  if (href.to === 'external') return href.url;
  return `${withBasePath(base, internalPath(href) ?? '')}${href.to === 'home' && href.anchor ? `#${href.anchor}` : ''}`;
}

/** Un lien vers une autre page du site se charge en entier (pas de navigation du routeur) : la balise CSP de la page d'arrivée s'applique. */
export const isFullLoad = (href: Href): boolean => href.to !== 'anchor' && href.to !== 'external';

/** Schéma des liens « vers le dépôt public » des pages Markdown (`[LICENSE](repo:/blob/main/LICENSE)`), résolus au build depuis PUBLIC_REPOSITORY. */
const REPO_SCHEME = 'repo:';

/** `repo:/chemin` → `https://github.com/<PUBLIC_REPOSITORY>/chemin` ; tout autre lien est rendu tel quel. */
export const rewriteRepoHref = (href: string, repository: string): string => (href.startsWith(REPO_SCHEME) ? `https://github.com/${repository}${href.slice(REPO_SCHEME.length)}` : href);

/**
 * La page servie à `pathname` est-elle une page de la landing (accueil ou page juridique) ? Sert au routeur : passer de la doc à la
 * landing (ou l'inverse) recharge la page en entier, pour que la balise CSP de la page d'arrivée s'applique et que le thème de la doc
 * (useDark, qui écrit dans le stockage local dès son démarrage) ne vive jamais sur une page de la landing.
 */
export function isLandingPathname(pathname: string, base: string): boolean {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  if (!pathname.startsWith(prefix) && `${pathname}/` !== prefix) return false;
  const path = pathname.slice(prefix.length).replace(/\.html$/, '').replace(/(^|\/)index$/, '$1');
  const landing = [...Object.values(HOME_PATHS), ...Object.values(LEGAL_PATHS).flatMap((pages) => Object.values(pages))];
  return landing.includes(path) || landing.includes(`${path}/`);
}
