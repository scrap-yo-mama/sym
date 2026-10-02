// SPDX-License-Identifier: AGPL-3.0-only
// Contenu de la landing fr/en (22 § 2.2 à 2.7). Une seule fonction pour les deux langues : chaque texte est écrit en paire
// `L(en, fr)`, de sorte que les deux pages ont la même structure, les mêmes ancres et les mêmes liens par construction
// (assert_landing_i18n_parity). Les phrases factuelles ne sont pas écrites ici : `claim(id)` les lit dans `.github/claims.json`.
// Référence de contenu : la maquette de landing validée (D-46) ; l'alignement final sur le guide de voix est fait par 3.19.
import { isReleaseVersion } from './checks.ts';
import { resolveClaim, type ClaimsRegistry } from './claims.ts';
import { renderDeployUrl, repositoryUrl } from './identity.ts';
import type { Card, Chrome, Cta, DemoMessage, FaqEntry, Href, Lang, LandingData, LandingMeta, LandingPage, LegalPage, Link } from './types.ts';

/** Entrées du build : tout ce que la landing tire de l'extérieur, injecté pour que le contenu reste une fonction pure. */
export type BuildInputs = {
  registry: ClaimsRegistry;
  /** `owner/name` (PUBLIC_REPOSITORY). */
  repository: string;
  /** Étoiles du dépôt, écrites au build (landing/stars.json) ; l'affichage commence à STARS_THRESHOLD. */
  stars: number;
  /** Dernière version publiée (landing/stars.json) ; `null` avant la première release. */
  version: string | null;
  /** Étapes du tutoriel « Démarrage rapide » rejouées par la CI (4.8) : la commande de la landing en vient. */
  quickstart: { secrets: string; start: string };
  /** Drapeau de build LANDING_COMPARE : le tableau par catégories reste éteint tant qu'un avocat ne l'a pas relu. */
  compare: boolean;
};

/** Seuil d'affichage du compteur d'étoiles (u7 D7) : jamais de nombre ridicule. */
export const STARS_THRESHOLD = 100;

const NBSP = ' ';

/** Typographie française : espace insécable avant `: ; ? !` et autour des guillemets « ». */
function typographyFr(text: string): string {
  return text
    .replace(/ ([:;?!])/g, `${NBSP}$1`)
    .replace(/« /g, `«${NBSP}`)
    .replace(/ »/g, `${NBSP}»`);
}

const doc = (path: string): Href => ({ to: 'doc', path });
const anchor = (id: string): Href => ({ to: 'anchor', id });
const external = (url: string): Href => ({ to: 'external', url });

/** Commande de démarrage : le clone, puis les deux blocs du tutoriel que la CI rejoue (4.8), octet pour octet. */
export function startCommand(inputs: BuildInputs): string {
  const url = `${repositoryUrl(inputs.repository)}.git`;
  // Seconde ligne de défense (la première : parseStars et readStars) : rien d'autre qu'une version X.Y.Z n'entre dans la commande à copier.
  if (inputs.version !== null && !isReleaseVersion(inputs.version)) throw new Error(`version de release invalide pour la commande de démarrage : ${JSON.stringify(inputs.version)}`);
  const clone = inputs.version ? `git clone --branch v${inputs.version} --depth 1 ${url}` : `git clone --depth 1 ${url}`;
  const folder = inputs.repository.split('/')[1] ?? '';
  return [clone, `cd ${folder}/runtime`, inputs.quickstart.secrets, inputs.quickstart.start].join('\n');
}

type Context = {
  lang: Lang;
  L: (en: string, fr: string) => string;
  claim: (id: string) => string;
  used: Set<string>;
  repo: (path?: string) => string;
  link: (label: string, href: Href) => Link;
};

function context(lang: Lang, inputs: BuildInputs): Context {
  const used = new Set<string>();
  return {
    lang,
    used,
    L: (en, fr) => (lang === 'en' ? en : typographyFr(fr)),
    claim: (id) => {
      used.add(id);
      const text = resolveClaim(inputs.registry, id, lang);
      return lang === 'fr' ? typographyFr(text) : text;
    },
    repo: (path = '') => repositoryUrl(inputs.repository, path),
    link: (label, href) => ({ label, href }),
  };
}

/** En-tête et pied : sur l'accueil les liens de navigation sont des ancres, ailleurs (pages juridiques) ils renvoient à l'accueil. */
function chromeOf(cx: Context, inputs: BuildInputs, where: { onHome: true } | { onHome: false; page: LegalPage }): Chrome {
  const { lang, L, claim, repo, link } = cx;
  const other: Lang = lang === 'en' ? 'fr' : 'en';
  const stars = inputs.stars >= STARS_THRESHOLD ? inputs.stars : null;
  const section = (id: string): Href => (where.onHome ? anchor(id) : { to: 'home', lang, anchor: id });
  const sibling = (target: Lang): Href => (where.onHome ? { to: 'home', lang: target } : { to: 'legal', lang: target, page: where.page });
  return {
    lang,
    skip: L('Skip to content', 'Aller au contenu'),
    labels: { mainNav: L('Main navigation', 'Navigation principale'), footerNav: L('Footer', 'Pied de page'), languages: L('Languages', 'Langues'), stars: L(' stars', ' étoiles') },
    brand: { name: 'scrapyomama', badge: 'SYM' },
    nav: [
      link(L('How it works', 'Comment ça marche'), section('comment')),
      link(L('What it can do', 'Ce qu\'il sait faire'), section('va-loin')),
      link(L('Install', 'Installer'), section('installer')),
      link(L('FAQ', 'FAQ'), section('faq')),
      link(L('Docs', 'Doc'), doc('tutoriels/quickstart')),
    ],
    github: { label: 'GitHub', href: external(repo()), stars },
    language: { label: other === 'fr' ? 'Français' : 'English', short: other.toUpperCase(), hreflang: other, href: sibling(other), aria: L('Lire cette page en français', 'Read this page in English') },
    theme: { label: L('Theme', 'Thème'), dark: L('Dark theme', 'Thème sombre'), light: L('Light theme', 'Thème clair') },
    footer: {
      links: [
        link(L('Licenses', 'Licences'), external(repo('/blob/main/LICENSE'))),
        link(L('Security', 'Sécurité'), external(repo('/blob/main/runtime/SECURITY.md'))),
        link(L('Responsible use', 'Usage responsable'), doc('explications/usage-responsable')),
        link(L('Out of scope', 'Hors périmètre'), doc('explications/hors-perimetre')),
        link(L('Privacy', 'Confidentialité'), { to: 'legal', lang, page: 'privacy' }),
        link(L('Legal notice', 'Mentions légales'), { to: 'legal', lang, page: 'notice' }),
        link('Releases', external(repo('/releases'))),
        link('llms.txt', { to: 'asset', path: 'llms.txt' }),
      ],
      languages: [
        { label: 'English', hreflang: 'en', href: sibling('en'), current: lang === 'en' },
        { label: 'Français', hreflang: 'fr', href: sibling('fr'), current: lang === 'fr' },
      ],
      notice: claim('page.no-tracker'),
      mark: 'Scrapyomama · SYM',
    },
  };
}

export function buildLanding(lang: Lang, inputs: BuildInputs): LandingData {
  const cx = context(lang, inputs);
  const { L, claim, repo, link, used } = cx;
  const chrome = chromeOf(cx, inputs, { onHome: true });

  const primary: Cta = { label: L('Deploy on Render (Render account required)', 'Déployer sur Render (compte Render requis)'), href: external(renderDeployUrl(inputs.repository)), style: 'primary' };
  const github: Cta = { label: L('View the code on GitHub', 'Voir le code sur GitHub'), href: external(repo()), style: 'outline' };

  const messages: DemoMessage[] = [
    { from: 'user', signature: false, text: L('Build me an API of the books on books.toscrape.com, with pagination: title, price, availability.', 'Fais-moi une API des livres de books.toscrape.com, avec la pagination : titre, prix, disponibilité.') },
    // Bulles de SYM : entrées du registre (22 § 2.4 et § 3.2), relues au GO contre le scénario de la démo sans clé ; replay écrit à la main en V1.
    { from: 'sym', signature: true, text: claim('demo.sym.ack') },
    { from: 'sym', signature: false, text: claim('demo.sym.robots') },
    { from: 'sym', signature: false, text: claim('demo.sym.schema') },
    { from: 'user', signature: false, text: L('OK.', 'OK.') },
    { from: 'sym', signature: true, text: claim('demo.sym.done') },
    { from: 'user', signature: false, text: L('And for un-site-qui-refuse.example (a made-up site)?', 'Et pour un-site-qui-refuse.example (site fictif) ?') },
    { from: 'sym', signature: false, text: claim('demo.sym.refusal') },
  ];

  const faq = (question: string, id: string, extra?: Link): FaqEntry => ({ question, answer: claim(id), ...(extra ? { link: extra } : {}) });

  const page: LandingPage = {
    hero: {
      eyebrow: claim('hero.eyebrow'),
      title: claim('hero.title'),
      definition: claim('hero.definition'),
      sub: claim('hero.sub'),
      ctas: [primary, github],
      command: {
        label: L('Or run it on your machine, with Docker', 'Ou lance-le sur ta machine, avec Docker'),
        text: startCommand(inputs),
        copy: L('Copy command', 'Copier la commande'),
        copied: L('Copied', 'Copié'),
        hint: claim('hero.command'),
      },
      links: [link(L('Try without a key', 'Essaie sans clé'), doc('tutoriels/quickstart')), link(L('Watch the demo (recorded)', 'Voir la démo (enregistrée)'), anchor('demo'))],
    },
    demo: {
      id: 'demo',
      title: L('Watch it work', 'Regarde-le faire'),
      you: L('You', 'Toi'),
      caption: claim('demo.recorded'),
      pause: L('Pause the animation', 'Mettre l\'animation en pause'),
      resume: L('Resume the animation', 'Reprendre l\'animation'),
      replay: L('Replay', 'Rejouer'),
      messages,
      transcript: L('Read the transcript', 'Lire la transcription'),
    },
    banner: { id: 'bandeau', hook: claim('brand.hook'), sub: claim('brand.hook.sub') },
    proof: {
      id: 'preuves',
      title: L('Proof you can check', 'Des preuves que tu peux vérifier'),
      items: [
        { text: claim('license'), link: link(L('Read the license', 'Lire la licence'), external(repo('/blob/main/LICENSE'))) },
        { text: claim('ci.in-repo'), link: link(L('Read the CI', 'Lire la CI'), external(repo('/blob/main/.github/workflows/ci.yml'))) },
        { text: claim('release.signed') },
        // Le résultat daté du contrôle de production (landing-production.yml, chaque semaine après la mise en ligne, 22 § 2.9).
        { text: claim('page.no-third-party'), link: link(L('See the dated production checks', 'Voir les contrôles datés de la production'), external(repo('/actions/workflows/landing-production.yml'))) },
      ],
    },
    how: {
      id: 'comment',
      title: L('How it works', 'Comment ça marche'),
      steps: [
        { title: L('You describe', 'Tu décris'), text: claim('how.describe') },
        { title: L('SYM investigates', 'SYM enquête'), text: claim('how.investigate') },
        { title: L('The API runs on your server', 'L\'API tourne chez toi'), text: claim('how.run') },
      ] satisfies Card[],
    },
    cost: {
      id: 'cout',
      title: L('Cheapest first', 'Le moins cher d\'abord'),
      text: claim('cost.ladder'),
      ladder: [L('Plain request', 'Requête simple'), L('Real browser', 'Vrai navigateur'), L('Agent', 'Agent')],
      replay: claim('cost.replay'),
    },
    far: {
      id: 'va-loin',
      title: L('It goes far', 'Il va loin'),
      // 22 § 2.6 : chaque phrase de « Il va loin » est une entrée relue du registre, accroche comparative comprise (garde de 22 § 4).
      hook: claim('far.hook'),
      sub: claim('far.sub'),
      cards: [
        { title: L('JavaScript pages', 'Pages en JavaScript'), text: claim('far.js') },
        { title: L('Sites with accounts', 'Sites à compte'), text: claim('far.session') },
        { title: L('Twisted sites', 'Sites tordus'), text: claim('far.agent') },
        { title: L('The site changes?', 'Le site change ?'), text: claim('far.repair') },
      ],
    },
    install: {
      id: 'installer',
      title: L('Install it', 'Installe-le'),
      cards: [
        { title: 'Render', text: claim('install.render'), prereq: L('Render account required.', 'Compte Render requis.'), result: claim('install.health'), cta: { label: L('Deploy on Render', 'Déployer sur Render'), href: external(renderDeployUrl(inputs.repository)), style: 'outline' }, guide: link(L('Render guide', 'Guide Render'), doc('guides/render')) },
        { title: 'Docker Compose', text: claim('install.docker'), prereq: claim('install.docker.memory'), result: claim('install.health'), cta: { label: L('See the command', 'Voir la commande'), href: anchor('commande'), style: 'outline' }, guide: link(L('Docker Compose guide', 'Guide Docker Compose'), doc('guides/docker-compose')) },
        { title: L('Railway (best-effort)', 'Railway (best-effort)'), text: claim('install.railway'), prereq: L('Railway account required.', 'Compte Railway requis.'), result: claim('install.health'), cta: { label: L('Railway guide', 'Guide Railway'), href: doc('guides/autres-hebergeurs'), style: 'text' }, guide: link(L('Other hosts', 'Autres hébergeurs'), doc('guides/autres-hebergeurs')) },
      ],
      mcp: { title: L('Connect your AI', 'Connecte ton IA'), text: claim('install.mcp') },
      demo: { text: claim('install.demo'), link: link(L('Try the demo without a key', 'Lance la démo sans clé'), doc('tutoriels/quickstart')) },
    },
    ...(inputs.compare
      ? {
          compare: {
            id: 'comparer' as const,
            title: L('How it compares', 'Pour comparer'),
            columns: [L('A homemade script', 'Un script maison'), L('A hosted scraping service', 'Un service de scraping hébergé'), 'SYM'],
            rows: [
              { label: claim('compare.row.hosting'), cells: [claim('compare.script.hosting'), claim('compare.service.hosting'), claim('compare.sym.hosting')] },
              { label: claim('compare.row.data'), cells: [claim('compare.script.data'), claim('compare.service.data'), claim('compare.sym.data')] },
              { label: claim('compare.row.repair'), cells: [claim('compare.script.repair'), claim('compare.service.repair'), claim('compare.sym.repair')] },
            ],
          },
        }
      : {}),
    faq: {
      id: 'faq',
      title: L('Straight questions', 'Questions franches'),
      entries: [
        faq(L('Is it free?', 'C\'est gratuit ?'), 'faq.free'),
        faq(L('Where does my data go?', 'Mes données partent où ?'), 'faq.data'),
        faq(L('Does it work on any site?', 'Ça marche sur n\'importe quel site ?'), 'faq.anysite'),
        faq(L('Is it ready?', 'C\'est prêt ?'), 'faq.ready'),
        faq(L('Do I need an account?', 'Il faut un compte ?'), 'faq.account'),
        faq(L('Which AI does it use?', 'Quelle IA ?'), 'faq.model'),
        faq(L('How much does it cost in model calls?', 'Combien ça coûte en modèle ?'), 'faq.cost'),
        faq(L('What about the AGPL in a company?', 'L\'AGPL en entreprise ?'), 'faq.agpl'),
        faq(L('Is it written with AI?', 'C\'est écrit avec de l\'IA ?'), 'faq.ai'),
        faq(L('Can I contribute?', 'Je peux contribuer ?'), 'faq.contribute', link(L('Contributing guide', 'Guide de contribution'), external(repo('/blob/main/runtime/CONTRIBUTING.md')))),
      ],
    },
    community: {
      id: 'communaute',
      title: L('Join in', 'Participe'),
      text: claim('community.where'),
      links: [
        link('Discussions', external(repo('/discussions'))),
        link(L('Good first issues', 'Bonnes premières issues'), external(repo('/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22'))),
        link(L('Roadmap', 'Feuille de route'), external(repo('/milestones'))),
        link(L('Show your API', 'Montre ton API'), external(repo('/discussions'))),
      ],
    },
  };

  const meta: LandingMeta = {
    title: L('Scrapyomama · Self-hosted data APIs over MCP', 'Scrapyomama · API de données auto-hébergées'),
    description: L(
      'Describe the data you want. SYM investigates, shows you the schema and builds an API that runs on your server. Open source, self-hosted, no account.',
      'Décris les données voulues. SYM enquête, te montre le schéma et crée une API qui tourne chez toi. Open source, auto-hébergé, sans compte.',
    ),
    imageAlt: L('Scrapyomama: describe the data, SYM handles the rest', 'Scrapyomama : décris les données, SYM s\'occupe du reste'),
  };

  return { chrome, page, meta, claims: [...used].sort() };
}

/** En-tête et pied d'une page juridique : le même chrome, avec des liens de navigation qui renvoient à l'accueil. */
export function buildLegalChrome(lang: Lang, page: LegalPage, inputs: BuildInputs): Chrome {
  return chromeOf(context(lang, inputs), inputs, { onHome: false, page });
}
