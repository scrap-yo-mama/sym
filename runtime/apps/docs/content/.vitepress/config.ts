// SPDX-License-Identifier: AGPL-3.0-only
// Configuration VitePress du site de doc (16 § 4). Sortie statique dans apps/docs/dist, sans ressource externe : aucune
// police ni script d'un tiers, recherche Pagefind servie par le site lui-même. `DOCS_BASE` règle le préfixe des liens
// (défaut `/`) pour un hébergement dans un sous-chemin.
import { defineConfig } from 'vitepress';
import { PAGES, QUADRANTS } from '../../src/nav.ts';
import { normalizeBase, SITE_SUMMARY, SITE_TITLE } from '../../src/site.ts';

const base = normalizeBase(process.env['DOCS_BASE']);

const sidebar = QUADRANTS.map((quadrant) => ({
  text: quadrant.title,
  collapsed: false,
  items: PAGES.filter((page) => page.quadrant === quadrant.id).map((page) => ({ text: page.title, link: `/${page.path}` })),
}));

const first = (quadrant: string): string => `/${PAGES.find((page) => page.quadrant === quadrant)?.path ?? ''}`;

export default defineConfig({
  lang: 'fr-FR',
  title: SITE_TITLE,
  description: SITE_SUMMARY,
  base,
  outDir: '../dist',
  cleanUrls: true,
  lastUpdated: false,
  // Aucun lien mort toléré : la construction échoue (et le vérificateur de liens contrôle le site construit).
  ignoreDeadLinks: false,
  head: [['link', { rel: 'alternate', type: 'text/plain', href: `${base}llms.txt`, title: 'llms.txt' }]],
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
