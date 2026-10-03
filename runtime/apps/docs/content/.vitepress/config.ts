// SPDX-License-Identifier: AGPL-3.0-only
// Configuration VitePress du site de doc (16 § 4). Sortie statique dans apps/docs/dist, sans ressource externe : aucune
// police ni script d'un tiers, recherche Pagefind servie par le site lui-même. `DOCS_BASE` règle le préfixe des liens
// (défaut `/`) pour un hébergement dans un sous-chemin.
import { defineConfig } from 'vitepress';
import { PAGES, QUADRANTS } from '../../src/nav.ts';
import { rewriteRepoHref } from '../../src/landing/href.ts';
import { buildInputs, landingData, landingHead, pageKind, siteEnv, transformLandingHtml } from '../../src/landing/site.ts';
import type { LandingData } from '../../src/landing/types.ts';
import { normalizeBase, outDirName, SITE_SUMMARY, SITE_TITLE } from '../../src/site.ts';

const base = normalizeBase(process.env['DOCS_BASE']);
const site = siteEnv(process.env, base);
const inputs = buildInputs(site);

/**
 * Thème clair ou sombre de la doc : vueuse (useDark) écrit la valeur par défaut dans le stockage local dès le démarrage et injecte une
 * balise <style> pour couper les transitions, deux choses que la landing s'interdit (aucune écriture avant une action, CSP
 * `style-src 'self'`). La doc les garde moins la balise <style> ; l'accueil et les pages juridiques n'instancient pas useDark (leur
 * bascule de thème écrit seulement après un clic) : `appearance: false` par route, hors des dossiers de la doc.
 */
const DOC_APPEARANCE = { initialValue: 'auto', disableTransition: false } as const;
/** Une surcharge par route : la doc (français) garde son thème ; le reste (accueil, pages juridiques, 404) n'a pas de useDark. */
const docRoute = { lang: 'fr-FR', appearance: DOC_APPEARANCE } as Record<string, unknown>;
const landingRoute = { appearance: false } as Record<string, unknown>;

const sidebar = QUADRANTS.map((quadrant) => ({
  text: quadrant.title,
  collapsed: false,
  items: PAGES.filter((page) => page.quadrant === quadrant.id).map((page) => ({ text: page.title, link: `/${page.path}` })),
}));

const first = (quadrant: string): string => `/${PAGES.find((page) => page.quadrant === quadrant)?.path ?? ''}`;

export default defineConfig({
  // Accueil et pages juridiques anglais à la racine ; la doc (français) et la landing française ont leur langue par dossier.
  lang: 'en',
  additionalConfig: { '/': landingRoute, '/fr/': { lang: 'fr' }, '/tutoriels/': docRoute, '/guides/': docRoute, '/reference/': docRoute, '/explications/': docRoute },
  title: SITE_TITLE,
  description: SITE_SUMMARY,
  base,
  // <Content> pose par défaut un attribut style="position:relative" sur son conteneur : la CSP de la landing l'interdit. Une classe fait le même travail.
  // Pas de préchargement des pages liées : sur la landing il alourdirait la première vue (JS des pages de doc, budget de poids) pour un
  // bénéfice nul ; la doc s'en passe sans gêne (pages légères, servies par GitHub Pages).
  router: { prefetchLinks: false },
  contentProps: { class: 'vp-content-root' },
  appearance: DOC_APPEARANCE,
  // DOCS_OUT_DIR : dossier de sortie sous apps/docs (défaut dist) ; la préproduction de la landing construit à part (dist-preprod).
  outDir: `../${outDirName()}`,
  cleanUrls: true,
  lastUpdated: false,
  // Aucun lien mort toléré : la construction échoue (et le vérificateur de liens contrôle le site construit).
  ignoreDeadLinks: false,
  // Liens `repo:/chemin` des pages Markdown (pages juridiques : LICENSE, TRADEMARK.md) : résolus vers le dépôt public (PUBLIC_REPOSITORY),
  // jamais écrits en dur dans une page (22b § 1).
  markdown: {
    config(md) {
      md.core.ruler.push('sym-repo-links', (state) => {
        for (const token of state.tokens) {
          for (const child of token.children ?? []) {
            const href = child.type === 'link_open' ? child.attrGet('href') : null;
            if (href) child.attrSet('href', rewriteRepoHref(href, site.repository));
          }
        }
      });
    },
  },
  head: [['link', { rel: 'alternate', type: 'text/plain', href: `${base}llms.txt`, title: 'llms.txt' }]],
  // Accueil et pages juridiques : contenu, titre et description calculés au build (frontmatter), en-tête et pied propres.
  transformPageData(pageData) {
    const kind = pageKind(pageData.relativePath);
    if (!kind) return;
    const data = landingData(kind, inputs);
    pageData.frontmatter['chrome'] = data.chrome;
    if (kind.kind === 'home') {
      pageData.frontmatter['landing'] = data;
      pageData.title = data.meta.title;
      pageData.description = data.meta.description;
    }
    pageData.titleTemplate = false;
  },
  transformHead({ pageData }) {
    const kind = pageKind(pageData.relativePath);
    if (!kind) return [];
    const data = landingData(kind, inputs);
    const landing = pageData.frontmatter['landing'] as LandingData | undefined;
    return landingHead(kind, { title: pageData.title, description: pageData.description, imageAlt: data.meta.imageAlt, ...(landing ? { definition: landing.page.hero.definition } : {}) }, site);
  },
  // La CSP est une balise meta calculée sur le HTML final (empreintes sha256 des scripts en ligne), posée sur la landing seulement.
  transformHtml(code, _id, context) {
    return pageKind(context.page) ? transformLandingHtml(code) : undefined;
  },
  themeConfig: {
    siteTitle: SITE_TITLE,
    nav: QUADRANTS.map((quadrant) => ({ text: quadrant.title, link: first(quadrant.id), activeMatch: `/${quadrant.id}/` })),
    sidebar,
    outline: { level: [2, 3], label: 'Sur cette page' },
    docFooter: { prev: 'Page précédente', next: 'Page suivante' },
    returnToTopLabel: 'Haut de page',
    sidebarMenuLabel: 'Menu',
    darkModeSwitchLabel: 'Apparence',
    lightModeSwitchTitle: 'Passer au thème clair',
    darkModeSwitchTitle: 'Passer au thème sombre',
    skipToContentLabel: 'Aller au contenu',
    notFound: { title: 'Page introuvable', quote: 'Cette page n’existe pas ou a changé de place.', linkLabel: 'Retour à l’accueil', linkText: 'Retour à l’accueil', code: '404' },
    footer: { message: 'Licence AGPL-3.0 pour le cœur, MIT pour le client et les schémas. Ce site ne contient aucun traceur.' },
  },
});
