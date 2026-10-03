// SPDX-License-Identifier: AGPL-3.0-only
// Écran d'enquête en trois colonnes (06 § 2, tâche 3.5), rendu côté serveur sans navigateur. `assert_budget_and_stop_controls` :
// compteur de budget, Pause et Arrêter sont présents quand l'enquête tourne ; le volet « essai en moins de 2 s » est dans
// composables/useInvestigation.unit.test.ts. Le panneau « Bloquée » a son propre test (components/BlockedPanel.unit.test.ts).
import { describe, expect, test } from 'vitest';
import en from '@runtime/i18n/locales/en.json';
import fr from '@runtime/i18n/locales/fr.json';
import { emptyInvestigation, toggleExcluded, type InvestigationState, type PlanStep } from '@/lib/investigation';
import { esc, view as render } from '@/testing/console.testkit';
import InvestigationBoard from './InvestigationBoard.vue';

function running(): InvestigationState {
  const state = emptyInvestigation();
  state.runId = 'r1';
  state.apiId = 'a1';
  state.slug = 'annonces';
  state.domain = 'exemple.test';
  state.phase = 'testing';
  state.status = 'enquete';
  state.access = { id: 'ar', checked_at: '2026-10-01T10:00:00Z', signal: 'allowed', robots: { status: 'allowed' }, usage_signals: [{ kind: 'ai-preference', value: 'train-ai=n' }], llms_txt: true, official_api_url: null };
  state.budget = { spentUsd: 0.012, maxUsd: 0.5, elapsedS: 12, timeoutS: 300, retainedEstUsd: 0.002, fullAgentEstUsd: 0.09, receivedAtMs: 0 };
  state.attempts = [
    { index: 0, execution: 'fetch', network: 'direct', state: 'done', result: 'extraction', costUsd: 0.0004, estCostUsd: 0.0004, ms: 240, prunedReason: null, why: { code: 'escalated', params: {} }, error: null },
    { index: 1, execution: 'agent', network: 'direct', state: 'pruned', result: null, costUsd: null, estCostUsd: 0.09, ms: null, prunedReason: 'cheaper_succeeded', why: null, error: null },
  ];
  return state;
}

const props = (state: InvestigationState, extra: Record<string, unknown> = {}) => ({ state, elapsedS: 14, paused: false, cancelled: false, busy: null, failure: null, ...extra });

describe('assert_budget_and_stop_controls : compteur de budget, Pause et Arrêter sont présents', () => {
  test('en : compteur, Pause, Arrêter l’enquête, trois colonnes, journal role="log"', async () => {
    const html = await render(InvestigationBoard, props(running()));
    expect(html).toContain('data-testid="budget-counter"');
    expect(html).toContain('data-testid="investigation-pause"');
    expect(html).toContain('data-testid="investigation-stop"');
    expect(html).toContain(en.investigation.controls.pause);
    expect(html).toContain(en.investigation.controls.stop);
    expect(html).toContain(en.investigation.controls.stopHint);
    for (const heading of Object.values(en.investigation.columns)) expect(html).toContain(`>${heading}</h2>`);
    // Le rôle log est sur un conteneur, la liste est dedans : sur le <ol>, il remplacerait son rôle de liste (axe listitem).
    expect(html).toMatch(/<div[^>]*role="log"[^>]*>\s*<ol/);
    expect(html).not.toMatch(/<ol[^>]*role="log"/);
    expect(html).toContain('Spend: $0.01 of $0.50');
    expect(html).toContain('Time: 14 sec of 5 min');
    expect(html).toContain('Kept: ~$0.002; a full agent: ~$0.09 (estimate)');
  });

  test('fr : mêmes éléments, libellés français', async () => {
    const html = await render(InvestigationBoard, props(running()), { locale: 'fr' });
    expect(html).toContain('data-testid="budget-counter"');
    expect(html).toContain(esc(fr.investigation.controls.pause));
    expect(html).toContain(esc(fr.investigation.controls.stop));
    for (const heading of Object.values(fr.investigation.columns)) expect(html).toContain(`>${esc(heading)}</h2>`);
    expect(html).toMatch(/Retenu : ~0,002\s\$ ; un agent complet : ~0,09\s\$ \(estimation\)/u);
  });

  test('compteur : un prix inconnu n’est jamais affiché comme 0, l’estimation absente est dite', async () => {
    const state = running();
    state.budget = { spentUsd: null, maxUsd: null, elapsedS: null, timeoutS: null, retainedEstUsd: null, fullAgentEstUsd: null, receivedAtMs: 0 };
    const html = await render(InvestigationBoard, props(state, { elapsedS: null }));
    expect(html).toContain('Spend: n/a of n/a');
    expect(html).toContain(en.investigation.budget.estimateUnknown);
    const budget = html.slice(html.indexOf('data-testid="budget-counter"'), html.indexOf('data-testid="column-seen"'));
    expect(budget).not.toContain('$0');
  });

  test('en pause : Reprendre remplace Pause, Arrêter reste ; l’état est annoncé dans une région status', async () => {
    const html = await render(InvestigationBoard, props(running(), { paused: true }));
    expect(html).toContain('data-testid="investigation-resume"');
    expect(html).not.toContain('data-testid="investigation-pause"');
    expect(html).toContain('data-testid="investigation-stop"');
    expect(html).toMatch(/role="status"[^>]*data-testid="investigation-status">Paused\./);
  });

  test('assert_live_regions_plan : un changement d’étape est annoncé dans la région status (« Étape : Essais. »), en en et en fr', async () => {
    for (const [locale, messages] of [['en', en], ['fr', fr]] as const) {
      const state = running();
      for (const phase of ['access_check', 'reconnaissance', 'awaiting_schema_validation', 'testing'] as const) {
        state.phase = phase;
        const html = await render(InvestigationBoard, props(state), { locale });
        const announced = messages.investigation.phase.announce.replace('{phase}', messages.investigation.phase[phase]);
        expect(html, `${locale} ${phase}`).toContain(`data-testid="investigation-status">${esc(announced)}<`);
      }
    }
  });

  test('enquête arrêtée ou terminée : boutons inactifs (aria-disabled), coût conservé annoncé', async () => {
    const stopped = await render(InvestigationBoard, props(running(), { cancelled: true }));
    expect(stopped).toMatch(/aria-disabled="true"[^>]*data-testid="investigation-stop"|data-testid="investigation-stop"[^>]*aria-disabled="true"/);
    expect(stopped).toContain('Investigation stopped. Trials and cost so far are kept: $0.01.');
    const state = running();
    state.terminal = true;
    state.status = 'sain';
    const done = await render(InvestigationBoard, props(state));
    expect(done).toContain(en.investigation.result.sain);
  });

  test('un échec d’action est lisible', async () => {
    const html = await render(InvestigationBoard, props(running(), { failure: 'errors.conflict' }));
    expect(html).toContain('data-testid="investigation-failure"');
    expect(html).toContain(en.errors.conflict);
  });
});

describe('journal d’enquête', () => {
  test('première ligne « robots.txt lu : chemin autorisé », signaux d’usage, puis les essais avec leur « pourquoi » et leur raison', async () => {
    const html = await render(InvestigationBoard, props(running()));
    const log = html.slice(html.indexOf('data-testid="attempt-log"'));
    expect(log.indexOf('robots.txt read: path allowed')).toBeGreaterThan(-1);
    expect(log.indexOf('robots.txt read: path allowed')).toBeLessThan(log.indexOf('Trial 1: fetch only, direct'));
    expect(log).toContain('Usage signal ai-preference: train-ai=n');
    expect(log).toContain('llms.txt found');
    expect(log).toContain('Trial 1: fetch only, direct');
    expect(log).toContain('failed (Extraction failed)');
    expect(log).toContain('Why: A more expensive method than usual was needed.');
    expect(log).toContain('Trial 2: full agent, direct');
    expect(log).toContain('not run: Reason: cheaper_succeeded');
  });

  test('colonne « Ce que voit l’agent » : carte requête/réponse du dernier essai quand le flux la donne', async () => {
    const state = running();
    state.attempts = [{ ...state.attempts[0]!, exchange: { method: 'GET', url: 'https://www.exemple.test/liste', status: 200, contentType: 'text/html', bytes: 18432 } }];
    const html = await render(InvestigationBoard, props(state));
    expect(html).toContain('data-testid="exchange-card"');
    expect(html).toContain(en.investigation.seen.exchange.title);
    expect(html).toContain('GET https://www.exemple.test/liste');
    expect(html).toContain('HTTP 200 · text/html · 18,432 bytes');
    const fr = await render(InvestigationBoard, props(state), { locale: 'fr' });
    expect(fr).toMatch(/HTTP 200 · text\/html · 18\s432 octets/u);
  });

  test('colonne « Ce que voit l’agent » : sans carte dans le flux, pas de carte vide', async () => {
    const html = await render(InvestigationBoard, props(running()));
    expect(html).not.toContain('data-testid="exchange-card"');
    expect(html).toContain(en.investigation.seen.lastTrial);
  });

  test('rendu français du journal', async () => {
    const html = await render(InvestigationBoard, props(running()), { locale: 'fr' });
    expect(html).toContain('robots.txt lu : chemin autorisé');
    expect(html).toContain('Essai 1 : fetch seul, direct');
    expect(html).toContain('en échec (Extraction en échec)');
    expect(html).toContain('Pourquoi : Une méthode plus chère que d&#39;habitude a été nécessaire.');
  });

  test('frise à 4 jalons : l’état de chaque jalon est un texte, pas seulement une couleur', async () => {
    const html = await render(InvestigationBoard, props(running()));
    expect(html).toMatch(/data-testid="phase-timeline"/);
    expect((html.match(/data-state="(done|current|upcoming)"/g) ?? []).length).toBe(4);
    expect(html).toContain('(done)');
    expect(html).toContain('(in progress)');
    expect(html).toMatch(/aria-current="step"/);
  });

  test('aucune action de défilement forcé dans les sources', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['AttemptLog.vue', 'InvestigationBoard.vue']) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), file).not.toMatch(/scrollIntoView|scrollTo\(|scrollTop\s*=/);
    }
  });
});

describe('troisième colonne', () => {
  function awaiting(): InvestigationState {
    const state = running();
    state.attempts = [];
    state.phase = 'awaiting_schema_validation';
    state.outputSchema = { type: 'object', properties: { titre: { type: 'string' } } };
    state.sample = [{ titre: 'Un titre' }];
    state.plan = [
      { execution: 'fetch', network: 'direct', estCostUsd: 0.0004 },
      { execution: 'playwright', network: 'direct', estCostUsd: 0.003 },
      { execution: 'agent', network: 'direct', estCostUsd: 0.09 },
    ];
    return state;
  }

  test('schéma et échantillon, Valider ou Modifier, plan d’essais restreignable', async () => {
    const html = await render(InvestigationBoard, props(awaiting()));
    expect(html).toContain('data-testid="schema-validate"');
    expect(html).toContain('data-testid="schema-edit"');
    expect(html).toContain('Un titre');
    expect(html).toContain('data-testid="trial-plan"');
    // Planche NouvelleApi.dc.html (3.17, D-60) : coût estimé « ~ » à droite de chaque carte, nom et sous-titre de la méthode.
    expect(html).toContain('~$0.0004');
    expect(html).toContain(en.investigation.plan.card.agent.text);
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(3);
  });

  test('hors validation, ni Valider ni plan ; la stratégie en tunnel dit que l’ordinateur doit être allumé', async () => {
    const state = running();
    state.outputSchema = { type: 'object' };
    state.strategy = { version: 1, execution: 'fetch_in_page', network: 'tunnel' };
    const html = await render(InvestigationBoard, props(state));
    expect(html).not.toContain('data-testid="schema-validate"');
    expect(html).not.toContain('data-testid="trial-plan"');
    expect(html).toContain('Chosen strategy: fetch in the browser, tunnel, version 1');
    expect(html).toContain(en.investigation.schema.tunnelNote);
  });

  test('le schéma et l’échantillon sont rendus comme du texte, jamais comme du HTML', async () => {
    const state = awaiting();
    state.sample = [{ titre: '<img src=x onerror=alert(1)>' }];
    const html = await render(InvestigationBoard, props(state));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('plan d’essais : on retire, on n’ajoute pas, une méthode au moins reste', () => {
  const plan: PlanStep[] = [
    { execution: 'fetch', network: 'direct', estCostUsd: null },
    { execution: 'agent', network: 'direct', estCostUsd: null },
  ];

  test('décocher exclut ; recocher rétablit', () => {
    expect(toggleExcluded(plan, [], 'agent', false)).toEqual(['agent']);
    expect(toggleExcluded(plan, ['agent'], 'agent', true)).toEqual([]);
  });

  test('la dernière méthode ne peut pas être retirée', () => {
    expect(toggleExcluded(plan, ['agent'], 'fetch', false)).toEqual(['agent']);
  });

  test('une méthode hors du plan est ignorée (jamais d’ajout)', () => {
    expect(toggleExcluded(plan, [], 'hybrid', false)).toEqual([]);
  });
});

describe('bandeau « Action requise »', () => {
  test('présenté comme une tâche, avec son bouton principal vers les réglages concernés', async () => {
    const state = running();
    state.action = { cause: 'auth_required', domain: 'exemple.test', platform: null, offer: null, resuming: false };
    const html = await render(InvestigationBoard, props(state));
    expect(html).toContain('data-testid="action-banner"');
    expect(html).toContain('Connect exemple.test');
    expect(html).toContain('href="/settings/extension"');
    expect(html).toMatch(/role="alert"/);
  });

  test('quand l’utilisateur agit, le bandeau devient « Reprise de l’enquête… » au lieu de disparaître', async () => {
    const state = running();
    state.action = { cause: 'auth_required', domain: 'exemple.test', platform: null, offer: null, resuming: true };
    const html = await render(InvestigationBoard, props(state));
    expect(html).toContain('data-testid="action-resuming"');
    expect(html).toContain('Resuming the investigation…');
    expect(html).not.toContain('Connect exemple.test');
  });

  test('défi dans le navigateur de l’utilisateur : texte du CDC, aucune reprise automatique ni prise de contrôle', async () => {
    const state = running();
    state.action = { cause: 'challenge_in_tunnel', domain: 'exemple.test', platform: null, offer: null, resuming: false };
    const html = await render(InvestigationBoard, props(state));
    expect(html).toContain('Nothing was sent on this page and nothing will be.');
    expect(html).toContain('Scrapyomama never answers a verification.');
    expect(html).not.toMatch(/take control|prendre la main|takeover/i);
  });

  test('UX-11 — llm_price_missing : le modèle est nommé, le bouton mène à Réglages > Modèles IA, aucune mention de budget', async () => {
    const state = running();
    state.action = { cause: 'llm_price_missing', domain: 'exemple.test', platform: null, offer: null, model: 'claude-opus-4-8', resuming: false };
    const html = await render(InvestigationBoard, props(state));
    expect(html).toContain('Enter the price of model claude-opus-4-8 in Settings &gt; AI models');
    expect(html).toContain('href="/settings/models"');
    const banner = html.slice(html.indexOf('data-testid="action-banner"'), html.indexOf('<ol', html.indexOf('data-testid="action-banner"')));
    expect(banner).not.toMatch(/budget/i);
    state.action = { cause: 'llm_price_missing', domain: 'exemple.test', platform: null, offer: null, model: null, resuming: false };
    expect(await render(InvestigationBoard, props(state))).toContain('Enter the price of model used in Settings &gt; AI models');
  });

  test('payment_required et account_limit : texte seul, sans bouton', async () => {
    for (const cause of ['payment_required', 'account_limit'] as const) {
      const state = running();
      state.action = { cause, domain: 'exemple.test', platform: 'Exemple', offer: '5 EUR par mois', resuming: false };
      const html = await render(InvestigationBoard, props(state));
      const banner = html.slice(html.indexOf('data-testid="action-banner"'), html.indexOf('</div>', html.indexOf('data-testid="action-banner"')));
      expect(banner).not.toContain('<button');
      expect(banner).not.toContain('<a ');
    }
  });
});

describe('suivi suspendu', () => {
  test('le bouton « Suspendre le suivi » est présent et le journal annonce poliment tant que le suivi est actif', async () => {
    const html = await render(InvestigationBoard, props(running()));
    expect(html).toContain('data-testid="follow-toggle"');
    expect(html).toContain(en.investigation.controls.suspendFollow);
    expect(html).toContain('aria-live="polite"');
  });
});
