// SPDX-License-Identifier: AGPL-3.0-only
// Phase `testing` de l'enquête (tâche 2.1, 04 §2, §3.3 et §4) : les couples (E, N) sont essayés dans l'ordre du coût
// estimé croissant ; le premier conforme est retenu (« on ne paie l'agent que s'il n'existe rien de moins cher »), c'est
// donc le moins cher conforme parmi les couples essayés. « Conforme » : `N = 3` exécutions dont la sortie est valide
// contre le schéma validé (INV1, contrôlé par l'exécuteur), dont au moins une en page 2 si la stratégie pagine (sauf
// liste finie dès la page 1, règle d'arrêt atteinte). Le classifieur élague (`pruneAfter`), un refus ou un défi arrête
// tout (INV6), une connexion requise rend la main. Plafonds : `investigation_budget_usd`, `investigation_timeout_s`,
// nombre d'essais ; chaque exécution tourne sous le plus petit de `max_cost_usd` et du budget restant.
// Orchestration pure : l'exécution d'un couple, le journal et l'horloge sont des ports.
import type { FailureClass } from '../model/enums.js';
import { pruneAfter, type TrialPair } from './plan.js';

/** Exécutions d'un couple exigées pour le dire conforme (04 §4, « à valider »). */
export const INVESTIGATION_SAMPLES = 3;

/** Défauts de l'enquête (04 §4, « à valider » : le CDC ne les chiffre pas). */
export const INVESTIGATION_DEFAULTS = Object.freeze({
  budgetUsd: 1,
  timeoutSeconds: 600,
  maxAttempts: 12,
});

/** Une exécution d'un couple. */
export type TrialExecution = {
  readonly ok: boolean;
  readonly failure_class: FailureClass | null;
  readonly detail: string | null;
  readonly records: number;
  readonly pages: number;
  /** Raison d'arrêt de la pagination (`max_pages_input`, `records_empty`, …) ; `null` en échec. */
  readonly stop: string | null;
  /** Coût réel de l'exécution ; `null` : inconnu (prix du modèle absent). */
  readonly cost_usd: number | null;
  readonly ms: number;
};

export type PairOutcome = {
  readonly pair: TrialPair;
  /** `ok` ou classe d'échec du couple (première exécution en échec, ou contrôle de la page 2). */
  readonly result: 'ok' | FailureClass;
  readonly detail: string | null;
  readonly executions: readonly TrialExecution[];
  /** Somme des exécutions ; `null` dès qu'une est inconnue. */
  readonly cost_usd: number | null;
  readonly ms: number;
};

export type TrialPorts = {
  /**
   * Une exécution du couple sous le plafond `ceilingUsd` et l'échéance `deadlineMs` (epoch). Un plafond atteint rend
   * `run_budget_exceeded` ; l'échéance atteinte, `run_budget_exceeded` avec le détail `investigation_timeout_s`.
   */
  execute(pair: TrialPair, index: number, limits: { readonly ceilingUsd: number; readonly deadlineMs: number }): Promise<TrialExecution>;
  /** Le couple est terminé (essai journalisé : `run_attempts` et `attempt.finished`). */
  finished(outcome: PairOutcome): Promise<void>;
  /** Couples sautés après l'échec de `by` (journalisés : `attempt.pruned`). */
  pruned(pairs: readonly TrialPair[], by: TrialPair, cls: FailureClass): Promise<void>;
  now(): number;
};

export type TrialBudget = {
  /** `investigation_budget_usd`. */
  readonly maxUsd: number;
  /** Déjà dépensé par l'enquête (LLM d'enquête, run précédent). */
  readonly spentUsd: number;
  /** Échéance de `investigation_timeout_s` (epoch ms). */
  readonly deadlineMs: number;
  readonly maxAttempts: number;
  /** `max_cost_usd` de l'API : plafond d'un run. */
  readonly maxCostPerRunUsd: number;
};

export type BudgetStop = 'investigation_budget_usd' | 'investigation_timeout_s' | 'max_attempts';

export type TrialsOutcome =
  | { readonly kind: 'conformant'; readonly outcome: PairOutcome; readonly spentUsd: number; readonly tried: readonly PairOutcome[] }
  /** Refus ou défi (INV6) : arrêt de toute escalade. */
  | { readonly kind: 'stopped'; readonly outcome: PairOutcome; readonly spentUsd: number; readonly tried: readonly PairOutcome[] }
  /** Connexion, paiement, limite de compte : la main revient à l'utilisateur. */
  | { readonly kind: 'action_required'; readonly outcome: PairOutcome; readonly spentUsd: number; readonly tried: readonly PairOutcome[] }
  | { readonly kind: 'budget_exhausted'; readonly reason: BudgetStop; readonly spentUsd: number; readonly tried: readonly PairOutcome[] }
  /** Tous les couples essayés ou élagués, aucun conforme. */
  | { readonly kind: 'exhausted'; readonly spentUsd: number; readonly tried: readonly PairOutcome[] };

/** Raisons d'arrêt d'une pagination qui prouvent la fin de la liste (règle d'arrêt atteinte, pas un plafond). */
const NATURAL_STOPS = new Set(['records_empty', 'path_equals', 'path_missing', 'no_next', 'repeated_cursor', 'no_pagination']);

const sumCost = (executions: readonly TrialExecution[]): number | null =>
  executions.some((e) => e.cost_usd === null) ? null : Math.round(executions.reduce((s, e) => s + (e.cost_usd ?? 0), 0) * 1e6) / 1e6;

/**
 * Essais par coût croissant. `paginated(pair)` : la stratégie du couple pagine (contrôle de la page 2). Le plan doit être
 * déjà ordonné (`orderTrials`) : il n'est jamais réordonné ici.
 */
export async function runTrials(
  plan: readonly TrialPair[],
  ports: TrialPorts,
  budget: TrialBudget,
  options: { readonly samples?: number; readonly paginated?: (pair: TrialPair) => boolean } = {},
): Promise<TrialsOutcome> {
  const samples = options.samples ?? INVESTIGATION_SAMPLES;
  let remaining = [...plan];
  let spent = budget.spentUsd;
  const tried: PairOutcome[] = [];
  while (remaining.length > 0) {
    if (tried.length >= budget.maxAttempts) return { kind: 'budget_exhausted', reason: 'max_attempts', spentUsd: spent, tried };
    const pair = remaining.shift()!;
    const executions: TrialExecution[] = [];
    let failure: { cls: FailureClass; detail: string | null } | null = null;
    let budgetStop: BudgetStop | null = null;
    for (let i = 0; i < samples; i += 1) {
      const left = Math.round((budget.maxUsd - spent) * 1e6) / 1e6;
      if (left <= 0) {
        budgetStop = 'investigation_budget_usd';
        break;
      }
      if (ports.now() >= budget.deadlineMs) {
        budgetStop = 'investigation_timeout_s';
        break;
      }
      const ceilingUsd = Math.min(budget.maxCostPerRunUsd, left);
      const run = await ports.execute(pair, i, { ceilingUsd, deadlineMs: budget.deadlineMs });
      executions.push(run);
      // Un coût inconnu ne se tient pas sous un budget : l'enquête s'arrête là (08 §1, jamais 0 par défaut).
      if (run.cost_usd === null) budgetStop = 'investigation_budget_usd';
      else spent = Math.round((spent + run.cost_usd) * 1e6) / 1e6;
      if (!run.ok) {
        const cls = run.failure_class ?? 'code_error';
        if (cls === 'run_budget_exceeded') {
          // Plafond atteint : celui de l'enquête (budget restant, échéance) l'arrête ; celui d'un run (`max_cost_usd`)
          // écarte seulement ce couple, trop cher pour un run.
          if (run.detail === 'investigation_timeout_s') budgetStop = 'investigation_timeout_s';
          else if (ceilingUsd < budget.maxCostPerRunUsd) budgetStop = 'investigation_budget_usd';
        }
        failure = { cls, detail: run.detail };
        break;
      }
      if (budgetStop !== null) break;
    }
    // Page 2 (04 §4) : une stratégie qui pagine doit l'atteindre au moins une fois, sauf liste finie dès la page 1.
    if (failure === null && budgetStop === null && executions.length === samples && options.paginated?.(pair) === true) {
      const reached = executions.some((e) => e.pages >= 2);
      const finished = executions.every((e) => e.pages === 1 && e.stop !== null && NATURAL_STOPS.has(e.stop));
      if (!reached && !finished) failure = { cls: 'extraction', detail: 'pagination_page2' };
    }
    const done = executions.length === samples && failure === null && budgetStop === null;
    const outcome: PairOutcome = {
      pair,
      result: failure?.cls ?? (done ? 'ok' : 'run_budget_exceeded'),
      detail: failure?.detail ?? (done ? null : budgetStop),
      executions,
      cost_usd: sumCost(executions),
      ms: executions.reduce((s, e) => s + e.ms, 0),
    };
    if (executions.length > 0) {
      tried.push(outcome);
      await ports.finished(outcome);
    }
    if (done) return { kind: 'conformant', outcome, spentUsd: spent, tried };
    if (budgetStop !== null) return { kind: 'budget_exhausted', reason: budgetStop, spentUsd: spent, tried };
    const cls = failure!.cls;
    const decision = pruneAfter(cls, pair, remaining);
    if (decision.pruned.length > 0) {
      await ports.pruned(decision.pruned, pair, cls);
      const skip = new Set(decision.pruned);
      remaining = remaining.filter((p) => !skip.has(p));
    }
    if (decision.next === 'stop') return { kind: 'stopped', outcome, spentUsd: spent, tried };
    if (decision.next === 'action_required') return { kind: 'action_required', outcome, spentUsd: spent, tried };
  }
  return { kind: 'exhausted', spentUsd: spent, tried };
}
