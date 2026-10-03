// SPDX-License-Identifier: AGPL-3.0-only
// Liste blanche EXPLICITE des titres et libellés de la landing (assert_landing_claims_sourced, 22 § 2.6, 22b § 2) : dans #va-loin, #faq,
// #preuves, #comment et #cout, tout texte qui n'est pas une entrée relue de .github/claims.json doit figurer ici, mot pour mot. Une
// phrase factuelle n'a rien à faire dans cette liste : elle va au registre, avec sa preuve et sa relecture (porte du GO, reviewer human).
// Ajouter un libellé ici est un choix relu en revue de code, comme une entrée du registre.
import { normalizeText } from '../landing/claims.ts';
import type { Lang } from '../landing/types.ts';

/** Sections dont chaque texte vient du registre ou de la liste blanche (ids d'ancre, identiques dans les deux langues). */
export const STRICT_SECTIONS = ['va-loin', 'faq', 'preuves', 'comment', 'cout'] as const;

export const LANDING_LABELS: Record<Lang, readonly string[]> = {
  en: [
    // #va-loin : titre et titres des cartes.
    'It goes far',
    'JavaScript pages',
    'Sites with accounts',
    'Twisted sites',
    'The site changes?',
    // #faq : titre, questions, libellé du lien.
    'Straight questions',
    'Is it free?',
    'Where does my data go?',
    'Does it work on any site?',
    'Is it ready?',
    'Do I need an account?',
    'Which AI does it use?',
    'How much does it cost in model calls?',
    'What about the AGPL in a company?',
    'Is it written with AI?',
    'Can I contribute?',
    'Contributing guide',
    // #preuves : titre et libellés des liens.
    'Proof you can check',
    'Read the license',
    'Read the CI',
    'See the dated production checks',
    // #comment : titre et titres des étapes.
    'How it works',
    'You describe',
    'SYM investigates',
    'The API runs on your server',
    // #cout : titre et barreaux de l'échelle.
    'Cheapest first',
    'Plain request',
    'Real browser',
    'Agent',
  ],
  fr: [
    'Il va loin',
    'Pages en JavaScript',
    'Sites à compte',
    'Sites tordus',
    'Le site change ?',
    'Questions franches',
    "C'est gratuit ?",
    'Mes données partent où ?',
    "Ça marche sur n'importe quel site ?",
    "C'est prêt ?",
    'Il faut un compte ?',
    'Quelle IA ?',
    'Combien ça coûte en modèle ?',
    "L'AGPL en entreprise ?",
    "C'est écrit avec de l'IA ?",
    'Je peux contribuer ?',
    'Guide de contribution',
    'Des preuves que tu peux vérifier',
    'Lire la licence',
    'Lire la CI',
    'Voir les contrôles datés de la production',
    'Comment ça marche',
    'Tu décris',
    'SYM enquête',
    "L'API tourne chez toi",
    "Le moins cher d'abord",
    'Requête simple',
    'Vrai navigateur',
    'Agent',
  ],
};

/** Textes qui ne sont ni une entrée du registre ni un libellé de la liste blanche (comparaison après `normalizeText`). */
export function unsourced(texts: readonly string[], claims: readonly string[], labels: readonly string[]): string[] {
  const allowed = new Set([...claims, ...labels].map(normalizeText));
  return texts.filter((text) => !allowed.has(normalizeText(text)));
}

/**
 * Ce qui reste du texte visible d'une section une fois retirés les textes admis (les plus longs d'abord, pour qu'un libellé court ne
 * morde pas dans une entrée du registre) : vide si la section ne porte rien d'autre.
 */
export function unsourcedRemainder(text: string, allowed: readonly string[]): string {
  let rest = normalizeText(text);
  for (const entry of [...new Set(allowed.map(normalizeText))].sort((a, b) => b.length - a.length)) rest = rest.split(entry).join(' ');
  return normalizeText(rest);
}
