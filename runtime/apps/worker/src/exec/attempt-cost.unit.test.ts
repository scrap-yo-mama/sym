// SPDX-License-Identifier: AGPL-3.0-only
// Compteur de coût d'un essai agentique (tâche 2.4, correctifs de vérification ; 04b « Schéma et coût », 08 §1) : proxy et
// LLM partagent UN plafond `max_cost_usd` ; chaque run de moteur reçoit le reliquat ; un coût LLM inconnu (prix absent)
// rend le plafond intenable, donc épuisé.
import { describe, expect, test } from 'vitest';
import { AttemptBudgetExceededError, AttemptCost, relabelRunBudget } from './attempt-cost.js';

describe('AttemptCost — plafond partagé proxy + LLM', () => {
  test('dépense = proxy + LLM ; reliquat ; épuisé au plafond', () => {
    const cost = new AttemptCost(0.1);
    let proxy = 0.01;
    let llm: number | null = 0.03;
    cost.addProxy(() => proxy);
    cost.addLlm(() => llm);
    expect(cost.spentUsd()).toBeCloseTo(0.04, 9);
    expect(cost.remainingUsd()).toBeCloseTo(0.06, 9);
    expect(cost.exhausted()).toBe(false);
    expect(() => cost.assertAvailable()).not.toThrow();
    proxy = 0.07;
    expect(cost.exhausted()).toBe(true);
    expect(cost.remainingUsd()).toBe(0);
    expect(() => cost.assertAvailable()).toThrow(AttemptBudgetExceededError);
    proxy = 0;
    llm = null;
    // Prix absent : coût inconnu, jamais 0 ; le plafond ne peut plus être tenu.
    expect(cost.llmUsd()).toBeNull();
    expect(cost.spentUsd()).toBeNull();
    expect(cost.exhausted()).toBe(true);
    expect(cost.remainingUsd()).toBe(0);
    expect(() => cost.assertAvailable()).toThrow(expect.objectContaining({ unpriced: true }));
  });

  test('run de moteur : plafond = reliquat à l’ouverture ; dépense ailleurs comptée depuis l’ouverture', () => {
    const cost = new AttemptCost(0.1);
    let proxy = 0.02;
    cost.addProxy(() => proxy);
    const first = cost.openRun();
    expect(first.limitUsd).toBeCloseTo(0.08, 9);
    first.report(0.05);
    proxy = 0.025;
    expect(first.spentElsewhereUsd()).toBeCloseTo(0.005, 9);
    expect(cost.spentUsd()).toBeCloseTo(0.075, 9);
    // Deuxième étape `agent` : le reliquat, pas le plafond entier.
    const second = cost.openRun();
    expect(second.limitUsd).toBeCloseTo(0.025, 9);
    second.report(0.01);
    expect(second.spentElsewhereUsd()).toBe(0);
    expect(cost.spentUsd()).toBeCloseTo(0.085, 9);
    // Un run non tarifé rend l'essai inconnu.
    second.report(null);
    expect(cost.llmUsd()).toBeNull();
    expect(cost.openRun().limitUsd).toBe(0);
  });
});

// Recette 2026-10-04 (UX-32) : essai agent facturé 0,513 puis 0,534 $ pour max_cost_usd 0,50 $ : le contrôle avant l'appel
// ne regardait que la dépense passée. Il compte désormais le coût prévu de l'appel.
describe('AttemptCost — coût prévu de l’appel suivant (UX-32)', () => {
  test('refus AVANT l’appel qui dépasserait le plafond ; un appel qui tient part', () => {
    const cost = new AttemptCost(0.5);
    cost.addLlm(() => 0.4);
    expect(() => cost.assertAvailable(0.09)).not.toThrow();
    expect(() => cost.assertAvailable(0.11)).toThrow(expect.objectContaining({ unpriced: false, message: 'max_cost_usd' }));
    expect(() => cost.assertAvailable(null)).not.toThrow();
  });
});

// D-123 : sans plafond par run, la borne d'un run est le budget du jour restant ; un run coupé par elle le dit
// (`user_budget_daily_usd`), jamais « max_cost_usd » (qui inviterait à monter un plafond que personne n'a fixé).
describe('relabelRunBudget — motif d’un run coupé par sa borne de coût (D-123)', () => {
  const cut = { state: 'failed', failure_class: 'run_budget_exceeded', retryable: false, error_detail: 'max_cost_usd', strategy_version: 1 } as const;
  test('API sans plafond : `max_cost_usd` devient `user_budget_daily_usd`', () => {
    expect(relabelRunBudget(cut, null)).toEqual({ ...cut, error_detail: 'user_budget_daily_usd' });
  });
  test('plafond fixé par le membre : motif inchangé ; autres fins inchangées', () => {
    expect(relabelRunBudget(cut, 0.5)).toBe(cut);
    const other = { state: 'failed', failure_class: 'run_budget_exceeded', retryable: false, error_detail: 'llm_price_missing' } as const;
    expect(relabelRunBudget(other, null)).toBe(other);
    const ok = { state: 'succeeded', outcome: 'clean', items: 3 } as const;
    expect(relabelRunBudget(ok, null)).toBe(ok);
  });
});
