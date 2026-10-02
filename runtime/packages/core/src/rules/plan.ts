// SPDX-License-Identifier: AGPL-3.0-only
// Plan d'essais guidé par les règles (tâche 2.10, 18 §3, §4.5) : le rôle `investigate` rend, en sortie structurée,
// `plan[] = { execution, network, rule_refs[] }` et `excluded[]`. Le CODE calcule l'ensemble autorisé (le plan de 04 §3.3,
// déjà filtré par la politique réseau, les proxys de l'admin et les rôles configurés) ; la règle choisit DANS cet ensemble :
// - réordonner : les couples placés par une règle effective passent en tête, dans l'ordre du plan ; le reste garde l'ordre
//   de 04 §3.3. Le RÉSEAU du premier essai reste celui du code : une règle ne fait jamais commencer sur un autre réseau
//   (X4 : seule une classe `network` fait changer de N ; 18 §4.7 : politique réseau) ;
// - restreindre : un couple exclu par une règle effective est retiré (`pruned_by_rule`, avec ses `rule_refs`) ;
// - jamais élargir : un couple hors de l'ensemble autorisé (tunnel, proxy non autorisé, niveau non servi) est ignoré et
//   journalisé `rule_widening_ignored` avec ses `rule_refs`.
// Une référence n'est effective que si elle désigne une règle INJECTÉE dans ce prompt et autre que la politique par défaut
// telle que livrée : avec la seule politique par défaut, l'ordre produit est exactement celui de 04 §3.3.
import { orderTrials, type TrialPair } from '../investigation/plan.js';
import type { Execution, Network } from '../model/enums.js';

export type RulePlanCouple = { readonly execution: Execution | string; readonly network: Network | string; readonly rule_refs: readonly string[] };
export type RulePlanProposal = { readonly plan?: readonly RulePlanCouple[] | null; readonly excluded?: readonly RulePlanCouple[] | null };

export type IgnoredCouple = { readonly execution: string; readonly network: string; readonly rule_refs: readonly string[]; readonly reason: 'outside_allowed_set' | 'network_order' };

export type RulePlanOutcome<T extends TrialPair> = {
  readonly ordered: T[];
  readonly prunedByRule: { readonly pair: T; readonly rule_refs: readonly string[] }[];
  readonly ignored: IgnoredCouple[];
  /** Couples placés par une règle (porteurs de `rule_refs` dans `run_attempts`). */
  readonly placed: Map<T, readonly string[]>;
};

const same = (p: TrialPair, c: RulePlanCouple): boolean => p.execution === c.execution && p.network === c.network;

export function applyRulePlan<T extends TrialPair>(plan: readonly T[], proposal: RulePlanProposal | undefined | null, effectiveRefs: ReadonlySet<string>): RulePlanOutcome<T> {
  const ignored: IgnoredCouple[] = [];
  const placed = new Map<T, readonly string[]>();
  const effective = (c: RulePlanCouple) => [...new Set((Array.isArray(c.rule_refs) ? c.rule_refs : []).filter((r) => typeof r === 'string' && effectiveRefs.has(r)))];
  const refsOf = (c: RulePlanCouple) => (Array.isArray(c.rule_refs) ? c.rule_refs.filter((r): r is string => typeof r === 'string').slice(0, 10) : []);

  // Restreindre.
  const prunedByRule: { pair: T; rule_refs: readonly string[] }[] = [];
  for (const c of proposal?.excluded ?? []) {
    const refs = effective(c);
    if (refs.length === 0) continue;
    for (const p of plan) if (same(p, c) && !prunedByRule.some((x) => x.pair === p)) prunedByRule.push({ pair: p, rule_refs: refs });
  }
  const excluded = new Set(prunedByRule.map((x) => x.pair));
  const rest = plan.filter((p) => !excluded.has(p));

  // Réordonner, dans l'ensemble autorisé et sur le réseau du premier essai du code.
  const firstNetwork = plan[0]?.network;
  const front: T[] = [];
  for (const c of proposal?.plan ?? []) {
    const matching = rest.filter((p) => same(p, c));
    if (!plan.some((p) => same(p, c))) {
      ignored.push({ execution: String(c.execution), network: String(c.network), rule_refs: refsOf(c), reason: 'outside_allowed_set' });
      continue;
    }
    const refs = effective(c);
    if (refs.length === 0) continue;
    if (c.network !== firstNetwork) {
      ignored.push({ execution: String(c.execution), network: String(c.network), rule_refs: refsOf(c), reason: 'network_order' });
      continue;
    }
    for (const p of matching) {
      if (front.includes(p)) continue;
      front.push(p);
      placed.set(p, refs);
    }
  }
  return { ordered: [...front, ...rest.filter((p) => !front.includes(p))], prunedByRule, ignored, placed };
}

/**
 * Rattrapage de la sélection « moins cher conforme » (18 §4.5) : couples restants STRICTEMENT moins chers que le couple
 * conforme retenu (coût inconnu : jamais moins cher), dans l'ordre de coût croissant. Ils sont essayés avant de retenir.
 */
export function cheaperPairs<T extends TrialPair>(remaining: readonly T[], than: TrialPair): T[] {
  const cost = than.est_cost_usd;
  const cheaper = remaining.filter((p) => p.est_cost_usd !== null && (cost === null || p.est_cost_usd < cost));
  return orderTrials(cheaper) as T[];
}
