// SPDX-License-Identifier: AGPL-3.0-only
// Refonte de Nouvelle API (3.17, 20 § 5.3, critères de 20b § 3.3) : porte d'accord avant tout essai, plan d'essais chiffré du
// moins cher au plus cher avec cartes élaguées grisées et sans carte « changer d'adresse », exemples réels des champs identiques
// d'une langue à l'autre. Rendu côté serveur sous Node ; le navigateur réel est dans e2e/catalog-new-api.e2e.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import en from '@/i18n/locales/en.json';
import fr from '@/i18n/locales/fr.json';
import { emptyInvestigation, ingestEvent, schemaFields, trialCards, type InvestigationState } from '@/lib/investigation';
import type { SseEvent } from '@/lib/sse';
import { view as render } from '@/testing/console.testkit';
import InvestigationBoard from './InvestigationBoard.vue';
import SchemaPanel from './SchemaPanel.vue';
import TrialPlan from './TrialPlan.vue';

const SAMPLE = [
  { titre: 'Les Misérables — édition « 2024 »', prix: 1234.5, auteur: 'Hugo, Victor', dispo: true, email: 'lecteur@exemple.test' },
  { titre: 'Le Rouge et le Noir', prix: 9, auteur: 'Stendhal', dispo: false, email: 'autre@exemple.test' },
];
const SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { titre: { type: 'string' }, prix: { type: 'number' }, auteur: { type: 'string' }, dispo: { type: 'boolean' }, email: { type: 'string', 'x-personal': true } },
  },
};

function awaiting(): InvestigationState {
  const state = emptyInvestigation();
  state.runId = 'r1';
  state.apiId = 'a1';
  state.slug = 'livres';
  state.domain = 'exemple.test';
  state.status = 'enquete';
  state.phase = 'awaiting_schema_validation';
  state.reachedPhase = 'awaiting_schema_validation';
  state.outputSchema = SCHEMA;
  state.sample = SAMPLE;
  state.budget = { spentUsd: 0.0123, maxUsd: 0.5, elapsedS: 12, timeoutS: 300, retainedEstUsd: 0.002, fullAgentEstUsd: 0.09, receivedAtMs: 0 };
  // Plan reçu dans le désordre : la console l'affiche du moins cher au plus cher.
  state.plan = [
    { execution: 'agent', network: 'direct', estCostUsd: 0.09 },
    { execution: 'fetch', network: 'direct', estCostUsd: 0.0004 },
    { execution: 'playwright', network: 'direct', estCostUsd: 0.003 },
  ];
  return state;
}

const props = (state: InvestigationState, extra: Record<string, unknown> = {}) => ({ state, elapsedS: 14, paused: false, cancelled: false, busy: null, failure: null, ...extra });
const frame = (name: string, data: Record<string, unknown>): SseEvent => ({ id: name, event: name, data: JSON.stringify(data) });

describe('assert_schema_gate_before_trials : aucun essai ne démarre avant l’accord, le coût engagé est dit', () => {
  test.each([['en', en], ['fr', fr]] as const)('%s : la porte dit qu’aucun essai ne démarre, le coût déjà dépensé, le budget et le bouton chiffré', async (locale, messages) => {
    const html = await render(InvestigationBoard, props(awaiting()), { locale });
    expect(html).toContain('data-testid="schema-gate"');
    expect(html).toContain(messages.investigation.gate.noTrial);
    expect(html).toContain('data-testid="gate-spent"');
    expect(html).toMatch(locale === 'en' ? /Already spent on the reconnaissance: \$0\.012/ : /Déjà dépensé pour la reconnaissance : 0,012\d*\s\$/u);
    expect(html).toContain('data-testid="gate-budget"');
    expect(html).toContain('data-testid="schema-validate"');
    expect(html).toMatch(locale === 'en' ? /Validate and start the trials · ~\$0\.50/ : /Valider et lancer les essais · ~0,50\s\$/u);
    expect(html).toContain('data-testid="schema-edit"');
    // La porte n'est pas le bandeau « validé automatiquement ».
    expect(html).not.toContain('data-testid="gate-auto"');
  });

  test('avant l’accord, aucune carte n’est lancée, réussie ni échouée : toutes sont « à essayer »', async () => {
    const html = await render(InvestigationBoard, props(awaiting()));
    const states = [...html.matchAll(/data-testid="trial-card" data-state="([a-z]+)"/g)].map((match) => match[1]);
    expect(states).toEqual(['planned', 'planned', 'planned']);
  });

  test('la phrase « Rien n’est enregistré » n’apparaît dans aucune langue de la console (u3 R6)', () => {
    const all = JSON.stringify(en) + JSON.stringify(fr);
    expect(all).not.toMatch(/rien n.est enregistr|nothing is saved|nothing has been saved/iu);
  });

  test('sous auto_validate : le bandeau « Schéma validé automatiquement, à ta demande » remplace la porte', async () => {
    const state = awaiting();
    state.phase = 'testing';
    state.validatedBy = 'auto';
    for (const [locale, messages] of [['en', en], ['fr', fr]] as const) {
      const html = await render(InvestigationBoard, props(state), { locale });
      expect(html).toContain('data-testid="gate-auto"');
      expect(html).toContain(messages.investigation.gate.auto.replace('’', '&#39;').replace('’', "'"));
      expect(html).not.toContain('data-testid="schema-gate"');
      expect(html).not.toContain('data-testid="schema-validate"');
    }
  });

  test('le flux : `schema.validated` par `auto` pose le bandeau, la validation de l’utilisateur ne le pose pas', () => {
    const auto = emptyInvestigation();
    auto.runId = 'r1';
    ingestEvent(auto, frame('schema.validated', { run_id: 'r1', by: 'auto' }), 1);
    expect(auto.validatedBy).toBe('auto');
    const user = emptyInvestigation();
    user.runId = 'r1';
    ingestEvent(user, frame('schema.validated', { run_id: 'r1' }), 1);
    expect(user.validatedBy).toBe('user');
  });

  test('le panneau n’émet `validate` que depuis l’action de l’utilisateur (bouton Valider ou Appliquer), jamais à l’affichage', () => {
    const source = readFileSync(new URL('./SchemaPanel.vue', import.meta.url), 'utf8');
    const emits = [...source.matchAll(/emit\('validate'/g)];
    expect(emits).toHaveLength(2);
    expect(source).toContain('@click="!busy && validateProposed()"');
    expect(source).toContain('@click="!busy && validateEdited()"');
    expect(source).not.toMatch(/onMounted|watch\(|immediate/);
  });
});

describe('assert_trial_plan_cheapest_first_ui : plan chiffré du moins cher au plus cher, élagués grisés, jamais de changement d’adresse', () => {
  test('les cartes numérotées suivent le coût croissant, quel que soit l’ordre reçu', async () => {
    const cards = trialCards(awaiting());
    expect(cards.map((card) => card.execution)).toEqual(['fetch', 'playwright', 'agent']);
    const html = await render(TrialPlan, { cards });
    expect(html).toMatch(/<ol/);
    const order = [...html.matchAll(/data-execution="([a-z_]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['fetch', 'playwright', 'agent']);
    expect(html.indexOf('~$0.0004')).toBeLessThan(html.indexOf('~$0.003'));
    expect(html.indexOf('~$0.003')).toBeLessThan(html.indexOf('~$0.09'));
  });

  test('une carte élaguée est grisée avec sa raison ; un couple jamais lancé après un refus aussi', async () => {
    const state = awaiting();
    state.phase = 'testing';
    state.attempts = [{ index: 0, execution: 'fetch', network: 'direct', state: 'done', result: 'extraction', costUsd: 0.0004, estCostUsd: 0.0004, ms: 240, prunedReason: null, why: null, error: null }];
    state.pruned = [{ execution: 'playwright', network: 'direct', estCostUsd: 0.003, source: null, reason: 'extraction' }];
    const cards = trialCards(state);
    expect(cards.map((card) => card.state)).toEqual(['failed', 'pruned', 'planned']);
    const html = await render(TrialPlan, { cards });
    expect(html).toMatch(/data-state="pruned"[^>]*data-execution="playwright"/);
    expect(html).toMatch(/border-dashed bg-muted text-muted-foreground[^"]*"[^>]*data-testid="trial-card" data-state="pruned"/);
    expect(html).toContain('Skipped:');
    const halted = trialCards(state, { halted: true });
    expect(halted.map((card) => card.state)).toEqual(['failed', 'pruned', 'pruned']);
  });

  test('une règle qui a réordonné le plan est respectée : la console ne le retrie pas', () => {
    const plan = [
      { execution: 'agent' as const, network: 'direct' as const, estCostUsd: 0.09, rule: 'rules/exemple.md' },
      { execution: 'fetch' as const, network: 'direct' as const, estCostUsd: 0.0004, rule: null },
    ];
    expect(trialCards({ plan, attempts: [], pruned: [] }).map((card) => card.execution)).toEqual(['agent', 'fetch']);
  });

  test.each([['en', en], ['fr', fr]] as const)('%s : aucune carte « changer d’adresse » ni proxy proposé après un refus ; la branche mène à l’arrêt volontaire', async (locale, messages) => {
    const html = await render(TrialPlan, { cards: trialCards(awaiting()) }, { locale });
    expect(html).toContain('data-testid="trial-stop-branch"');
    expect(html).toContain(messages.investigation.plan.stop.title);
    // Les seules cartes sont celles du plan du serveur : aucune carte ajoutée par la console.
    expect((html.match(/data-testid="trial-card"/g) ?? []).length).toBe(3);
    expect(html).not.toMatch(/changer d.adresse|change (the )?address|change (the )?ip|another proxy|autre proxy|residential|résidentiel|tunnel/iu);
  });
});

describe('assert_schema_examples_untranslated : le même échantillon donne les mêmes exemples, octet pour octet, en fr et en en', () => {
  const examples = (html: string): string[] => [...html.matchAll(/data-testid="schema-example">([^<]*)<\/code>/g)].map((match) => match[1] ?? '');

  test('exemples identiques dans les deux langues, balisés translate="no"', async () => {
    const panel = (state: InvestigationState) => ({
      outputSchema: state.outputSchema,
      sample: state.sample,
      inputSchema: null,
      strategy: null,
      phase: state.phase,
      cards: trialCards(state),
      budget: state.budget,
      validatedBy: null,
    });
    const state = awaiting();
    const htmlEn = await render(SchemaPanel, panel(state), { locale: 'en' });
    const htmlFr = await render(SchemaPanel, panel(state), { locale: 'fr' });
    expect(examples(htmlEn)).toEqual(examples(htmlFr));
    expect(examples(htmlEn)).toHaveLength(5);
    expect(htmlEn).toContain('translate="no"');
    // Valeurs de l'échantillon, sans mise en forme selon la langue : 1234.5 reste 1234.5 (pas « 1 234,5 »).
    expect(htmlFr).toContain('1234.5');
    expect(htmlFr).toContain('Les Misérables — édition « 2024 »');
    expect(htmlFr).not.toMatch(/1\s234,5/u);
    // Mais les libellés autour, eux, sont traduits.
    expect(htmlEn).toContain(en.investigation.schema.gateTitle);
    expect(htmlFr).toContain(fr.investigation.schema.gateTitle.replace('’', '&#39;'));
  });

  test('un exemple vient de l’échantillon, jamais inventé : champ absent de l’échantillon = « pas d’exemple » ; champ personnel masqué ; 120 caractères au plus', () => {
    const long = 'é'.repeat(300);
    const fields = schemaFields(
      { type: 'object', properties: { titre: { type: 'string' }, absent: { type: 'string' }, email: { type: 'string', 'x-personal': true }, long: { type: 'string' } } },
      [{ titre: null, email: 'a@b.test', long }, { titre: 'Deuxième ligne', email: 'c@d.test', long }],
    );
    const byName = Object.fromEntries(fields.map((field) => [field.name, field]));
    expect(byName.titre?.example).toBe('Deuxième ligne');
    expect(byName.absent?.example).toBeNull();
    expect(byName.email?.example).toBe('•••');
    expect(byName.email?.personal).toBe(true);
    expect(Array.from(byName.long?.example ?? '')).toHaveLength(121);
    expect(byName.long?.example?.endsWith('…')).toBe(true);
  });
});
