// SPDX-License-Identifier: AGPL-3.0-only
// Ordre d'essai de l'enquête (tâche 2.1, 04 §2 et §3.3, INV2) : coût estimé par run de chaque couple (E, N) autorisé,
// tri par coût croissant puis par E puis par N, élagage par le classifieur. Fonctions pures, sans I/O.
//
//   est_cost_usd(E, N) = llm_tokens(E) × prix_modèle(rôle)        // 0 pour E1-E3
//                      + octets(E) × prix_go(N) / 1e9              // 0 pour N1 et T
//                      + secondes(E) × COMPUTE_USD_PER_S            // défaut 0,00005 $ (à valider)
//
// Élagage (04 §3.3) : `network` → on saute les couples restants du même N ; `extraction` → ceux du même E (pour la même
// source de données : un autre gisement est une autre stratégie) ; toute autre classe garde le réseau courant (échelle
// de 1.4 : seule `network` change de N, X4) ; un 429 arrête les essais (ralentir, jamais monter en E ni en N) ;
// `blocked_by_protection`, `forbidden`,
// `robots_disallowed` → arrêt ; `auth_required`, `payment_required`, `account_limit` → `action_requise`. Aucun élagage
// n'ajoute un couple : l'ensemble essayable est fixé par le code (politique réseau de l'API, proxys de l'admin), jamais
// élargi (pas de tunnel ni de proxy résidentiel après un refus, X3, X4).
import { failureRoute } from '../exec/guard.js';
import { EXECUTIONS, NETWORKS, type Execution, type FailureClass, type Network } from '../model/enums.js';

/** Coût de calcul par seconde d'essai (04 §3.3, « à valider »). */
export const COMPUTE_USD_PER_S = 0.00005;

/**
 * Durées et volumes de référence par niveau d'exécution, faute de mesure (à valider en recette, 11) : secondes d'un
 * run, facteur d'octets d'un navigateur (sous-ressources) et jetons d'un essai agentique.
 */
export const EXECUTION_PROFILE: Readonly<Record<Execution, { readonly seconds: number; readonly llm: 'extract' | 'agent' | null; readonly tokensIn: number; readonly tokensOut: number }>> = Object.freeze({
  fetch: { seconds: 1, llm: null, tokensIn: 0, tokensOut: 0 },
  fetch_in_page: { seconds: 5, llm: null, tokensIn: 0, tokensOut: 0 },
  playwright: { seconds: 8, llm: null, tokensIn: 0, tokensOut: 0 },
  agent_fetch: { seconds: 6, llm: 'extract', tokensIn: 0, tokensOut: 1_500 },
  hybrid: { seconds: 30, llm: 'agent', tokensIn: 8_000, tokensOut: 1_000 },
  agent: { seconds: 60, llm: 'agent', tokensIn: 40_000, tokensOut: 4_000 },
});

/** Prix d'un modèle en USD par million de jetons (forme de `ModelPrice` de la couche LLM). */
export type TokenPrice = { readonly in: number; readonly out: number };

export type CostInputs = {
  /** Octets mesurés à la reconnaissance pour CE couple (réponse de données, document, sous-ressources). */
  readonly bytes: number;
  /** Pages par run (1 sans pagination mesurée). */
  readonly pages: number;
  /** Jetons d'entrée mesurés (texte de page pour E4) ; défaut : profil du niveau. */
  readonly tokensIn?: number;
  /** Prix au Go du réseau : 0 pour `direct` et `tunnel`, prix du proxy BYO sinon. */
  readonly perGbUsd: number;
  /** Prix du modèle du rôle (`extract` pour E4, `agent` pour E5-E6) ; `null` : inconnu. */
  readonly llmPrice: TokenPrice | null;
  readonly computeUsdPerS?: number;
};

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * Coût estimé d'un run sur le couple (E, N) (04 §3.3). `null` : prix du modèle inconnu pour un niveau agentique
 * (le coût ne se devine pas : jamais 0, 08 §1) ; un tel couple passe après tous les couples chiffrés.
 */
export function estimateCostUsd(execution: Execution, network: Network, inputs: CostInputs): number | null {
  const profile = EXECUTION_PROFILE[execution];
  const pages = Math.max(1, Math.floor(inputs.pages));
  let llm = 0;
  if (profile.llm !== null) {
    if (inputs.llmPrice === null) return null;
    const tokensIn = (inputs.tokensIn ?? profile.tokensIn) * pages;
    llm = (tokensIn * inputs.llmPrice.in + profile.tokensOut * pages * inputs.llmPrice.out) / 1e6;
  }
  const perGb = network === 'direct' || network === 'tunnel' ? 0 : Math.max(0, inputs.perGbUsd);
  const bytes = (Math.max(0, inputs.bytes) * pages * perGb) / 1e9;
  const compute = profile.seconds * pages * (inputs.computeUsdPerS ?? COMPUTE_USD_PER_S);
  return round6(llm + bytes + compute);
}

/** Un couple à essayer : niveau d'exécution, réseau, gisement de données (`source`) et coût estimé. */
export type TrialPair = {
  readonly execution: Execution;
  readonly network: Network;
  /** Identifiant du gisement (`c1`, …) ou de la voie agentique (`page`) : deux gisements sont deux stratégies. */
  readonly source: string;
  readonly est_cost_usd: number | null;
};

const rank = <T>(list: readonly T[], value: T): number => list.indexOf(value);

/** Tri de 04 §3.3 : `est_cost_usd` croissant (inconnu en dernier), puis E, puis N, puis l'ordre des gisements. */
export function orderTrials(pairs: readonly TrialPair[], sourceOrder: readonly string[] = []): TrialPair[] {
  const sourceRank = (source: string): number => {
    const i = sourceOrder.indexOf(source);
    return i === -1 ? sourceOrder.length : i;
  };
  return [...pairs].sort((a, b) => {
    const ca = a.est_cost_usd ?? Number.POSITIVE_INFINITY;
    const cb = b.est_cost_usd ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    const e = rank(EXECUTIONS, a.execution) - rank(EXECUTIONS, b.execution);
    if (e !== 0) return e;
    const n = rank(NETWORKS, a.network) - rank(NETWORKS, b.network);
    if (n !== 0) return n;
    return sourceRank(a.source) - sourceRank(b.source);
  });
}

/** Suite de l'enquête après l'échec d'un couple. */
export type PruneDecision =
  /** Couple suivant (après élagage éventuel). */
  | { readonly next: 'continue'; readonly pruned: readonly TrialPair[] }
  /** Refus ou défi (INV6, statut `bloquee`), 429, échec LLM sans repli : arrêt de toute escalade ; le statut suit la classe. */
  | { readonly next: 'stop'; readonly pruned: readonly TrialPair[] }
  /** La main revient à l'utilisateur (connexion, paiement, limite de compte) : `action_requise`. */
  | { readonly next: 'action_required'; readonly pruned: readonly TrialPair[] };

const samePair = (a: TrialPair, b: TrialPair): boolean => a.execution === b.execution && a.network === b.network && a.source === b.source;

/**
 * Élagage de 04 §3.3 après l'échec de `failed` (classe `cls`) : les couples restants qu'on saute, et la suite.
 * Un arrêt ou une action requise élague tout le reste (aucun essai après la détection, en particulier aucun autre réseau).
 */
export function pruneAfter(cls: FailureClass, failed: TrialPair, remaining: readonly TrialPair[]): PruneDecision {
  const route = failureRoute(cls);
  const rest = remaining.filter((p) => !samePair(p, failed));
  if (route.next === 'stop' && cls !== 'run_budget_exceeded' && cls !== 'budget_exceeded') return { next: 'stop', pruned: rest };
  if (route.next === 'action_required') return { next: 'action_required', pruned: rest };
  if (route.next === 'abstain') return { next: 'stop', pruned: rest };
  // 429 (04 §7 « ralentir », X4) : ni un autre réseau, ni un niveau plus cher qui solliciterait davantage le même site.
  // Les essais s'arrêtent là, comme la passe de reconnaissance (l'enquête se termine sans stratégie conforme).
  if (route.next === 'slow_down') return { next: 'stop', pruned: rest };
  if (cls === 'network') return { next: 'continue', pruned: rest.filter((p) => p.network === failed.network) };
  // Toute autre classe garde le réseau courant (échelle de 1.4 et X4 : seule `network` fait changer de N) : les couples
  // d'un autre N sont élagués. Écart à la lettre de 04 §3.3 (qui n'élague que le même E après `extraction`), à consigner
  // au journal des décisions et à transcrire dans `escalade-par-defaut.md` (2.10).
  return {
    next: 'continue',
    pruned: rest.filter((p) => p.network !== failed.network || (cls === 'extraction' && p.execution === failed.execution && p.source === failed.source)),
  };
}

/**
 * Contrôle d'INV2 sur une suite d'essais journalisés (`run_attempts` dans l'ordre) : coûts estimés croissants (au sens
 * large ; un coût inconnu ne précède jamais un coût connu). Rend l'indice du premier écart, ou `-1`.
 */
export function firstCostInversion(estimates: readonly (number | null)[]): number {
  for (let i = 1; i < estimates.length; i += 1) {
    const prev = estimates[i - 1] ?? Number.POSITIVE_INFINITY;
    const cur = estimates[i] ?? Number.POSITIVE_INFINITY;
    if (cur < prev) return i;
  }
  return -1;
}

/**
 * Contrôle STRICT d'INV2 (04 §3.3, « la suite est strictement celle-ci ») : les couples essayés (`run_attempts`, dans
 * l'ordre) suivent l'ordre du plan (coût, puis E, puis N, puis gisement) et tout couple du plan sauté avant le dernier
 * essai a été élagué (`attempt.pruned`). Rend l'indice du premier essai fautif (hors plan, à rebours, ou précédé d'un
 * couple ni essayé ni élagué), ou `-1`.
 */
export function attemptsFollowPlan(plan: readonly TrialPair[], attempts: readonly TrialPair[], pruned: readonly TrialPair[]): number {
  const indexOf = (p: TrialPair) => plan.findIndex((q) => samePair(p, q));
  const skipped = (p: TrialPair) => pruned.some((q) => samePair(p, q));
  let cursor = -1;
  for (const [i, attempt] of attempts.entries()) {
    const at = indexOf(attempt);
    if (at <= cursor) return i;
    for (let j = cursor + 1; j < at; j += 1) if (!skipped(plan[j]!)) return i;
    cursor = at;
  }
  return -1;
}
