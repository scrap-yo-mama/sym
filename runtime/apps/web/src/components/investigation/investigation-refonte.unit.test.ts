// SPDX-License-Identifier: AGPL-3.0-only
// Refonte de Nouvelle API (3.17, 20 § 5.3, critères de 20b § 3.3) : porte d'accord avant tout essai, plan d'essais chiffré du
// moins cher au plus cher avec cartes élaguées grisées et sans carte « changer d'adresse », exemples réels des champs identiques
// d'une langue à l'autre. Rendu côté serveur sous Node ; le navigateur réel est dans e2e/catalog-new-api.e2e.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import en from '@runtime/i18n/locales/en.json';
import fr from '@runtime/i18n/locales/fr.json';
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
    // Montant au format Intl de 3.20 (assert_intl_formats_by_locale, U2) : 2 décimales à partir de 0,01 $ (0,0123 → 0,01).
    expect(html).toMatch(locale === 'en' ? /Already spent on the reconnaissance: \$0\.01\./ : /Déjà dépensé pour la reconnaissance : 0,01\s\$\./u);
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
    expect(html).toMatch(/border-dashed[^"]*bg-muted text-muted-foreground[^"]*"[^>]*data-testid="trial-card" data-state="pruned"/);
    expect(html).toContain('Skipped:');
    const halted = trialCards(state, { halted: true });
    expect(halted.map((card) => card.state)).toEqual(['failed', 'pruned', 'pruned']);
  });

  test.each([
    ['403', 'forbidden'],
    ['défi', 'blocked_by_protection'],
    ['robots.txt', 'robots_disallowed'],
  ] as const)('après un refus (%s → bloquee), aucune carte proxy ni changement d’adresse : le plan direct + dc_proxy du serveur ne montre plus que le direct', async (_label, code) => {
    // Plan réel du serveur (enquête avec une politique direct + proxy serveur, cf. le test d'intégration du worker).
    const state = emptyInvestigation();
    state.runId = 'r9';
    const events: [string, Record<string, unknown>][] = [
      ['investigation.started', { run_id: 'r9', domain: 'exemple.test' }],
      ['schema.proposed', { run_id: 'r9', output_schema: SCHEMA, sample: SAMPLE }],
      [
        'phase.started',
        {
          run_id: 'r9',
          phase: 'testing',
          plan: [
            { execution: 'fetch', network: 'direct', est_cost_usd: 0.0004 },
            { execution: 'fetch', network: 'dc_proxy', est_cost_usd: 0.0021 },
            { execution: 'playwright', network: 'direct', est_cost_usd: 0.003 },
            { execution: 'playwright', network: 'dc_proxy', est_cost_usd: 0.006 },
          ],
        },
      ],
      ['attempt.finished', { run_id: 'r9', attempt: { index: 0, execution: 'fetch', network: 'direct', state: 'done', est_cost_usd: 0.0004, result: code, cost_usd: 0.0004, ms: 120 } }],
      ['status.changed', { run_id: 'r9', status: 'bloquee', status_reason: { code, params: {}, message: 'zz' } }],
    ];
    for (const [name, data] of events) ingestEvent(state, frame(name, data), 0);
    expect(state.status).toBe('bloquee');
    expect(state.blocked).not.toBeNull();
    for (const locale of ['fr', 'en'] as const) {
      const html = await render(InvestigationBoard, props(state), { locale });
      const plan = html.slice(html.indexOf('data-testid="trial-plan"'));
      const shown = [...plan.matchAll(/data-testid="trial-card"[^>]*data-execution="([a-z_]+)"[^>]*>([\s\S]*?)<\/li>/g)].map((match) => `${match[1]}:${match[2] ?? ''}`);
      expect(shown.length, locale).toBe(2);
      // Ni carte proxy, ni « changer d'adresse » : le refus mène à l'arrêt volontaire.
      expect(plan).not.toMatch(/proxy serveur|server proxy|datacenter|dc_proxy|résidentiel|residential|changer d.adresse|change (the )?address/iu);
      expect(plan).toContain('data-testid="trial-stop-branch"');
    }
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

  test.each(['awaiting_schema_validation', 'testing', 'done'] as const)('%s : un champ x-personal est masqué partout sur le panneau, échantillon brut compris (jamais la valeur en clair)', async (phase) => {
    const state = awaiting();
    state.phase = phase;
    if (phase !== 'awaiting_schema_validation') state.validatedBy = 'user';
    for (const locale of ['fr', 'en'] as const) {
      const html = await render(InvestigationBoard, props(state), { locale });
      expect(html, `${phase}/${locale}`).toContain('data-testid="schema-panel"');
      expect(html, `${phase}/${locale}`).not.toContain('lecteur@exemple.test');
      expect(html, `${phase}/${locale}`).not.toContain('autre@exemple.test');
      // Hors de la porte, l'échantillon brut est montré : ses autres valeurs restent lisibles telles quelles.
      if (phase !== 'awaiting_schema_validation') expect(html, `${phase}/${locale}`).toContain('Le Rouge et le Noir');
    }
  });
});

describe('assert_schema_remark_not_sent : « Une remarque pour SYM ? » n’envoie rien tant qu’aucun contrat ne la porte', () => {
  // InvestigateRequest (OpenAPI, 3.1) n'a pas de `note` et refuse toute propriété en plus (400) ; ni le serveur ni le worker ne
  // liraient la remarque, et une relance referait (et paierait) toute la reconnaissance. Le champ de la planche reste, sans envoi.
  const source = readFileSync(new URL('./SchemaPanel.vue', import.meta.url), 'utf8');
  const composable = readFileSync(new URL('../../composables/useInvestigation.ts', import.meta.url), 'utf8');

  test('le panneau du schéma n’émet aucune relance et n’a pas de bouton d’envoi de la remarque', () => {
    expect(source).not.toMatch(/emit\('reinvestigate'/);
    expect(source).not.toContain('schema-remark-send');
    expect(source).not.toContain('reinvestigateWithNote');
    // Le champ de la planche reste (D-60) : libellé « Une remarque pour SYM ? » et son exemple.
    expect(source).toContain('id="schema-remark"');
  });

  test('l’écart de texte à la planche (D-60) est consigné dans 20 § 5.3, aide mot pour mot ; les écarts de mise en page du Catalogue dans 20 § 5.2', () => {
    const spec = readFileSync(new URL('../../../../../../cdc/scrapyomama-runtime/20-specs-marque-ux.md', import.meta.url), 'utf8');
    const section = (title: string): string => {
      const start = spec.indexOf(title);
      return start < 0 ? '' : spec.slice(start, spec.indexOf('\n### ', start + title.length));
    };
    const newApi = section('### 5.3 Nouvelle API');
    expect(newApi).toContain(fr.investigation.schema.remarkHint);
    expect(newApi).toContain('assert_schema_remark_not_sent');
    expect(newApi).toContain(fr.investigation.plan.include);
    const catalog = section('### 5.2 Catalogue');
    for (const words of ['Suspendre le suivi', 'slug', 'Règles & skills', 'Voir un exemple avec la démo']) expect(catalog, words).toContain(words);
  });

  test('la ré-enquête n’envoie jamais de `note` (le corps de POST /api/apis/{slug}/investigate est celui de l’OpenAPI)', () => {
    expect(composable).not.toMatch(/\bnote\b/);
  });

  test.each([['en', en], ['fr', fr]] as const)('%s : l’aide du champ ne promet aucun envoi, et le libellé d’envoi a disparu', (_locale, messages) => {
    const schema = messages.investigation.schema as unknown as Record<string, unknown>;
    expect(schema.reinvestigateWithNote).toBeUndefined();
    expect(schema.remarkHint).not.toMatch(/envoy|sent with|transmise avec/iu);
  });

  test('rendu de la porte : le champ est là, aucun bouton d’envoi', async () => {
    const html = await render(InvestigationBoard, props(awaiting()), { locale: 'fr' });
    expect(html).toContain('id="schema-remark"');
    expect(html).not.toContain('schema-remark-send');
  });

  test.each([['en', en], ['fr', fr]] as const)('%s : l’aide « ne part nulle part » est VISIBLE sous le champ (pas seulement lue par un lecteur d’écran)', async (locale, messages) => {
    const html = await render(InvestigationBoard, props(awaiting()), { locale });
    const hint = /<p[^>]*id="schema-remark-hint"[^>]*>([\s\S]*?)<\/p>/.exec(html);
    expect(hint, locale).not.toBeNull();
    const tag = hint?.[0].slice(0, hint[0].indexOf('>')) ?? '';
    expect(tag, locale).not.toMatch(/\bsr-only\b|\bhidden\b|aria-hidden/);
    expect(tag, locale).toContain('data-testid="schema-remark-hint"');
    expect(hint?.[1]?.replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim(), locale).toBe(messages.investigation.schema.remarkHint);
    // Le champ reste décrit par cette aide visible : voyants et lecteurs d'écran lisent la même chose.
    expect(html, locale).toMatch(/id="schema-remark"[^>]*aria-describedby="schema-remark-hint"|aria-describedby="schema-remark-hint"[^>]*id="schema-remark"/);
  });
});

describe('assert_trial_plan_pruned_on_refusal : un refus retire les couples proxy ou tunnel dès l’essai refusé, sans attendre `bloquee`', () => {
  const PLAN = [
    { execution: 'fetch', network: 'direct', est_cost_usd: 0.0004 },
    { execution: 'fetch', network: 'dc_proxy', est_cost_usd: 0.0021 },
    { execution: 'playwright', network: 'direct', est_cost_usd: 0.003 },
    { execution: 'playwright', network: 'tunnel', est_cost_usd: 0.004 },
    { execution: 'playwright', network: 'dc_proxy', est_cost_usd: 0.006 },
  ];

  test.each(['forbidden', 'blocked_by_protection', 'robots_disallowed', 'challenge_in_tunnel'])(
    'essai rendu en %s, puis attempt.pruned, statut pas encore reçu : seuls les couples directs restent, aucune carte proxy ni tunnel',
    async (code) => {
      const state = emptyInvestigation();
      state.runId = 'r7';
      const events: [string, Record<string, unknown>][] = [
        ['investigation.started', { run_id: 'r7', domain: 'exemple.test' }],
        ['schema.proposed', { run_id: 'r7', output_schema: SCHEMA, sample: SAMPLE }],
        ['phase.started', { run_id: 'r7', phase: 'testing', plan: PLAN }],
        ['attempt.finished', { run_id: 'r7', attempt: { index: 0, execution: 'fetch', network: 'direct', state: 'done', est_cost_usd: 0.0004, result: code, cost_usd: 0.0004, ms: 120 } }],
        ['attempt.pruned', { run_id: 'r7', reason: code, pruned: PLAN.slice(1) }],
      ];
      for (const [name, data] of events) ingestEvent(state, frame(name, data), 0);
      expect(state.blocked).toBeNull();
      const cards = trialCards(state);
      expect(cards.map((card) => `${card.execution}|${card.network}`)).toEqual(['fetch|direct', 'playwright|direct']);
      for (const locale of ['fr', 'en'] as const) {
        const html = await render(InvestigationBoard, props(state), { locale });
        const plan = html.slice(html.indexOf('data-testid="trial-plan"'));
        expect((plan.match(/data-testid="trial-card"/g) ?? []).length, locale).toBe(2);
        expect(plan, locale).not.toMatch(/dc_proxy|proxy serveur|server proxy|datacenter|tunnel/iu);
      }
    },
  );

  test('un échec qui n’est pas un refus (extraction) laisse le plan entier : le couple proxy reste « à essayer »', () => {
    const state = emptyInvestigation();
    state.runId = 'r8';
    ingestEvent(state, frame('phase.started', { run_id: 'r8', phase: 'testing', plan: PLAN }), 0);
    ingestEvent(state, frame('attempt.finished', { run_id: 'r8', attempt: { index: 0, execution: 'fetch', network: 'direct', state: 'done', est_cost_usd: 0.0004, result: 'extraction', cost_usd: 0.0004, ms: 120 } }), 0);
    expect(trialCards(state)).toHaveLength(PLAN.length);
  });
});
