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
