// SPDX-License-Identifier: AGPL-3.0-only
// Règles de la reprise par étape (19 §4, r2 R3, R4, R10, R11, tâche 2.13), sans I/O :
// - garde de classification AVANT chaque reprise : seules `extraction` et `code_error` entrent dans l'échelle ; toute
//   autre classe suit 04 §7 avec 0 appel d'agent (et aucune page de défi transmise) ;
// - étape `side_effect: write` : jamais réparée seule (`write_step_broken`, transition 14) ;
// - run avec session ou en tunnel : niveau 1 seulement (`session_step_broken` si l'alternate échoue) ;
// - seuil de cascade : `max_step_repairs_per_run` (2) ou part d'étapes cassées (à valider) → `step_cascade` (13) ;
// - budget de l'agent d'étape : `agent_budget` (6 pas, 0,02 $), tenu avant chaque appel.
import type { FailureClass } from '../model/enums.js';
import type { StepSideEffect } from './side-effect.js';
import { STEP_REPAIR_DEFAULTS, type StepAgentBudget } from './spec.js';

export type StepRepairLevel = 1 | 2 | 3;
export type StepRoute = { kind: 'classifier' } | { kind: 'write_step_broken' } | { kind: 'ladder'; levels: StepRepairLevel[] };

export function stepRepairRoute(args: { failureClass: FailureClass; sideEffect: StepSideEffect; session: boolean; tunnel: boolean }): StepRoute {
  if (args.failureClass !== 'extraction' && args.failureClass !== 'code_error') return { kind: 'classifier' };
  if (args.sideEffect === 'write') return { kind: 'write_step_broken' };
  return { kind: 'ladder', levels: args.session || args.tunnel ? [1] : [1, 2, 3] };
}

/** Compteur des étapes cassées d'un run. */
export class StepCascade {
  readonly #max: number;
  readonly #maxShare: number;
  readonly #total: number;
  readonly #broken = new Set<string>();

  constructor(options: { totalSteps: number; maxStepRepairsPerRun?: number; maxBrokenShare?: number }) {
    this.#total = Math.max(1, options.totalSteps);
    this.#max = Math.max(0, options.maxStepRepairsPerRun ?? STEP_REPAIR_DEFAULTS.maxStepRepairsPerRun);
    this.#maxShare = options.maxBrokenShare ?? STEP_REPAIR_DEFAULTS.maxBrokenShare;
  }
  get broken(): number {
    return this.#broken.size;
  }
  /** Une étape cassée de plus ; `step_cascade` au-delà du seuil (la même étape compte une fois). */
  register(stepId: string): 'continue' | 'step_cascade' {
    this.#broken.add(stepId);
    if (this.#broken.size > this.#max) return 'step_cascade';
    if (this.#broken.size / this.#total > this.#maxShare && this.#broken.size > 1) return 'step_cascade';
    return 'continue';
  }
}

/** Budget d'UN agent d'étape : pas et dollars ; un prix inconnu rend le plafond intenable (aucun appel de plus). */
export class StepAgentMeter {
  readonly #budget: StepAgentBudget;
  #steps = 0;
  #spent = 0;
  #stop: 'max_steps' | 'budget' | null = null;
  #priceUnknown = false;

  constructor(budget: StepAgentBudget) {
    this.#budget = budget;
  }
  get spentUsd(): number {
    return this.#spent;
  }
  get steps(): number {
    return this.#steps;
  }
  get stop(): 'max_steps' | 'budget' | null {
    return this.#stop;
  }
  /** Un appel de plus, dont le coût maximal est `ceilingUsd`, tient-il dans le budget ? (`stop` dit pourquoi sinon) */
  canCall(ceilingUsd: number): boolean {
    if (this.#stop === 'budget' && this.#priceUnknown) return false;
    if (this.#steps >= this.#budget.max_steps) {
      this.#stop = 'max_steps';
      return false;
    }
    if (this.#spent + Math.max(0, ceilingUsd) > this.#budget.max_usd + 1e-12) {
      this.#stop = 'budget';
      return false;
    }
    return true;
  }
  /** Compte un appel et sa dépense ; `null` (prix inconnu) épuise le budget. */
  spend(usd: number | null): void {
    this.#steps += 1;
    if (usd === null) {
      this.#spent = this.#budget.max_usd;
      this.#priceUnknown = true;
      this.#stop = 'budget';
      return;
    }
    this.#spent = Math.round((this.#spent + Math.max(0, usd)) * 1e9) / 1e9;
  }
}
