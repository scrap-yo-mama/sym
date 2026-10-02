// SPDX-License-Identifier: AGPL-3.0-only
// Règles de la boucle de réparation (04 §5, tâche 2.3), sans I/O :
// - au plus `maxAttempts` propositions (3, à valider) et `budgetUsd` (coût LLM et proxy de la réparation, `repair_budget_usd`,
//   valeur à valider) ;
// - arrêt dès que le MÊME correctif est proposé deux fois (empreinte canonique du patch, `patchKey`) : run `failed`, API en
//   `erreur` (transition 13), stratégie précédente conservée ;
// - escalade « selon l'ordre du §3.3 à partir du couple courant » : exécutions déclaratives plus chères sur le MÊME réseau
//   (un échec d'extraction n'est jamais une raison de changer d'IP, X3) ; une issue qui exigerait un agent à chaque run
//   (E4, E6 non compilé) n'est pas retenue sans `instructed_mode` (2.13).
import type { Execution } from '../model/enums.js';

export const REPAIR_DEFAULTS = { maxAttempts: 3, budgetUsd: 0.5 } as const;

export type RepairStopCause = 'repeated_patch' | 'budget_exhausted';

/** Exécutions déclaratives, du moins cher au plus cher (04 §3.1) : seules candidates de l'escalade d'une réparation. */
const DECLARATIVE_LADDER: readonly Execution[] = ['fetch', 'fetch_in_page', 'playwright'];

/** Exécutions plus chères que `current` sur l'échelle déclarative ; `[]` hors de cette échelle. */
export function escalationExecutions(current: Execution, options: { browser: boolean }): Execution[] {
  const at = DECLARATIVE_LADDER.indexOf(current);
  if (at < 0) return [];
  return DECLARATIVE_LADDER.slice(at + 1).filter((e) => options.browser || e === 'fetch');
}

/** Compteur d'une réparation : propositions, correctifs déjà vus, dépense. */
export class RepairLedger {
  readonly #maxAttempts: number;
  readonly #budgetUsd: number;
  readonly #seen = new Set<string>();
  #attempts = 0;
  #spentUsd = 0;
  #stop: RepairStopCause | null = null;

  constructor(options: { maxAttempts?: number; budgetUsd?: number } = {}) {
    this.#maxAttempts = Math.max(0, options.maxAttempts ?? REPAIR_DEFAULTS.maxAttempts);
    this.#budgetUsd = Math.max(0, options.budgetUsd ?? REPAIR_DEFAULTS.budgetUsd);
  }

  get attempts(): number {
    return this.#attempts;
  }
  get spentUsd(): number {
    return this.#spentUsd;
  }
  get remainingUsd(): number {
    return Math.max(0, Math.round((this.#budgetUsd - this.#spentUsd) * 1e6) / 1e6);
  }
  /** Cause d'arrêt retenue (`null` : la boucle peut continuer). */
  get stopped(): RepairStopCause | null {
    return this.#stop;
  }

  /** Une proposition de plus est-elle permise, pour un appel dont le coût maximal est `ceilingUsd` ? */
  canPropose(ceilingUsd = 0): boolean {
    if (this.#stop !== null) return false;
    if (this.#attempts >= this.#maxAttempts || this.#spentUsd + Math.max(0, ceilingUsd) > this.#budgetUsd) {
      this.#stop = 'budget_exhausted';
      return false;
    }
    return true;
  }

  /** Compte une proposition ; `false` si ce correctif a déjà été proposé (arrêt `repeated_patch`). */
  propose(key: string | null): boolean {
    this.#attempts += 1;
    if (key === null) return true;
    if (this.#seen.has(key)) {
      this.#stop = 'repeated_patch';
      return false;
    }
    this.#seen.add(key);
    return true;
  }

  /** Dépense (LLM ou proxy) ; `null` (prix inconnu) épuise le budget : le plafond n'est plus tenable. */
  spend(usd: number | null): void {
    if (usd === null) {
      this.#spentUsd = this.#budgetUsd;
      return;
    }
    this.#spentUsd = Math.round((this.#spentUsd + Math.max(0, usd)) * 1e6) / 1e6;
  }

  /** Fin de boucle sans succès : la cause d'arrêt (budget épuisé par défaut). */
  finish(): RepairStopCause {
    this.#stop ??= 'budget_exhausted';
    return this.#stop;
  }
}
