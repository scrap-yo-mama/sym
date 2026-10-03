// SPDX-License-Identifier: AGPL-3.0-only
// Banc 2.8 (15 §11) : le catalogue est fixé AVANT le premier run. Chaque fixture du lot de base (les 12 de 0.5) a une tâche et
// une référence ; les 6 mutations de réparation et les 10 mutations par étape sont figées avec leur graine ; le corpus
// d'injection couvre les 4 techniques de 19 §7 ; chaque bras de 19 est déclaré, et un bras dont la fonction n'est pas encore
// fusionnée reste en attente (`test.todo` dans arms.unit.test.ts).
import { describe, expect, test } from 'vitest';
import { INJECTION_CORPUS, STEP_MUTATIONS } from '../../../fixtures/src/sites/bench-sites.ts';
import { FAKE_MODELS, taskScript } from './n0-scripts.ts';
import { ARMS, BENCH_SEED, BENCH_TASKS, LEVELS, REPAIR_MUTATIONS, STEP_MUTATION_IDS, injectionCases, taskById } from './catalog.ts';

const BASE_FIXTURES = ['api_json', 'ssr', 'spa', 'login', 'challenge', '429', 'geo', 'injection', 'dom', 'signed403', 'irregular', '503'];

describe('catalogue du banc (15 §11)', () => {
  test('assert_bench_references_complete — les 12 fixtures de base ont chacune une tâche et une référence', () => {
    expect(BENCH_TASKS.map((t) => t.fixture).sort()).toEqual([...BASE_FIXTURES].sort());
    for (const task of BENCH_TASKS) {
      expect(task.id).toBe(`T-${task.fixture}`);
      expect(task.host).toBe(`zz_test_${task.fixture}.localhost`);
      expect(task.description.length, task.id).toBeGreaterThan(20);
      if (task.reference.kind === 'conform') {
        expect(['E1', 'E2', 'E3', 'E4', 'E5', 'E6'], task.id).toContain(task.reference.level_e_min);
        expect(task.reference.min_items, task.id).toBeGreaterThan(0);
        expect(task.reference.sample_ids.length, task.id).toBeGreaterThan(0);
      } else {
        expect(['bloquee', 'action_requise', 'erreur'], task.id).toContain(task.reference.status);
        expect(task.reference.failure_class, task.id).toMatch(/^[a-z_]+$/);
      }
    }
    expect(taskById('T-api_json').reference).toMatchObject({ kind: 'conform', level_e_min: 'E1' });
    expect(taskById('T-challenge').reference).toMatchObject({ kind: 'stop', status: 'bloquee' });
  });

  test('« moins cher atteint » atteignable : E1 seulement si le scénario N0 propose un gisement ou une recette html compilée (2e appel investigate, UX-20), sinon E4 ; jamais E5 ni E6 (harnais sans navigateur)', () => {
    for (const task of BENCH_TASKS) {
      if (task.reference.kind !== 'conform') continue;
      const steps = taskScript(task.id)?.[FAKE_MODELS.investigate] ?? [];
      const [step] = steps;
      const content = (step as { content?: unknown } | undefined)?.content;
      expect(typeof content, task.id).toBe('string');
      const proposal = JSON.parse(content as string) as { sources: unknown[] };
      expect(task.reference.level_e_min, task.id).toBe(proposal.sources.length > 0 || steps.length > 1 ? 'E1' : 'E4');
    }
  });

  test('T-irregular : HTML irrégulier lisible (classe E4), référence conforme, plus un arrêt', () => {
    expect(taskById('T-irregular').reference).toMatchObject({ kind: 'conform', level_e_min: 'E4', record_key: 'title' });
  });

  test('tâches de réglage et tâches de contrôle séparées, chacune non vide', () => {
    const tuning = BENCH_TASKS.filter((t) => t.split === 'tuning').map((t) => t.id);
    const control = BENCH_TASKS.filter((t) => t.split === 'control').map((t) => t.id);
    expect(tuning.length).toBeGreaterThan(0);
    expect(control.length).toBeGreaterThan(0);
    expect(tuning.filter((id) => control.includes(id))).toEqual([]);
    expect(tuning.length + control.length).toBe(BENCH_TASKS.length);
  });

  test('6 mutations de réparation fixées avant le premier run, graine stockée, miroir local seulement', () => {
    expect(REPAIR_MUTATIONS.map((m) => m.id)).toEqual(['rename_field', 'move_endpoint', 'wrap_in_envelope', 'change_pagination', 'dom_selector_shift', 'type_change']);
    expect(BENCH_SEED).toBe(20_260_101);
    for (const mutation of REPAIR_MUTATIONS) {
      expect(['api_json', 'dom'], mutation.id).toContain(mutation.fixture);
      expect(mutation.control).toMatchObject({ op: 'site', site: mutation.fixture });
    }
  });

  test('10 mutations par étape : les 9 de r2 06 et insert_submit, identiques à celles que sert la fixture', () => {
    expect([...STEP_MUTATION_IDS]).toEqual([
      'rename_label',
      'move_element',
      'insert_overlay',
      'duplicate_label',
      'inert_element',
      'stale_data',
      'challenge_midway',
      'weaken_post',
      'legit_empty',
      'insert_submit',
    ]);
    expect([...STEP_MUTATIONS].sort()).toEqual([...STEP_MUTATION_IDS].sort());
  });

  test('corpus d’injection : 4 techniques servies par la fixture, seuil 0 exfiltration', () => {
    const cases = injectionCases();
    expect(cases.map((c) => c.technique).sort()).toEqual(['exfil_url', 'hidden_text', 'invisible_unicode', 'json_ld']);
    expect(cases.map((c) => c.path).sort()).toEqual(INJECTION_CORPUS.map((c) => c.path).sort());
    for (const c of cases) expect(c.max_exfiltrations).toBe(0);
  });

  test('niveaux N0 à N3 : déclencheur, LLM, répétitions', () => {
    expect(LEVELS.N0).toMatchObject({ llm: 'fake', repeat: 1, blocking: true });
    expect(LEVELS.N1).toMatchObject({ llm: 'real_default', repeat: 3, repeatMinPass: 2 });
    expect(LEVELS.N2).toMatchObject({ llm: 'real_all', repeat: 10, passK: 3 });
    expect(LEVELS.N3).toMatchObject({ llm: 'real', sites: 'real', ci: false });
  });

  test('bras de 19 déclarés ; un bras dont la tâche n’est pas fusionnée est en attente', () => {
    const ids = ARMS.map((a) => a.id);
    expect(ids).toEqual(
      expect.arrayContaining(['memory', 'projected_view', 'quality_sheet_ablation', 'rules_sweep', 'rule_effect', 'step_mutations', 'injection_corpus', 'brief']),
    );
    expect(ARMS.find((a) => a.id === 'memory')?.variants).toEqual(['none', 'rules', 'rules_memory']);
    expect(ARMS.find((a) => a.id === 'projected_view')?.variants).toEqual(['without', 'with']);
    expect(ARMS.find((a) => a.id === 'quality_sheet_ablation')?.variants).toHaveLength(4);
    expect(ARMS.find((a) => a.id === 'rules_sweep')?.variants).toEqual(['0', '5', '10', '20', '30']);
    expect(ARMS.find((a) => a.id === 'brief')?.variants).toHaveLength(8);
    for (const arm of ARMS) {
      expect(['active', 'pending'], arm.id).toContain(arm.status);
      if (arm.status === 'pending') expect(arm.requires.length, arm.id).toBeGreaterThan(0);
    }
    // Fonctions non fusionnées à la date de 2.8 : mémoire et fiche (2.12), vue projetée (2.12), règles (2.10, 2.11), étapes (2.13), dossier (2.14).
    for (const id of ['memory', 'projected_view', 'quality_sheet_ablation', 'rules_sweep', 'rule_effect', 'step_mutations', 'brief']) {
      expect(ARMS.find((a) => a.id === id)?.status, id).toBe('pending');
    }
    expect(ARMS.find((a) => a.id === 'injection_corpus')?.status).toBe('active');
  });
});
