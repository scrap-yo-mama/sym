// SPDX-License-Identifier: AGPL-3.0-only
// Compteur de coût d'UN essai agentique (tâche 2.4 ; 04b « Schéma et coût » ; 08 §1 « Prix et cache ») : le proxy
// (egress Chromium, session réseau) et le LLM (rôle `extract`, moteur du rôle `agent`) partagent le même plafond
// `max_cost_usd`. Il est relu avant chaque appel au modèle et avant chaque requête facturée :
// - chaque run de moteur (E6, ou chaque étape `agent` d'un E5) reçoit le RELIQUAT à son ouverture, et voit la dépense
//   faite ailleurs pendant qu'il tourne (proxy, autres appels) ;
// - un coût LLM inconnu (prix absent, ni `usage.cost` du fournisseur) n'est jamais compté 0 : il rend le plafond
//   intenable, donc l'essai épuisé (`run_budget_exceeded`, `llm_price_missing`).
// Le contrôle se fait avant l'envoi, avec le coût PRÉVU de l'appel (entrée de la requête, sortie du dernier appel) : l'appel
// qui franchirait le plafond ne part pas (constat UX-32 : 0,534 $ facturés pour 0,50 $ quand seule la dépense passée était
// comparée). Un appel parti est imputé tel quel ; seul l'écart entre le coût prévu et le coût réel peut encore dépasser.
// D-123 : sans plafond par run fixé, ce plafond est la borne effective du run (budget du jour restant, ou d'enquête restant
// pendant un essai d'enquête) : toujours finie, connue avant le premier appel.
import type { RunResult } from '@runtime/core';

/** Plafond atteint (ou intenable, `unpriced`) : aucun appel de plus. */
export class AttemptBudgetExceededError extends Error {
  override name = 'AttemptBudgetExceededError';
  readonly unpriced: boolean;
  constructor(unpriced: boolean) {
    super(unpriced ? 'llm_price_missing' : 'max_cost_usd');
    this.unpriced = unpriced;
  }
}

/** Budget d'un run de moteur, vu par le moteur. */
export type RunBudget = {
  /** Plafond du run : reliquat de l'essai à son ouverture. */
  readonly limitUsd: number;
  /** Coût cumulé du run (null : non tarifé), rapporté après chaque appel au modèle. */
  report(usd: number | null): void;
  /** Dépense de l'essai faite hors de ce run depuis son ouverture ; null si un coût est inconnu. */
  spentElsewhereUsd(): number | null;
};

const round = (usd: number): number => Math.round(usd * 1e9) / 1e9;

export class AttemptCost {
  readonly maxUsd: number;
  readonly #proxy: (() => number)[] = [];
  readonly #llm: (() => number | null)[] = [];

  constructor(maxUsd: number) {
    this.maxUsd = maxUsd;
  }

  addProxy(source: () => number): void {
    this.#proxy.push(source);
  }

  addLlm(source: () => number | null): void {
    this.#llm.push(source);
  }

  proxyUsd(): number {
    return round(this.#proxy.reduce((sum, s) => sum + s(), 0));
  }

  #llmExcept(except?: () => number | null): number | null {
    let sum = 0;
    for (const source of this.#llm) {
      if (source === except) continue;
      const usd = source();
      if (usd === null) return null;
      sum += usd;
    }
    return round(sum);
  }

  /** Coût LLM de l'essai ; null dès qu'un appel n'est pas tarifé (jamais 0, 08 §1). */
  llmUsd(): number | null {
    return this.#llmExcept();
  }

  #spentExcept(except?: () => number | null): number | null {
    const llm = this.#llmExcept(except);
    return llm === null ? null : round(llm + this.proxyUsd());
  }

  spentUsd(): number | null {
    return this.#spentExcept();
  }

  /** Reliquat ; 0 si le coût est inconnu. */
  remainingUsd(): number {
    const spent = this.spentUsd();
    return spent === null ? 0 : Math.max(0, round(this.maxUsd - spent));
  }

  exhausted(): boolean {
    const spent = this.spentUsd();
    return spent === null || spent >= this.maxUsd;
  }

  /**
   * Lève `AttemptBudgetExceededError` si l'appel ne peut pas partir : plafond atteint, ou dépense + coût prévu de l'appel
   * (`nextUsd`, null ou absent : inconnu, seul le plafond atteint compte) au-delà du plafond (UX-32).
   */
  assertAvailable(nextUsd: number | null = null): void {
    const spent = this.spentUsd();
    if (spent === null) throw new AttemptBudgetExceededError(true);
    if (spent >= this.maxUsd || round(spent + (nextUsd ?? 0)) > this.maxUsd) throw new AttemptBudgetExceededError(false);
  }

  /** Ouvre un run de moteur : plafond = reliquat, dépense ailleurs comptée depuis l'ouverture. */
  openRun(): RunBudget {
    let own: number | null = 0;
    const source = (): number | null => own;
    const start = this.#spentExcept(source);
    this.#llm.push(source);
    return {
      limitUsd: start === null ? 0 : Math.max(0, round(this.maxUsd - start)),
      report: (usd) => {
        own = usd;
      },
      spentElsewhereUsd: () => {
        const now = this.#spentExcept(source);
        return now === null || start === null ? null : Math.max(0, round(now - start));
      },
    };
  }
}

/**
 * Motif d'un run coupé par sa borne de coût (D-123) : sans plafond par run fixé (`costCapUsd` null), la borne était le
 * budget du jour restant de l'utilisateur ; le run le dit (`user_budget_daily_usd`, message « budget du jour atteint »),
 * jamais `max_cost_usd`, qui inviterait à monter un plafond que personne n'a fixé.
 */
export function relabelRunBudget<R extends RunResult>(result: R, costCapUsd: number | null): R {
  if (costCapUsd !== null || result.state !== 'failed' || result.failure_class !== 'run_budget_exceeded' || result.error_detail !== 'max_cost_usd') return result;
  return { ...result, error_detail: 'user_budget_daily_usd' };
}
