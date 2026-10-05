// SPDX-License-Identifier: AGPL-3.0-only
// Porte de l'enquête (lot A du CDC UX, 03 § 4 et § 9) : la validation automatique du schéma est la règle ; l'enquête ne
// s'arrête sur le schéma proposé que pour une raison de la liste FERMÉE ci-dessous, mesurée par le code :
// - `multiple_lists` : une seconde liste, de taille comparable (rapport au moins 0,5) et de champs différents, que le modèle
//   dit aussi pertinente pour la demande (`other_lists` de sa proposition) ; le code vérifie qu'elle existe, qu'elle est
//   exploitable, sa taille et la différence de ses champs ;
// - `requested_field_missing` : un champ que la demande nomme et qu'aucun gisement ne porte (`unmatched_fields` de la
//   proposition) ; le code retire tout nom que le schéma contient déjà ;
// - `example_mismatch` : un champ de l'exemple de sortie fourni par la personne absent du schéma proposé (comparaison de
//   noms normalisés, entièrement par le code) ;
// - `cost_above_cap` : la dépense estimée des essais (essai retenu et compilation) dépasse `CONFIRM_ABOVE_USD` (09 § 9).
// Fonctions pures, sans I/O. Aucune valeur du site : des noms de champs, des tailles, des identifiants de gisement.
import type { InvestigationProposal } from './proposal.js';
import type { DataCandidate } from './recon.js';

export const AMBIGUITY_REASONS = ['multiple_lists', 'requested_field_missing', 'example_mismatch'] as const;
export type AmbiguityReasonCode = (typeof AMBIGUITY_REASONS)[number];

export const GATE_REASONS = [...AMBIGUITY_REASONS, 'cost_above_cap'] as const;
export type GateReasonCode = (typeof GATE_REASONS)[number];

/** Raison levée, avec les seules mesures qui servent la question posée à la personne. */
export type GateReason =
  | { readonly reason: 'multiple_lists'; readonly chosen: { readonly id: string; readonly items: number }; readonly other: { readonly id: string; readonly items: number } }
  | { readonly reason: 'requested_field_missing'; readonly fields: readonly string[] }
  | { readonly reason: 'example_mismatch'; readonly fields: readonly string[] }
  | { readonly reason: 'cost_above_cap'; readonly estimate_usd: number; readonly compile_usd: number };

/** Porte écrite avec la phase `awaiting_schema_validation` (`apis.investigation.gate`), relue par le serveur. */
export type InvestigationGate = {
  readonly reasons: readonly GateReason[];
  /** Dépense estimée des essais au-delà de la reconnaissance (essai retenu et compilation), en dollars ; null si inconnue. */
  readonly estimate_usd: number | null;
  /** Seuil `CONFIRM_ABOVE_USD` au moment de la porte. */
  readonly confirm_above_usd: number | null;
};

/** Rapport minimal entre deux tailles de liste pour qu'elles soient « comparables » (03 § 4). */
export const COMPARABLE_LIST_RATIO = 0.5;
/** Au-delà de cette ressemblance de leurs champs (Jaccard), deux listes sont la même liste vue deux fois. */
const SAME_FIELDS_JACCARD = 0.8;
/** Deux gisements de voies différentes dont les tailles sont aussi proches que cela sont la même liste. */
const SAME_LIST_COUNT_RATIO = 0.9;
const MAX_FIELD_NAME = 40;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** Nom normalisé pour comparer « Agence », « agency », « agence_immo » : minuscules, lettres et chiffres seulement. */
const norm = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const propertiesOf = (schema: unknown): Record<string, unknown> => {
  const props = isRecord(schema) ? schema['properties'] : undefined;
  return isRecord(props) ? props : {};
};

/** Champs de l'exemple de la personne : clés du premier objet (exemple objet, ou premier objet d'une liste). */
export function exampleFieldNames(example: unknown): string[] {
  const first = Array.isArray(example) ? example.find(isRecord) : example;
  if (!isRecord(first)) return [];
  return Object.keys(first)
    .map((k) => k.replace(CONTROL, ' ').trim().slice(0, MAX_FIELD_NAME))
    .filter((k) => k !== '');
}

const keysOf = (c: DataCandidate): Set<string> => new Set(Object.keys(c.skeleton).map((k) => norm(k)));

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  let both = 0;
  for (const k of a) if (b.has(k)) both += 1;
  return both / (a.size + b.size - both);
};

export type AmbiguityInput = {
  readonly proposal: InvestigationProposal;
  readonly candidates: readonly DataCandidate[];
  /** Schéma de sortie construit par le code à partir de la proposition. */
  readonly outputSchema: unknown;
  /** Exemple de sortie fourni par la personne (facultatif). */
  readonly exampleOutput?: unknown;
};

/** Raisons d'ambiguïté réelle de la proposition ; liste vide : aucune question (le cas général). */
export function detectAmbiguity(input: AmbiguityInput): GateReason[] {
  const out: GateReason[] = [];
  const { proposal, candidates } = input;
  const properties = propertiesOf(input.outputSchema);
  const known = new Set(Object.keys(properties).map(norm));

  // Listes multiples : la liste choisie est celle de la première source de la proposition.
  const chosenId = proposal.sources[0]?.candidate;
  const chosen = candidates.find((c) => c.id === chosenId && c.unsupported === undefined);
  if (chosen !== undefined && chosen.count >= 2) {
    for (const id of proposal.other_lists ?? []) {
      const other = candidates.find((c) => c.id === id && c.id !== chosen.id && c.unsupported === undefined);
      if (other === undefined || other.count < 2) continue;
      const ratio = Math.min(chosen.count, other.count) / Math.max(chosen.count, other.count);
      if (ratio < COMPARABLE_LIST_RATIO) continue;
      // La MÊME liste vue par deux voies (données embarquées et blocs HTML, réponse d'API et blocs HTML) a deux gisements de
      // même taille et de noms de champs différents : ce n'est pas une seconde liste. Deux vraies listes passent par la même voie.
      if (other.from !== chosen.from && ratio >= SAME_LIST_COUNT_RATIO) continue;
      if (jaccard(keysOf(chosen), keysOf(other)) >= SAME_FIELDS_JACCARD) continue;
      out.push({ reason: 'multiple_lists', chosen: { id: chosen.id, items: chosen.count }, other: { id: other.id, items: other.count } });
      break;
    }
  }

  // Champ nommé par la demande et absent du schéma : le modèle le dit, le code retire ce que le schéma porte déjà.
  const missing = [...new Set((proposal.unmatched_fields ?? []).filter((n) => FIELD_NAME.test(n) && !known.has(norm(n))))].slice(0, 8);
  if (missing.length > 0) out.push({ reason: 'requested_field_missing', fields: missing });

  // Exemple en désaccord : un champ de l'exemple sans équivalent dans le schéma (nom normalisé, ou cité par une description).
  if (input.exampleOutput !== undefined) {
    const descriptions = Object.values(properties).map((p) => norm(isRecord(p) && typeof p['description'] === 'string' ? p['description'] : ''));
    const absent = exampleFieldNames(input.exampleOutput).filter((name) => {
      const n = norm(name);
      return n !== '' && !known.has(n) && !descriptions.some((d) => d.includes(n));
    });
    if (absent.length > 0) out.push({ reason: 'example_mismatch', fields: [...new Set(absent)].slice(0, 8) });
  }
  return out;
}

/** Entrée du plan d'essais lue par la porte de coût : trié par coût croissant (04 § 3.3), `null` : prix inconnu. */
export type CostPlanEntry = { readonly execution: string; readonly est_cost_usd: number | null };

/** Compilation d'un essai agentique en stratégie déclarative : un appel de plus du même ordre que l'essai (estimation indicative). */
export const COMPILE_ESTIMATE_FACTOR = 1;

/** Estimation de la compilation annoncée avec l'essai (`agent_fetch` seulement : les autres niveaux n'appellent aucun modèle). */
export const compileEstimateUsd = (entry: CostPlanEntry): number => (entry.execution === 'agent_fetch' && entry.est_cost_usd !== null ? Math.round(entry.est_cost_usd * COMPILE_ESTIMATE_FACTOR * 1e6) / 1e6 : 0);

/**
 * Raison de coût : la dépense estimée de l'essai le moins cher (celui que retiendrait un premier essai conforme) et de sa
 * compilation dépasse le seuil. Jamais sans seuil, ni avec un prix inconnu (l'enquête s'arrête alors avant tout appel).
 */
export function detectCostGate(plan: readonly CostPlanEntry[], confirmAboveUsd: number | undefined): GateReason | null {
  if (confirmAboveUsd === undefined || plan.length === 0) return null;
  const first = plan[0]!;
  if (first.est_cost_usd === null) return null;
  const compile = compileEstimateUsd(first);
  const total = Math.round((first.est_cost_usd + compile) * 1e6) / 1e6;
  return total > confirmAboveUsd ? { reason: 'cost_above_cap', estimate_usd: total, compile_usd: compile } : null;
}

/** `CONFIRM_ABOVE_USD` (défaut 0,10 $) : dépense estimée au-delà de laquelle une confirmation précède toute dépense ; valeur invalide : défaut. */
export function confirmAboveUsdFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env['CONFIRM_ABOVE_USD']?.trim();
  const value = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 0.1;
}
