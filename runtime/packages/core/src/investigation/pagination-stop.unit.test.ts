// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.2 (04 §4, « critère ça marche ») : « sortie conforme sur N = 3 exécutions, dont au moins une en page 2 si l'API
// est paginée, et règle d'arrêt vérifiée sur la dernière page ». Les N exécutions sont plafonnées à 2 pages ; la règle
// d'arrêt est donc vérifiée par une exécution de plus, au plafond dur, qui doit finir par la FIN NATURELLE de la liste.
// Logique pure : l'exécution d'un couple est un port scripté.
import { describe, expect, test } from 'vitest';
import type { TrialPair } from './plan.js';
import { runTrials, type PairOutcome, type TrialExecution, type TrialPorts } from './trials.js';

const pair = (execution: TrialPair['execution'], est: number): TrialPair => ({ execution, network: 'direct', source: 'c1', est_cost_usd: est });
const run = (pages: number, stop: string | null, cost = 0.0001): TrialExecution => ({ ok: true, failure_class: null, detail: null, records: pages * 20, pages, stop, cost_usd: cost, ms: 5 });
const failed = (cls: NonNullable<TrialExecution['failure_class']>, detail: string): TrialExecution => ({ ok: false, failure_class: cls, detail, records: 0, pages: 0, stop: null, cost_usd: 0.0001, ms: 5 });
const budget = { maxUsd: 1, spentUsd: 0, deadlineMs: 1_000_000, maxAttempts: 12, maxCostPerRunUsd: 0.5 };

function ports(script: (p: TrialPair, i: number, purpose: 'sample' | 'stop_check') => TrialExecution): TrialPorts & { calls: string[]; log: PairOutcome[] } {
  const calls: string[] = [];
  const log: PairOutcome[] = [];
  return {
    calls,
    log,
    now: () => 0,
    execute: async (p, i, _limits, purpose = 'sample') => {
      calls.push(`${p.execution}#${i}:${purpose}`);
      return script(p, i, purpose);
    },
    finished: async (o) => {
      log.push(o);
    },
    pruned: async () => undefined,
  };
}

const paginated = { paginated: () => true };

describe('règle d’arrêt vérifiée sur la dernière page (2.2)', () => {
  test('assert_pagination_stop_rule_last_page — 3 exécutions de 2 pages au plafond, puis une exécution au plafond dur qui atteint la fin naturelle : règle vérifiée', async () => {
    const p = ports((_p, _i, purpose) => (purpose === 'sample' ? run(2, 'max_pages_input') : run(25, 'path_equals', 0.001)));
    const out = await runTrials([pair('fetch', 0.00005)], p, budget, paginated);
    expect(out.kind).toBe('conformant');
    expect(p.calls).toEqual(['fetch#0:sample', 'fetch#1:sample', 'fetch#2:sample', 'fetch#3:stop_check']);
    expect(p.log[0]).toMatchObject({ result: 'ok', stop_check: { verified: true, stop: 'path_equals', pages: 25 } });
    // Les 3 exécutions d'échantillon restent les N = 3 du CDC ; la vérification est en plus, et son coût est imputé.
    expect(p.log[0]!.executions).toHaveLength(3);
    expect(p.log[0]!.cost_usd).toBeCloseTo(0.0003 + 0.001, 6);
  });

  test('une exécution déjà finie par la fin naturelle (liste de 2 pages) a vérifié la règle : aucune exécution de plus', async () => {
    const p = ports((_p, i) => run(2, i === 1 ? 'no_next' : 'max_pages_input'));
    const out = await runTrials([pair('fetch', 0.00005)], p, budget, paginated);
    expect(out.kind).toBe('conformant');
    expect(p.calls).toHaveLength(3);
    expect(p.log[0]!.stop_check).toMatchObject({ verified: true, stop: 'no_next' });
  });

  test('liste finie dès la page 1 (règle atteinte à la page 1 sur chaque exécution) : vérifiée, aucune exécution de plus', async () => {
    const p = ports(() => run(1, 'records_empty'));
    const out = await runTrials([pair('fetch', 0.00005)], p, budget, paginated);
    expect(out.kind).toBe('conformant');
    expect(p.calls).toHaveLength(3);
    expect(p.log[0]!.stop_check).toMatchObject({ verified: true, stop: 'records_empty', pages: 1 });
  });

  test('assert_pagination_stop_rule_last_page — liste plus longue que le plafond dur : la règle n’a pas pu être constatée, couple retenu, `verified: false` journalisé (jamais présenté comme vérifié)', async () => {
    const p = ports((_p, _i, purpose) => (purpose === 'sample' ? run(2, 'max_pages_input') : run(50, 'hard_max_pages', 0.002)));
    const out = await runTrials([pair('fetch', 0.00005)], p, budget, paginated);
    expect(out.kind).toBe('conformant');
    expect(p.log[0]!.stop_check).toMatchObject({ verified: false, stop: 'hard_max_pages', pages: 50 });
  });

  test('l’exécution de vérification n’a pas de page de plus que le plafond de coût d’un run : max_cost_usd dépassé → non vérifiée, pas un échec du couple', async () => {
    const p = ports((_p, _i, purpose) => (purpose === 'sample' ? run(2, 'max_pages_input') : { ...failed('run_budget_exceeded', 'max_cost_usd'), cost_usd: 0.1 }));
    const out = await runTrials([pair('fetch', 0.00005)], p, { ...budget, maxCostPerRunUsd: 0.05 }, paginated);
    expect(out.kind).toBe('conformant');
    expect(p.log[0]!.stop_check).toMatchObject({ verified: false, stop: null, reason: 'max_cost_usd' });
  });

  test('un échec de la vérification (page tardive hors schéma) est un échec du couple : même classe, le couple suivant est essayé (INV1)', async () => {
    const p = ports((q, _i, purpose) => (q.execution === 'fetch' && purpose === 'stop_check' ? failed('extraction', 'schema_mismatch') : run(2, 'max_pages_input')));
    const out = await runTrials([pair('fetch', 0.00005), pair('fetch_in_page', 0.00025)], p, budget, paginated);
    expect(out.kind).toBe('conformant');
    expect(p.log.map((o) => `${o.pair.execution}:${o.result}`)).toEqual(['fetch:extraction', 'fetch_in_page:ok']);
    expect(p.log[0]!.detail).toBe('schema_mismatch');
  });

  test('budget d’enquête épuisé pendant la vérification : budget_exhausted (on retient la meilleure stratégie, ou erreur — 04 §4)', async () => {
    const p = ports((_p, _i, purpose) => (purpose === 'sample' ? run(2, 'max_pages_input', 0.4) : ({ ...failed('run_budget_exceeded', 'max_cost_usd'), cost_usd: 0.1 })));
    const out = await runTrials([pair('fetch', 0.00005)], p, { ...budget, maxUsd: 1.3, maxCostPerRunUsd: 0.5 }, paginated);
    // 3 × 0,4 = 1,2 ; reste 0,1 : la vérification part sous ce plafond (inférieur à celui d'un run) et le consomme → arrêt budgétaire.
    expect(out.kind).toBe('budget_exhausted');
  });

  test('une stratégie sans pagination n’a rien à vérifier : 3 exécutions, aucune vérification, stop_check nul', async () => {
    const p = ports(() => run(1, 'no_pagination'));
    const out = await runTrials([pair('fetch', 0.00005)], p, budget, { paginated: () => false });
    expect(out.kind).toBe('conformant');
    expect(p.calls).toHaveLength(3);
    expect(p.log[0]!.stop_check).toBeNull();
  });
});
