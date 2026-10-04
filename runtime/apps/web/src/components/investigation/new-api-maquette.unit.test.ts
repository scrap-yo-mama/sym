// SPDX-License-Identifier: AGPL-3.0-only
// Fidélité de Nouvelle API (jalon 3, la porte) à sa planche (3.17, D-60, 20 § 5.3 ; maquette-ux/latest/project/NouvelleApi.dc.html
// du CDC) : textes repris MOT POUR MOT en français, même structure en trois cartes (schéma en liste, plan d'essais sur fond bleu,
// bulle « SYM 👻 : » anthracite puis budget et boutons), titres Bricolage aux tailles de la planche, pastilles numérotées sur les
// surfaces de la planche (jaune, lilas, orange, toujours à texte anthracite : 20 § 1.3). Seules les données fictives deviennent
// réelles (« les livres » : les données du domaine enquêté ; montants : ceux du serveur). Écarts gardés, justifiés par 20 § 5.3 :
// coût dans le bouton (« · ~{max} »), cartes élaguées et branche « Arrêt volontaire », icône SVG au lieu de l'emoji (20 § 1.4 e).
// La comparaison visuelle côte à côte est e2e/maquette-fidelity.e2e.ts.
import { describe, expect, test } from 'vitest';
import en from '@runtime/i18n/locales/en.json';
import fr from '@runtime/i18n/locales/fr.json';
import { emptyInvestigation, trialCards, type InvestigationState } from '@/lib/investigation';
import { view as render } from '@/testing/console.testkit';
import { textOf } from '@/testing/console-fixtures';
import InvestigationBoard from './InvestigationBoard.vue';
import PhaseTimeline from './PhaseTimeline.vue';
import TrialPlan from './TrialPlan.vue';

/** Textes de la planche Nouvelle API, repris mot pour mot (fr). */
const MAQUETTE = {
  schemaTitle: 'Voici ce que tu vas récupérer',
  remark: 'Une remarque pour SYM ?',
  remarkPlaceholder: "ex. le prix en euros, ajoute l'URL du livre",
  types: { string: 'texte', number: 'nombre', boolean: 'oui / non' },
  planTitle: "Le plan d'essais",
  planHint: "Du moins cher au plus cher. SYM s'arrête au premier qui marche.",
  cards: {
    fetch: ['Fetch direct', 'HTML de la page, sans navigateur'],
    playwright: ['Navigateur', 'si la page se construit en JavaScript'],
    agent: ['Agent', 'en dernier recours, puis compilé'],
  },
  footer: 'Estimations · règle appliquée : escalade-par-defaut.md',
  gate: "On valide ce schéma ?",
  noTrial: 'Aucun essai ne démarre avant ton accord. Déjà dépensé pour la reconnaissance : ',
  budget: "Budget max de l'enquête",
  replay: 'Rejeu ensuite : environ ',
  replayEnd: ', sans IA.',
  validate: 'Valider et lancer les essais',
  edit: 'Modifier le schéma',
  milestones: ['1 · Décrire', '2 · Reconnaître', '3 · Valider le schéma', '4 · Essayer'],
};

function awaiting(): InvestigationState {
  const state = emptyInvestigation();
  state.runId = 'r1';
  state.apiId = 'a1';
  state.slug = 'livres';
  state.domain = 'books.toscrape.com';
  state.status = 'enquete';
  state.phase = 'awaiting_schema_validation';
  state.reachedPhase = 'awaiting_schema_validation';
  state.outputSchema = { type: 'array', items: { type: 'object', properties: { titre: { type: 'string' }, prix: { type: 'number' }, en_stock: { type: 'boolean' }, note: { type: 'integer', minimum: 1, maximum: 5 } } } };
  state.sample = [{ titre: 'A Light in the Attic', prix: 51.77, en_stock: true, note: 3 }];
  state.budget = { spentUsd: 0.01, maxUsd: 0.1, elapsedS: 12, timeoutS: 300, retainedEstUsd: 0.0004, fullAgentEstUsd: 0.04, receivedAtMs: 0 };
  state.plan = [
    { execution: 'fetch', network: 'direct', estCostUsd: 0.0004 },
    { execution: 'playwright', network: 'direct', estCostUsd: 0.003 },
    { execution: 'agent', network: 'direct', estCostUsd: 0.04 },
  ];
  return state;
}

const props = (state: InvestigationState) => ({ state, elapsedS: 14, paused: false, cancelled: false, busy: null, failure: null });
const section = (html: string, id: string): string => {
  const start = html.indexOf(`aria-labelledby="${id}"`);
  return start < 0 ? '' : html.slice(start, html.indexOf('</section>', start));
};

describe('fidélité à la planche Nouvelle API (D-60) : textes mot pour mot', () => {
  test('schéma, plan, porte, budget, boutons : les chaînes françaises sont celles de la planche', () => {
    expect(fr.investigation.schema.gateTitle).toBe(MAQUETTE.schemaTitle);
    expect(fr.investigation.schema.remark).toBe(MAQUETTE.remark);
    expect(fr.investigation.schema.remarkPlaceholder).toBe(MAQUETTE.remarkPlaceholder);
    expect(fr.investigation.schema.types.string).toBe(MAQUETTE.types.string);
    expect(fr.investigation.schema.types.number).toBe(MAQUETTE.types.number);
    expect(fr.investigation.schema.types.boolean).toBe(MAQUETTE.types.boolean);
    expect(fr.investigation.plan.title).toBe(MAQUETTE.planTitle);
    expect(fr.investigation.plan.hint).toBe(MAQUETTE.planHint);
    for (const [execution, [title, text]] of Object.entries(MAQUETTE.cards)) {
      expect(fr.investigation.plan.card[execution as keyof typeof MAQUETTE.cards]).toEqual({ title, text });
    }
    expect(fr.investigation.gate.budget).toBe(MAQUETTE.budget);
    expect(fr.investigation.gate.edit).toBe(MAQUETTE.edit);
    expect(fr.investigation.gate.validateNoMax).toBe(MAQUETTE.validate);
  });

  test('rendu de la porte en français : bulle « SYM : » parlante, phrases de la planche, données réelles', async () => {
    const html = await render(InvestigationBoard, props(awaiting()), { locale: 'fr' });
    const go = section(html, 'gate-title');
    expect(go).toMatch(/data-sym-signature[^>]*data-variant="speaking"/);
    expect(textOf(go)).toContain("J'ai trouvé les données de books.toscrape.com. On valide ce schéma ?");
    expect(textOf(go)).toMatch(/Aucun essai ne démarre avant ton accord\. Déjà dépensé pour la reconnaissance : 0,01\s\$\./u);
    expect(textOf(go)).toContain(MAQUETTE.budget);
    expect(textOf(go)).toMatch(/Rejeu ensuite : environ ~?0,0004\s\$, sans IA\./u);
    const plan = section(html, 'trial-plan-title');
    expect(textOf(plan)).toContain(MAQUETTE.planTitle);
    expect(textOf(plan)).toContain(MAQUETTE.planHint);
    for (const [title, text] of Object.values(MAQUETTE.cards)) {
      expect(textOf(plan)).toContain(title);
      expect(textOf(plan)).toContain(text);
    }
    expect(textOf(plan)).toContain(MAQUETTE.footer);
    // Sans règle de domaine, la règle appliquée est dite une fois (pied du plan), pas répétée sur chaque carte.
    expect((textOf(plan).match(/escalade-par-defaut\.md/g) ?? []).length).toBe(1);
  });

  test.each([
    ['fr', "Je veux les livres depuis books.toscrape.com pour suivre les prix", "J'ai trouvé les livres. On valide ce schéma ?"],
    ['fr', "je veux les annonces de location depuis zz-annonces.example", "J'ai trouvé les annonces de location. On valide ce schéma ?"],
    ['en', 'I want the books from books.toscrape.com to track prices', 'I found the books. Shall we validate this schema?'],
  ] as const)('%s : la bulle « SYM 👻 : » nomme les items réels demandés (« Je veux [quoi] depuis [où] »)', async (locale, description, bubble) => {
    const state = awaiting();
    state.description = description;
    const html = await render(InvestigationBoard, props(state), { locale });
    const bubbleHtml = /data-testid="gate-bubble">([\s\S]*?<\/h2>)/.exec(html)?.[1] ?? '';
    // La signature parlante (icône SVG, « SYM », deux-points) ouvre la bulle ; la phrase de la planche suit, mot pour mot.
    expect(bubbleHtml).toMatch(/data-sym-signature[^>]*data-variant="speaking"[\s\S]*<svg/);
    const said = textOf(bubbleHtml).replace(/\s+/g, ' ').trim();
    expect(said.startsWith('SYM')).toBe(true);
    expect(said.replace(/^SYM ?: ?/, '')).toBe(bubble);
  });

  test('description hors phrase-modèle : la bulle retombe sur les données du domaine enquêté, jamais sur un nom inventé', async () => {
    const state = awaiting();
    state.description = 'Les prix de toute la boutique';
    const html = await render(InvestigationBoard, props(state), { locale: 'fr' });
    expect(textOf(section(html, 'gate-title'))).toContain("J'ai trouvé les données de books.toscrape.com. On valide ce schéma ?");
    // Une description française n'entre pas dans la phrase anglaise : repli sur le domaine.
    state.description = 'Je veux les livres depuis books.toscrape.com';
    const english = await render(InvestigationBoard, props(state), { locale: 'en' });
    expect(textOf(section(english, 'gate-title'))).toContain('I found the data from books.toscrape.com. Shall we validate this schema?');
  });

  test('le rejeu n’est dit « sans IA » que si la méthode la moins chère n’appelle pas de modèle', async () => {
    const state = awaiting();
    state.plan = [{ execution: 'agent_fetch', network: 'direct', estCostUsd: 0.002 }];
    state.budget = { ...state.budget!, retainedEstUsd: 0.002 };
    const html = await render(InvestigationBoard, props(state), { locale: 'fr' });
    expect(textOf(section(html, 'gate-title'))).not.toContain('sans IA');
  });

  test('anglais : mêmes éléments, transcréés (aucune chaîne française)', async () => {
    const html = await render(InvestigationBoard, props(awaiting()), { locale: 'en' });
    const go = section(html, 'gate-title');
    expect(go).toMatch(/data-sym-signature[^>]*data-variant="speaking"/);
    expect(textOf(go)).toContain(en.investigation.gate.title.replace('{what}', en.investigation.gate.what.replace('{domain}', 'books.toscrape.com')));
    expect(textOf(html)).not.toMatch(/Aucun essai|Le plan d'essais|Budget max/);
  });
});

describe('fidélité à la planche Nouvelle API (D-60) : structure, hiérarchie, couleurs', () => {
  test('trois cartes : schéma (papier), plan (bleu), porte (bulle anthracite) ; titres Bricolage de 22 px ; budget en Bricolage de 30 px', async () => {
    const html = await render(InvestigationBoard, props(awaiting()), { locale: 'fr' });
    expect(html).toContain('data-testid="schema-gate-layout"');
    expect(html).toMatch(/<section[^>]*aria-labelledby="schema-title"[^>]*class="[^"]*bg-card/);
    expect(html).toMatch(/<section[^>]*aria-labelledby="trial-plan-title"[^>]*class="[^"]*bg-primary text-primary-foreground/);
    expect(html).toMatch(/class="[^"]*sym-on-ink[^"]*bg-nav[^"]*"[^>]*data-testid="gate-bubble"/);
    for (const id of ['schema-title', 'trial-plan-title', 'gate-title']) expect(html).toMatch(new RegExp(`<h2 id="${id}" class="[^"]*font-display[^"]*text-\\[22px\\]`));
    expect(html).toMatch(/class="[^"]*font-display[^"]*text-\[30px\][^"]*"[^>]*data-testid="gate-budget-value"/);
    // Pendant le jalon 3, la planche remplace les trois colonnes de 06 (20 § 5.3) ; le h1 reste pour les lecteurs d'écran.
    expect(html).not.toContain('data-testid="column-seen"');
    expect(html).toMatch(/<h1[^>]*class="[^"]*sr-only/);
  });

  test('les champs sont une liste (une ligne par champ : nom en mono, type en pastille, exemple réel), pas un tableau à en-têtes', async () => {
    const html = await render(InvestigationBoard, props(awaiting()), { locale: 'fr' });
    const schema = section(html, 'schema-title');
    expect(schema).not.toContain('<table');
    expect(schema).toMatch(/<ul[^>]*data-testid="schema-fields"/);
    const rows = [...schema.matchAll(/<li[^>]*data-testid="schema-field"[^>]*>([\s\S]*?)<\/li>/g)].map((match) => textOf(match[1] ?? ''));
    expect(rows).toEqual(['titre texte « A Light in the Attic »', 'prix nombre 51.77', 'en_stock oui / non true', 'note 1 à 5 3']);
    expect(schema).toMatch(/<input[^>]*placeholder="ex\. le prix en euros, ajoute l&#39;URL du livre"/);
  });

  test('pastilles numérotées du plan : jaune, lilas, orange, toujours à texte anthracite ; jamais la couleur d’erreur (20 § 5.3)', async () => {
    const html = await render(TrialPlan, { cards: trialCards(awaiting()) }, { locale: 'fr' });
    const numbers = [...html.matchAll(/<span class="([^"]*)" aria-hidden="true" data-testid="trial-number">(\d)<\/span>/g)].map((match) => [match[2], match[1]]);
    expect(numbers.map(([n]) => n)).toEqual(['1', '2', '3']);
    expect(numbers[0]?.[1]).toContain('bg-sym-yellow');
    expect(numbers[1]?.[1]).toContain('bg-sym-lilac');
    expect(numbers[2]?.[1]).toContain('bg-sym-orange');
    for (const [, classes] of numbers) {
      expect(classes).toContain('text-sym-ink');
      expect(classes).not.toMatch(/destructive|text-white|text-primary-foreground/);
    }
  });

  test('frise : pastilles « n · Libellé » reliées par des traits ; fait = coche, en cours = pastille bleue ; l’état reste dit en texte', async () => {
    const html = await render(PhaseTimeline, { states: { describe: 'done', reconnaissance: 'done', schema: 'current', trials: 'todo' } }, { locale: 'fr' });
    const pills = [...html.matchAll(/data-testid="milestone-pill"[^>]*>([\s\S]*?)<\/span>\s*<span class="sr-only"/g)].map((match) => textOf(match[1] ?? ''));
    expect(pills).toEqual(MAQUETTE.milestones);
    expect(html).toMatch(/class="[^"]*bg-primary text-primary-foreground[^"]*"[^>]*data-testid="milestone-pill"/);
    expect(html).toMatch(/class="[^"]*border-dashed[^"]*"[^>]*data-testid="milestone-pill"/);
    expect(html).toContain('(fait)');
    expect(html).toContain('(en cours)');
    expect((html.match(/data-testid="milestone-link"/g) ?? []).length).toBe(3);
  });
});
