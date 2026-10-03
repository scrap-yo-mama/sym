// SPDX-License-Identifier: AGPL-3.0-only
// `side_effect` d'une étape (19 §4, tâche 2.13) : CALCULÉ PAR LE CODE, jamais déclaré par un LLM. Heuristiques fermées :
// soumission de formulaire ou requête de méthode autre que GET observée → `write` ; `goto` → `navigation` ; défilement,
// attente, extraction → `none` ; clic sur un lien → `navigation` ; clic sur un bouton hors pagination reconnue → `write` ;
// `type` ou `select` dans un formulaire (ou sans savoir) → `write`. Dans le doute, `write`.

export const STEP_SIDE_EFFECTS = ['none', 'navigation', 'write'] as const;
export type StepSideEffect = (typeof STEP_SIDE_EFFECTS)[number];

/** Ce que le rejeu a vu pendant l'étape (hôte du bac à sable) : il l'emporte toujours sur la forme de l'étape. */
export type SideEffectObservation = {
  /** Requêtes de méthode autre que GET, HEAD ou OPTIONS émises pendant l'étape (document, XHR, fetch, beacon). */
  readonly nonGetRequests?: number;
  /** Soumission de formulaire constatée (navigation hors GET, coupée ou non). */
  readonly formSubmitted?: boolean;
};

/** Forme d'une étape suffisante au calcul (la cible est sémantique : rôle + nom, ou texte). */
export type SideEffectInput = {
  readonly op: string;
  readonly target?: { readonly role?: string; readonly name?: string; readonly text?: string } | undefined;
  /** L'élément visé est-il dans un `form` ? `undefined` : inconnu (donc `write` pour `type` et `select`). */
  readonly form?: boolean | undefined;
};

/**
 * Noms de pagination reconnus (fr, en) : suivant, précédent, page N, charger plus. Comparés au nom accessible entier,
 * espaces et flèches retirés : « Supprimer la page » n'en est pas un.
 */
const PAGINATION_NAMES = [
  /^(page )?suivante?$/,
  /^(page )?pr[ée]c[ée]dente?$/,
  /^next( page)?$/,
  /^prev(ious)?( page)?$/,
  /^(page )?\d{1,4}$/,
  /^(charger|afficher|voir) plus( de r[ée]sultats)?$/,
  /^(load|show|see) more( results)?$/,
  /^plus de r[ée]sultats$/,
  /^more results$/,
];

export function isPaginationName(name: string): boolean {
  const n = name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[›»→←‹«<>…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n !== '' && PAGINATION_NAMES.some((re) => re.test(n));
}

const RANK: Record<StepSideEffect, number> = { none: 0, navigation: 1, write: 2 };

/** Le plus fort des deux effets (le code ne fait jamais qu'élever un effet déclaré). */
export function maxSideEffect(a: StepSideEffect, b: StepSideEffect): StepSideEffect {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Rôles dont un clic ne fait que montrer un contenu de la même page (aucun envoi). */
const VIEW_ROLES = new Set(['tab', 'treeitem']);

export function computeSideEffect(step: SideEffectInput, observed: SideEffectObservation = {}): StepSideEffect {
  if ((observed.nonGetRequests ?? 0) > 0 || observed.formSubmitted === true) return 'write';
  switch (step.op) {
    case 'goto':
      return 'navigation';
    case 'scroll':
    case 'wait_for':
    case 'extract':
      return 'none';
    case 'type':
    case 'select':
      return step.form === false ? 'none' : 'write';
    case 'click': {
      const role = step.target?.role;
      const name = step.target?.name ?? '';
      if (role === 'link') return 'navigation';
      if (role !== undefined && VIEW_ROLES.has(role)) return 'none';
      if ((role === 'button' || role === 'menuitem') && isPaginationName(name)) return 'navigation';
      // Bouton (ou rôle inconnu, cible par texte) hors pagination reconnue : peut soumettre.
      return 'write';
    }
    default:
      return 'write';
  }
}
