// SPDX-License-Identifier: AGPL-3.0-only
// Promotion d'un indice vérifié en règle de domaine (tâche 2.14, 19c § 6, D-48) : la PREUVE est un événement
// `brief_hint_verified` pour le moteur de propositions de 2.11 (aucun moteur nouveau) ; le texte d'une proposition naît d'un
// GABARIT FERMÉ à partir de faits du code (hôte, gabarit de chemin, date de vérification, nombre d'items), jamais du texte
// libre du dossier (`notes`, `pitfall`) : il entrerait sinon dans `<trusted_rules>`. Acceptation en console seulement
// (`403 human_confirmation_required` en MCP et par clé, porté par 2.11 et 3.13).

/** Types éligibles (19c § 6) : pas `selector` (trop volatil), pas `pitfall`. */
export const BRIEF_PROMOTABLE_KINDS = ['endpoint', 'embedded_data', 'pagination'] as const;
const PATH_TEMPLATE = /^[A-Za-z0-9/_.{}-]{1,60}$/;

export type BriefRuleFacts = {
  readonly kind: string;
  /** Domaine enregistrable de l'API : `applies_to`, jamais `*`. */
  readonly domain: string;
  readonly host: string;
  /** Gabarit de chemin (donnée non fiable venue de `value`) : jeu de caractères restreint, 60 caractères au plus. */
  readonly pathTemplate: string;
  readonly verifiedAt: string;
  readonly items: number | null;
};

export type BriefRuleProposal = { readonly applies_to: string; readonly origin: 'proposal'; readonly to_review: true; readonly body: string };

/** Proposition fermée, ou `null` (type non éligible, gabarit hors bornes, domaine vide ou joker). */
export function briefRuleProposal(facts: BriefRuleFacts): BriefRuleProposal | null {
  if (!(BRIEF_PROMOTABLE_KINDS as readonly string[]).includes(facts.kind)) return null;
  if (!PATH_TEMPLATE.test(facts.pathTemplate) || facts.pathTemplate.includes('..')) return null;
  if (facts.domain === '' || facts.domain.includes('*') || !/^[a-z0-9.-]{1,253}$/.test(facts.domain) || !/^[a-z0-9.-]{1,253}$/.test(facts.host)) return null;
  const day = /^\d{4}-\d{2}-\d{2}/.exec(facts.verifiedAt)?.[0];
  if (day === undefined) return null;
  const items = facts.items === null ? '' : `, ${Math.max(0, Math.trunc(facts.items))} items`;
  const label = facts.kind === 'endpoint' ? 'JSON endpoint' : facts.kind === 'embedded_data' ? 'embedded data' : 'pagination';
  return {
    applies_to: facts.domain,
    origin: 'proposal',
    to_review: true,
    body: `On ${facts.host}, try first the ${label} \`${facts.pathTemplate}\` (checked by SYM on ${day}${items}).`,
  };
}

/**
 * Comptage de la preuve (19c § 6) : un seul événement par `identity_key` et par jour, et seulement depuis un RUN RÉEL
 * (enquête, rejeu ou réparation qui a utilisé l'indice), jamais d'une sonde rejouée ni d'un renvoi du même dossier.
 */
export function shouldEmitHintVerified(args: { readonly fromRealRun: boolean; readonly identityKey: string; readonly day: string; readonly emitted: ReadonlySet<string> }): boolean {
  return args.fromRealRun && !args.emitted.has(`${args.identityKey}:${args.day}`);
}
