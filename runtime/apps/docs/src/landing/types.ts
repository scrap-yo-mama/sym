// SPDX-License-Identifier: AGPL-3.0-only
// Types de la landing (22 § 2) : un contenu par langue, mêmes sections, mêmes ancres, mêmes liens. Le contenu est calculé au
// build (Node) et passé à la page par `transformPageData` (frontmatter) : le navigateur ne lit ni le registre ni les fichiers.

export type Lang = 'en' | 'fr';
export const LANGS: readonly Lang[] = ['en', 'fr'];

/** Cible d'un lien, résolue avec le chemin de base du site au rendu (`hrefOf`). */
export type Href =
  | { to: 'anchor'; id: string }
  /** Page du site de doc (français) : rechargement complet, pour que la CSP de la page d'arrivée s'applique. */
  | { to: 'doc'; path: string }
  | { to: 'home'; lang: Lang; anchor?: string }
  | { to: 'legal'; lang: Lang; page: LegalPage }
  /** Fichier du site (llms.txt, flux). */
  | { to: 'asset'; path: string }
  | { to: 'external'; url: string };

export type LegalPage = 'privacy' | 'notice';

export type Link = { label: string; href: Href };

/** Un seul bouton plein par vue : `primary` ; les autres liens sont `outline` ou `text`. */
export type Cta = Link & { style: 'primary' | 'outline' | 'text' };

export type Chrome = {
  lang: Lang;
  /** Nom d'un lien d'évitement. */
  skip: string;
  /** Noms accessibles des repères et libellé du compteur d'étoiles (lus par les lecteurs d'écran). */
  labels: { mainNav: string; footerNav: string; languages: string; stars: string };
  brand: { name: string; badge: string };
  nav: Link[];
  github: Link & { stars: number | null };
  language: { label: string; short: string; hreflang: Lang; href: Href; aria: string };
  theme: { label: string; dark: string; light: string };
  footer: {
    links: Link[];
    languages: { label: string; hreflang: Lang; href: Href; current: boolean }[];
    notice: string;
    mark: string;
  };
};

export type DemoMessage = {
  /** `user` (toi) ou `sym` ; `sym` + `signature` : la voix de SYM, avec l'icône de marque. */
  from: 'user' | 'sym';
  signature: boolean;
  text: string;
};

export type Card = { title: string; text: string };

export type FaqEntry = { question: string; answer: string; link?: Link };

export type LandingPage = {
  hero: {
    eyebrow: string;
    title: string;
    /** Définition en première phrase (GEO) : lue par les moteurs et reprise par la description. */
    definition: string;
    sub: string;
    ctas: Cta[];
    command: { label: string; text: string; copy: string; copied: string; hint: string };
    links: Link[];
  };
  demo: { id: 'demo'; title: string; you: string; caption: string; pause: string; resume: string; replay: string; messages: DemoMessage[]; transcript: string };
  banner: { id: 'bandeau'; hook: string; sub: string };
  proof: { id: 'preuves'; title: string; items: { text: string; link?: Link }[] };
  how: { id: 'comment'; title: string; steps: Card[] };
  cost: { id: 'cout'; title: string; text: string; ladder: string[]; replay: string };
  far: { id: 'va-loin'; title: string; hook: string; sub: string; cards: Card[] };
  install: {
    id: 'installer';
    title: string;
    cards: { title: string; text: string; prereq: string; result: string; cta: Cta; guide: Link }[];
    mcp: Card;
    demo: { text: string; link: Link };
  };
  /** Absent tant que le drapeau de build LANDING_COMPARE est éteint (relecture d'un avocat, GO). */
  compare?: { id: 'comparer'; title: string; columns: string[]; rows: { label: string; cells: string[] }[] };
  faq: { id: 'faq'; title: string; entries: FaqEntry[] };
  community: { id: 'communaute'; title: string; text: string; links: Link[] };
};

export type LandingMeta = {
  title: string;
  description: string;
  /** Texte alternatif de l'image sociale. */
  imageAlt: string;
};

/** Ce que `transformPageData` écrit dans le frontmatter d'une page d'accueil. */
export type LandingData = { chrome: Chrome; page: LandingPage; meta: LandingMeta; claims: string[] };
