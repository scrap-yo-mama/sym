// SPDX-License-Identifier: AGPL-3.0-only
// Phase `testing` de l'enquête (tâche 2.1, 04 §2, §3.3 et §4) : les couples (E, N) sont essayés dans l'ordre du coût
// estimé croissant ; le premier conforme est retenu (« on ne paie l'agent que s'il n'existe rien de moins cher »), c'est
// donc le moins cher conforme parmi les couples essayés. « Conforme » : `N = 3` exécutions dont la sortie est valide
// contre le schéma validé (INV1, contrôlé par l'exécuteur), dont au moins une en page 2 si la stratégie pagine (sauf
// liste finie dès la page 1, règle d'arrêt atteinte), et, si elle pagine, règle d'arrêt vérifiée sur la dernière page
// (tâche 2.2) : les N exécutions s'arrêtent à 2 pages, une exécution de plus, au plafond dur, doit finir par la fin
// naturelle de la liste (sans quoi la règle est journalisée « non vérifiée », jamais présentée comme vérifiée). Le classifieur élague (`pruneAfter`), un refus ou un défi arrête
// tout (INV6), une connexion requise rend la main. Plafonds : `investigation_budget_usd`, `investigation_timeout_s`,
// nombre d'essais ; chaque exécution tourne sous le plus petit de `max_cost_usd` (s'il est fixé, D-123) et du budget restant.
// Orchestration pure : l'exécution d'un couple, le journal et l'horloge sont des ports.
import type { FailureClass } from '../model/enums.js';
import { cheaperPairs } from '../rules/plan.js';
import { pruneAfter, type TrialPair } from './plan.js';

/** Exécutions d'un couple exigées pour le dire conforme (04 §4, « à valider »). */
export const INVESTIGATION_SAMPLES = 3;

/** Défauts de l'enquête (04 §4, « à valider » : le CDC ne les chiffre pas). Budget : 3 $ depuis D-123 (1 $ avant). */
export const INVESTIGATION_DEFAULTS = Object.freeze({
  budgetUsd: 3,
  timeoutSeconds: 600,
  maxAttempts: 12,
});

/** Raison d'une exécution de plus que les N exécutions d'échantillon : vérifier la règle d'arrêt (tâche 2.2). */
export type TrialPurpose = 'sample' | 'stop_check';

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
  /** Les N exécutions d'échantillon (la vérification de la règle d'arrêt est dans `stop_check`). */
  readonly executions: readonly TrialExecution[];
  /** Règle d'arrêt de la pagination : constatée sur la dernière page ou non ; `null` : la stratégie ne pagine pas. */
  readonly stop_check: StopCheck | null;
  /** Somme des exécutions et de la vérification ; `null` dès qu'une est inconnue. */
  readonly cost_usd: number | null;
  readonly ms: number;
};

/**
 * Vérification de la règle d'arrêt (04 §4). `verified` : une exécution a fini par la fin naturelle de la liste (règle de
 * `stop[]`, page vide, curseur absent ou répété, plus de lien suivant) ; `stop` est cette raison. Sinon `verified: false` :
 * la liste dépasse le plafond dur, ou la vérification a dépassé `max_cost_usd` (`reason`) ; la règle n'est pas démontrée.
 *
 * Limite connue (04 § 4 compte la règle d'arrêt vérifiée sur la dernière page dans le critère « ça marche ») : le couple
 * est accepté avec `verified: false` dans ces deux cas, le plafond dur tenant lieu de règle d'arrêt d'une liste très longue.
 * Écart consigné dans tests/invariants.json (assert_pagination_stop_rule_last_page), à inscrire au CDC par l'orchestrateur.
 */
export type StopCheck = {
  readonly verified: boolean;
  readonly stop: string | null;
  readonly pages: number;
  readonly records: number;
  readonly reason?: 'max_cost_usd';
};

export type TrialPorts = {
  /**
   * Une exécution du couple sous le plafond `ceilingUsd` et l'échéance `deadlineMs` (epoch). Un plafond atteint rend
   * `run_budget_exceeded` ; l'échéance atteinte, `run_budget_exceeded` avec le détail `investigation_timeout_s`.
   * `purpose = 'stop_check'` : exécution au plafond dur de pages, pour constater la règle d'arrêt sur la dernière page.
   */
  execute(pair: TrialPair, index: number, limits: { readonly ceilingUsd: number; readonly deadlineMs: number }, purpose?: TrialPurpose): Promise<TrialExecution>;
  /** Le couple est terminé (essai journalisé : `run_attempts` et `attempt.finished`). */
  finished(outcome: PairOutcome): Promise<void>;
  /** Couples sautés après l'échec de `by` (journalisés : `attempt.pruned`). */
  pruned(pairs: readonly TrialPair[], by: TrialPair, cls: FailureClass): Promise<void>;
  now(): number;
  /**
   * Contenu minimal (tâche 2.12, r4 R5) : après les N exécutions conformes, un champ requis constant, vide ou en
   * sentinelles sur ces sorties rend le couple non conforme (`extraction`, couple suivant). Absent : aucun contrôle.
   * Peut être asynchrone : pour un essai E4, la compilation en déclaratif `html` paginé et sa vérification en page 2 y ont
   * lieu (constat Janssens : une page 1 correcte ne se jette plus en `minimal_content`).
   */
  contentCheck?(pair: TrialPair): { readonly failure_class: FailureClass; readonly detail: string } | null | Promise<{ readonly failure_class: FailureClass; readonly detail: string } | null>;
  /**
   * Essai IA d'enquête (E4 en échantillon, banc R06 et R08) : appelé après la PREMIÈRE exécution conforme d'un couple ; vrai
   * si une stratégie compilée de cet essai a été vérifiée SANS LLM (exécution E1 conforme sous toutes les gardes d'un run) :
   * elle tient lieu des exécutions suivantes, qui repaieraient le modèle. Le couple est alors conforme sur 1 exécution. Absent
   * ou faux : les N exécutions comme avant.
   */
  acceptEarly?(pair: TrialPair): boolean | Promise<boolean>;
  /**
   * Dépense de l'enquête faite HORS des exécutions de couples pendant les essais (compilation et vérification de page 2
   * d'un essai E4) : comptée dans le budget restant et dans la dépense rendue. Absent : 0.
   */
  spentOutside?(): number;
};

export type TrialBudget = {
  /** `investigation_budget_usd`. */
  readonly maxUsd: number;
  /** Déjà dépensé par l'enquête (LLM d'enquête, run précédent). */
  readonly spentUsd: number;
  /** Échéance de `investigation_timeout_s` (epoch ms). */
  readonly deadlineMs: number;
  readonly maxAttempts: number;
  /** `max_cost_usd` de l'API : plafond d'un run ; `null` : aucun plafond par run (D-123), seul le budget restant borne. */
  readonly maxCostPerRunUsd: number | null;
};

export type BudgetStop = 'investigation_budget_usd' | 'investigation_timeout_s' | 'max_attempts';

export type TrialsOutcome =
  | { readonly kind: 'conformant'; readonly outcome: PairOutcome; readonly spentUsd: number; readonly tried: readonly PairOutcome[] }
  /** Refus ou défi (INV6), 429 (ralentir), échec LLM sans repli : arrêt de toute escalade. */
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
 * déjà ordonné (`orderTrials`, puis éventuellement par les règles, `applyRulePlan`) : il n'est jamais réordonné ici.
 * `catchUp` (18 §4.5, tâche 2.10) : un couple conforme trouvé, les couples restants STRICTEMENT moins chers (ni essayés, ni
 * exclus par une règle, ni élagués) sont essayés avant de retenir ; le moins cher conforme est retenu. Avec l'ordre de
 * 04 §3.3, aucun couple restant n'est moins cher : aucun essai de plus.
 */
export async function runTrials(
  plan: readonly TrialPair[],
  ports: TrialPorts,
  budget: TrialBudget,
  options: { readonly samples?: number; readonly paginated?: (pair: TrialPair) => boolean; readonly catchUp?: boolean } = {},
): Promise<TrialsOutcome> {
  const samples = options.samples ?? INVESTIGATION_SAMPLES;
  let remaining = [...plan];
  let runsSpent = budget.spentUsd;
  /** Dépense de l'enquête : exécutions des couples, plus ce que `contentCheck` a dépensé hors d'elles. */
  const spentNow = (): number => Math.round((runsSpent + (ports.spentOutside?.() ?? 0)) * 1e6) / 1e6;
  const tried: PairOutcome[] = [];
  /** Conforme déjà trouvé pendant le rattrapage : retenu si aucun moins cher ne l'est. */
  let best: PairOutcome | null = null;
  while (remaining.length > 0) {
    if (tried.length >= budget.maxAttempts) return best !== null ? { kind: 'conformant', outcome: best, spentUsd: spentNow(), tried } : { kind: 'budget_exhausted', reason: 'max_attempts', spentUsd: spentNow(), tried };
    const pair = remaining.shift()!;
    const executions: TrialExecution[] = [];
    let failure: { cls: FailureClass; detail: string | null } | null = null;
    let budgetStop: BudgetStop | null = null;
    let stopCheck: StopCheck | null = null;
    let checkRun: TrialExecution | null = null;
    /**
     * Une exécution sous les plafonds ; rend vrai si la boucle doit s'arrêter (échec, budget). Même comptabilité pour les
     * exécutions d'échantillon et pour la vérification de la règle d'arrêt.
     */
    const execute = async (index: number, purpose: TrialPurpose): Promise<{ stop: boolean; run: TrialExecution | null; perRunCap: boolean }> => {
      const left = Math.round((budget.maxUsd - spentNow()) * 1e6) / 1e6;
      if (left <= 0) {
        budgetStop = 'investigation_budget_usd';
        return { stop: true, run: null, perRunCap: false };
      }
      if (ports.now() >= budget.deadlineMs) {
        budgetStop = 'investigation_timeout_s';
        return { stop: true, run: null, perRunCap: false };
      }
      const perRunCap = budget.maxCostPerRunUsd;
      const ceilingUsd = perRunCap === null ? left : Math.min(perRunCap, left);
      const run = await ports.execute(pair, index, { ceilingUsd, deadlineMs: budget.deadlineMs }, purpose);
      // Un coût inconnu ne se tient pas sous un budget : l'enquête s'arrête là (08 §1, jamais 0 par défaut).
      if (run.cost_usd === null) budgetStop = 'investigation_budget_usd';
      else runsSpent = Math.round((runsSpent + run.cost_usd) * 1e6) / 1e6;
      let overRunCap = false;
      if (!run.ok) {
        const cls = run.failure_class ?? 'code_error';
        if (cls === 'run_budget_exceeded') {
          // Plafond atteint : celui de l'enquête (budget restant, échéance) l'arrête ; celui d'un run (`max_cost_usd`)
          // écarte seulement ce couple, trop cher pour un run. Sans plafond par run (D-123), seul le budget restant coupe.
          if (run.detail === 'investigation_timeout_s') budgetStop = 'investigation_timeout_s';
          else if (perRunCap === null || ceilingUsd < perRunCap) budgetStop = 'investigation_budget_usd';
          else overRunCap = true;
        }
        failure = { cls, detail: run.detail };
        return { stop: true, run, perRunCap: overRunCap };
      }
      return { stop: budgetStop !== null, run, perRunCap: overRunCap };
    };
    /** Exécutions exigées pour ce couple : N, ou 1 si l'essai IA compilé a été vérifié sans LLM (`acceptEarly`). */
    let needed = samples;
    for (let i = 0; i < samples; i += 1) {
      const step = await execute(i, 'sample');
      if (step.run !== null) executions.push(step.run);
      if (step.stop) break;
      if (i === 0 && samples > 1 && step.run?.ok === true && ports.acceptEarly !== undefined && (await ports.acceptEarly(pair))) {
        needed = 1;
        break;
      }
    }
    const paginates = options.paginated?.(pair) === true;
    // Page 2 (04 §4) : une stratégie qui pagine doit l'atteindre au moins une fois, sauf liste finie dès la page 1.
    if (failure === null && budgetStop === null && executions.length === needed && paginates) {
      const reached = executions.some((e) => e.pages >= 2);
      const finished = executions.every((e) => e.pages === 1 && e.stop !== null && NATURAL_STOPS.has(e.stop));
      if (!reached && !finished) failure = { cls: 'extraction', detail: 'pagination_page2' };
    }
    // Règle d'arrêt sur la dernière page (04 §4, tâche 2.2) : une exécution d'échantillon qui a fini par la fin naturelle de
    // la liste l'a déjà constatée ; sinon une exécution de plus, au plafond dur, doit y arriver.
    if (failure === null && budgetStop === null && executions.length === needed && paginates) {
      const natural = executions.find((e) => e.stop !== null && NATURAL_STOPS.has(e.stop));
      if (natural !== undefined) {
        stopCheck = { verified: true, stop: natural.stop, pages: natural.pages, records: natural.records };
      } else {
        const step = await execute(samples, 'stop_check');
        checkRun = step.run;
        if (step.run?.ok === true) {
          const natural = step.run.stop !== null && NATURAL_STOPS.has(step.run.stop);
          stopCheck = { verified: natural, stop: step.run.stop, pages: step.run.pages, records: step.run.records };
        } else if (step.perRunCap && budgetStop === null) {
          // Trop cher pour un run : la règle n'est pas démontrée, mais le couple a fait ses N exécutions conformes.
          failure = null;
          stopCheck = { verified: false, stop: null, pages: step.run?.pages ?? 0, records: 0, reason: 'max_cost_usd' };
        }
      }
    }
    if (failure === null && budgetStop === null && executions.length === needed && ports.contentCheck !== undefined) {
      const content = await ports.contentCheck(pair);
      if (content !== null) failure = { cls: content.failure_class, detail: content.detail };
    }
    const done = executions.length === needed && failure === null && budgetStop === null;
    const all = checkRun === null ? executions : [...executions, checkRun];
    const outcome: PairOutcome = {
      pair,
      result: failure?.cls ?? (done ? 'ok' : 'run_budget_exceeded'),
      detail: failure?.detail ?? (done ? null : budgetStop),
      executions,
      stop_check: stopCheck,
      cost_usd: sumCost(all),
      ms: all.reduce((s, e) => s + e.ms, 0),
    };
    if (executions.length > 0) {
      tried.push(outcome);
      await ports.finished(outcome);
    }
    if (done) {
      const cheaper = options.catchUp === true ? cheaperPairs(remaining, pair) : [];
      if (cheaper.length === 0) return { kind: 'conformant', outcome, spentUsd: spentNow(), tried };
      best = outcome;
      remaining = cheaper;
      continue;
    }
    if (budgetStop !== null) return best !== null ? { kind: 'conformant', outcome: best, spentUsd: spentNow(), tried } : { kind: 'budget_exhausted', reason: budgetStop, spentUsd: spentNow(), tried };
    const cls = failure!.cls;
    const decision = pruneAfter(cls, pair, remaining);
    // Contrôle de fidélité refusé (banc réel) : la carte des champs du gisement est en cause, pas le niveau d'exécution ; les
    // autres niveaux déclaratifs du même gisement liraient les mêmes emplacements : élagués avec lui.
    const sameSource = (failure as { detail: string | null } | null)?.detail === 'fidelity' ? remaining.filter((p) => p.source === pair.source && !decision.pruned.includes(p)) : [];
    const pruned = [...decision.pruned, ...sameSource];
    if (pruned.length > 0) {
      await ports.pruned(pruned, pair, cls);
      const skip = new Set(pruned);
      remaining = remaining.filter((p) => !skip.has(p));
    }
    if (decision.next === 'stop') return { kind: 'stopped', outcome, spentUsd: spentNow(), tried };
    if (decision.next === 'action_required') return { kind: 'action_required', outcome, spentUsd: spentNow(), tried };
  }
  return best !== null ? { kind: 'conformant', outcome: best, spentUsd: spentNow(), tried } : { kind: 'exhausted', spentUsd: spentNow(), tried };
}
