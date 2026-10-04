// SPDX-License-Identifier: AGPL-3.0-only
// U1.12 : causes exactes de l'enquête, côté noyau (assert_reason_matches_cause). Le détail d'un échec d'essai porte ses
// paramètres (`minimal_content` : champ et raison ; moteur agentique : classe d'erreur) jusqu'à l'essai journalisé, et le
// différentiel d'une compilation refusée est publié PAR CHAMP : nombre d'écarts et deux exemples attendu/obtenu (UX-37).
import { describe, expect, test } from 'vitest';
import { buildHtmlStrategy, verifyHtmlStrategy, type HtmlCompileProposal } from './html-compile.js';
import { runTrials, type PairOutcome, type TrialExecution, type TrialPorts } from './trials.js';
import type { TrialPair } from './plan.js';
import { minimalContentCheck } from '../quality/minimal.js';

const pair = (execution: TrialPair['execution'], est: number): TrialPair => ({ execution, network: 'direct', source: 'c1', est_cost_usd: est });
const okRun: TrialExecution = { ok: true, failure_class: null, detail: null, records: 10, pages: 1, stop: 'no_pagination', cost_usd: 0.0001, ms: 5 };
const budget = { maxUsd: 1, spentUsd: 0, deadlineMs: 1_000_000, maxAttempts: 12, maxCostPerRunUsd: 0.5 };

function ports(extra: Partial<TrialPorts>): TrialPorts & { finishedLog: PairOutcome[] } {
  const finishedLog: PairOutcome[] = [];
  return { finishedLog, now: () => 0, execute: async () => okRun, finished: async (o) => void finishedLog.push(o), pruned: async () => undefined, ...extra };
}

describe('U1.12 : les paramètres de la cause suivent l’essai jusqu’à son journal', () => {
  test('contenu minimal : le champ et la raison du contrôle sortent dans l’essai (UX-21)', async () => {
    const p = ports({ contentCheck: () => ({ failure_class: 'extraction', detail: 'minimal_content', params: { field: 'in_stock', reason: 'constant' } }) });
    await runTrials([pair('fetch', 0.00005)], p, budget);
    expect(p.finishedLog[0]).toMatchObject({ result: 'extraction', detail: 'minimal_content', params: { field: 'in_stock', reason: 'constant' } });
  });

  test('échec d’exécution : les paramètres de l’exécution (classe du moteur agentique) sortent dans l’essai (UX-23)', async () => {
    const p = ports({ execute: async () => ({ ...okRun, ok: false, failure_class: 'code_error', detail: 'agent_engine_error', params: { class: 'chromium_launch_signal' }, records: 0, pages: 0, stop: null }) });
    await runTrials([pair('agent', 0.2)], p, budget);
    expect(p.finishedLog[0]).toMatchObject({ result: 'code_error', detail: 'agent_engine_error', params: { class: 'chromium_launch_signal' } });
  });

  test('un essai conforme ou sans paramètre n’en porte aucun', async () => {
    const p = ports({});
    await runTrials([pair('fetch', 0.00005)], p, budget);
    expect(p.finishedLog[0]!.params).toBeUndefined();
  });

  test('le contrôle de contenu minimal rend le champ et la raison (champ constant, champ vide)', () => {
    const schema = { type: 'object', required: ['in_stock', 'url'], properties: { in_stock: { type: 'boolean' }, url: { type: 'string' } } };
    const constant = minimalContentCheck([[{ in_stock: true, url: 'a' }, { in_stock: true, url: 'b' }]], schema);
    expect(constant).toMatchObject({ ok: false, field: 'in_stock', reason: 'constant' });
    const empty = minimalContentCheck([[{ in_stock: true, url: null }, { in_stock: false, url: null }]], schema);
    expect(empty).toMatchObject({ ok: false, field: 'url', reason: 'sentinel' });
  });
});

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['title', 'price'],
  properties: { title: { type: 'string' }, price: { type: 'number' }, agency: { type: 'string' } },
  additionalProperties: false,
};
const NAMES = ['Anna', 'Bruno', 'Chloe', 'David', 'Emma', 'Farid'];
const HTML = `<ol>${NAMES.map((n, i) => `<li class="p"><h3>${n} Martin</h3><b class="pr">${10 + i}</b><i class="ag">Agence ${i % 2 === 0 ? 'Nord' : 'Sud'}</i></li>`).join('')}</ol>`;
// L'agent a lu une agence que la page ne donne pas : tous les éléments divergent sur ce champ, aucun sur les autres.
const ITEMS = NAMES.map((n, i) => ({ title: `${n} Martin`, price: 10 + i, agency: `Siège ${i}` }));
const op = (name: string) => ({ op: name, pattern: null, group: null, decimal: null, format: null });
const PROPOSAL: HtmlCompileProposal = {
  records: 'li.p',
  fields: [
    { field: 'title', css: 'h3', attr: 'text', ops: [op('trim')] },
    { field: 'price', css: '.pr', attr: 'text', ops: [op('to_number')] },
    { field: 'agency', css: '.ag', attr: 'text', ops: [op('trim')] },
  ],
};

describe('U1.12 : différentiel par champ d’une compilation refusée (UX-37)', () => {
  const built = buildHtmlStrategy(PROPOSAL, { pageUrl: 'https://zz-test.example/', allowedHosts: ['zz-test.example'], outputSchema: SCHEMA });
  if (!built.ok) throw new Error('construction');
  const check = verifyHtmlStrategy(built.spec, HTML, ITEMS, SCHEMA);

  test('chaque champ comparé donne son nombre de valeurs comparées et d’écarts', () => {
    expect(check.ok).toBe(false);
    const byField = Object.fromEntries(check.diff.fields.map((f) => [f.field, f]));
    expect(byField['agency']).toMatchObject({ compared: 6, mismatched: 6 });
    expect(byField['title']).toMatchObject({ compared: 6, mismatched: 0, examples: [] });
    expect(byField['price']).toMatchObject({ compared: 6, mismatched: 0 });
  });

  test('deux exemples attendu/obtenu au plus par champ en écart', () => {
    const agency = check.diff.fields.find((f) => f.field === 'agency')!;
    expect(agency.examples).toHaveLength(2);
    expect(agency.examples[0]).toEqual({ expected: 'Siège 0', got: 'Agence Nord' });
  });

  test('un refus avant comparaison (extraction impossible) porte une liste vide, jamais undefined', () => {
    const none = verifyHtmlStrategy(built.spec, '<p>rien</p>', ITEMS, SCHEMA);
    expect(none.diff.fields).toEqual([]);
  });
});
