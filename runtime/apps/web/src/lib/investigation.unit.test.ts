// SPDX-License-Identifier: AGPL-3.0-only
// État d'une enquête reconstruit depuis les événements SSE (06 § 2, tâche 3.5). Garde de type sur chaque charge : une
// charge inattendue est ignorée, jamais rendue. Idempotence : un événement rejoué (reprise, rejeu) ne change rien.
import { describe, expect, test } from 'vitest';
import { emptyInvestigation, hostOf, ingestEvent, seedFromCreated, seedFromRun, type InvestigationState } from './investigation';
import type { SseEvent } from './sse';

const RUN = '6f1c8a52-0000-4000-8000-000000000010';
const API = '6f1c8a52-0000-4000-8000-000000000020';

const frame = (id: string, event: string, data: Record<string, unknown>): SseEvent => ({ id, event, data: JSON.stringify(data) });
const attempt = (index: number, extra: Record<string, unknown> = {}) => ({
  index,
  execution: 'fetch',
  network: 'direct',
  state: 'done',
  est_cost_usd: 0.001,
  result: 'extraction',
  cost_usd: 0.002,
  ms: 240,
  ...extra,
});

function following(): InvestigationState {
  const state = emptyInvestigation();
  state.runId = RUN;
  state.apiId = API;
  state.slug = 'annonces';
  state.domain = 'exemple.test';
  return state;
}

describe('ingestEvent', () => {
  test('un essai terminé est visible dès la trame reçue : traitement synchrone, sans file ni temporisation', () => {
    const state = following();
    const start = Date.now();
    const concerned = ingestEvent(state, frame('1', 'attempt.finished', { run_id: RUN, attempt: attempt(0), why: { code: 'escalated', params: {} } }), Date.now());
    expect(concerned).toBe(true);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({ index: 0, execution: 'fetch', network: 'direct', result: 'extraction', costUsd: 0.002, ms: 240, why: { code: 'escalated' } });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('carte requête/réponse (06 § 2, colonne « Ce que voit l’agent ») : méthode, URL sans requête ni fragment, statut, type, taille', () => {
    const state = following();
    const exchange = { request: { method: 'GET', url: 'https://www.exemple.test/liste?token=zz_test_secret#haut' }, response: { status: 200, content_type: 'text/html; charset=utf-8', bytes: 18432 } };
    ingestEvent(state, frame('1', 'attempt.finished', { run_id: RUN, attempt: attempt(0), exchange }), 0);
    expect(state.attempts[0]?.exchange).toEqual({ method: 'GET', url: 'https://www.exemple.test/liste', status: 200, contentType: 'text/html', bytes: 18432 });
    expect(JSON.stringify(state)).not.toContain('zz_test_secret');
  });

  test('carte requête/réponse : une charge douteuse est ignorée (schéma non http, méthode inconnue), l’essai reste rangé', () => {
    const state = following();
    ingestEvent(state, frame('1', 'attempt.finished', { run_id: RUN, attempt: attempt(0), exchange: { request: { method: 'GET', url: 'javascript:alert(1)' }, response: { status: 200 } } }), 0);
    ingestEvent(state, frame('2', 'attempt.finished', { run_id: RUN, attempt: attempt(1), exchange: { request: { method: '<img src=x>', url: 'https://www.exemple.test/' }, response: { status: 200 } } }), 0);
    ingestEvent(state, frame('3', 'attempt.finished', { run_id: RUN, attempt: attempt(2), exchange: { request: { method: 'GET', url: 'https://www.exemple.test/' }, response: { status: 'x', bytes: -1 } } }), 0);
    ingestEvent(state, frame('4', 'attempt.finished', { run_id: RUN, attempt: attempt(3) }), 0);
    expect(state.attempts.map((a) => a.exchange ?? null)).toEqual([null, null, { method: 'GET', url: 'https://www.exemple.test/', status: null, contentType: null, bytes: null }, null]);
  });

  test('un événement d’un autre run, ou sans run ni API connus, est ignoré', () => {
    const state = following();
    expect(ingestEvent(state, frame('1', 'attempt.finished', { run_id: 'autre', attempt: attempt(0) }), 0)).toBe(false);
    expect(ingestEvent(state, frame('2', 'status.changed', { api_id: 'autre-api', status: 'sain' }), 0)).toBe(false);
    expect(ingestEvent(state, { id: '3', event: 'attempt.finished', data: 'pas du JSON' }, 0)).toBe(false);
    expect(ingestEvent(state, { id: '4', event: 'attempt.finished', data: '[1,2]' }, 0)).toBe(false);
    expect(ingestEvent(emptyInvestigation(), frame('5', 'attempt.finished', { run_id: RUN, attempt: attempt(0) }), 0)).toBe(false);
    expect(state.attempts).toHaveLength(0);
  });

  test('un événement de statut sans run est rattaché par l’API', () => {
    const state = following();
    expect(ingestEvent(state, frame('1', 'status.changed', { api_id: API, status: 'sain' }), 0)).toBe(true);
    expect(state.status).toBe('sain');
    expect(state.terminal).toBe(true);
    expect(state.phase).toBe('done');
  });

  test('rejeu : un identifiant déjà vu ne s’applique qu’une fois, et un essai se remplace par son index', () => {
    const state = following();
    const first = frame('7', 'attempt.finished', { run_id: RUN, attempt: attempt(0, { state: 'running', result: null, cost_usd: null }) });
    ingestEvent(state, first, 0);
    ingestEvent(state, first, 0);
    expect(state.attempts).toHaveLength(1);
    // Autre identifiant, même essai (flux global puis rejeu filtré) : remplacé, pas doublé.
    ingestEvent(state, frame('8', 'attempt.finished', { run_id: RUN, attempt: attempt(0) }), 0);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]?.state).toBe('done');
    ingestEvent(state, frame('9', 'attempt.finished', { run_id: RUN, attempt: attempt(2) }), 0);
    ingestEvent(state, frame('10', 'attempt.finished', { run_id: RUN, attempt: attempt(1) }), 0);
    expect(state.attempts.map((a) => a.index)).toEqual([0, 1, 2]);
  });

  test('un essai à exécution ou réseau inconnu est ignoré (aucune valeur du serveur rendue sans garde)', () => {
    const state = following();
    ingestEvent(state, frame('1', 'attempt.finished', { run_id: RUN, attempt: attempt(0, { execution: '<img src=x onerror=alert(1)>' }) }), 0);
    expect(state.attempts).toHaveLength(0);
  });

  test('le budget est relu à chaque événement qui le porte, avec l’instant de réception', () => {
    const state = following();
    ingestEvent(state, frame('1', 'attempt.finished', { run_id: RUN, attempt: attempt(0), budget: { spent_usd: 0.012, max_usd: 0.5, elapsed_s: 12, timeout_s: 300, retained_est_usd: 0.002, full_agent_est_usd: 0.09 } }), 1234);
    expect(state.budget).toEqual({ spentUsd: 0.012, maxUsd: 0.5, elapsedS: 12, timeoutS: 300, retainedEstUsd: 0.002, fullAgentEstUsd: 0.09, receivedAtMs: 1234 });
    ingestEvent(state, frame('2', 'phase.started', { run_id: RUN, phase: 'testing', budget: { spent_usd: 'beaucoup', max_usd: 0.5 } }), 2000);
    expect(state.budget).toMatchObject({ spentUsd: null, maxUsd: 0.5 });
  });

  test('frise : les phases avancent, le plan d’essais est lu après la reconnaissance', () => {
    const state = following();
    ingestEvent(state, frame('1', 'investigation.started', { run_id: RUN, access_report: { id: 'r', checked_at: '2026-10-01T10:00:00Z', signal: 'allowed', llms_txt: true } }), 0);
    expect(state.phase).toBe('access_check');
    // Un rapport sans section robots est valide (D-91) : la pastille et les autres champs suffisent.
    expect(state.access).toMatchObject({ signal: 'allowed', llms_txt: true });
    expect(state.access).not.toHaveProperty('robots');
    ingestEvent(state, frame('2', 'phase.started', { run_id: RUN, phase: 'reconnaissance' }), 0);
    ingestEvent(state, frame('3', 'phase.started', { run_id: RUN, phase: 'awaiting_schema_validation', plan: [{ execution: 'fetch', network: 'direct', est_cost_usd: 0.0004 }, { execution: 'agent' }, { execution: 'inconnue' }] }), 0);
    expect(state.phase).toBe('awaiting_schema_validation');
    expect(state.plan).toEqual([
      { execution: 'fetch', network: 'direct', estCostUsd: 0.0004, source: null, rule: null },
      { execution: 'agent', network: null, estCostUsd: null, source: null, rule: null },
    ]);
  });

  test('schéma proposé : schéma, échantillon et schéma d’entrée rangés ; la phase passe à la validation', () => {
    const state = following();
    ingestEvent(state, frame('1', 'schema.proposed', { run_id: RUN, output_schema: { type: 'object' }, sample: [{ titre: 'a' }, 'pas un objet'], input_schema: { type: 'object' } }), 0);
    expect(state.outputSchema).toEqual({ type: 'object' });
    expect(state.sample).toEqual([{ titre: 'a' }]);
    expect(state.phase).toBe('awaiting_schema_validation');
  });

  test('statut bloquee : le panneau reçoit la cause, le domaine, l’essai déclencheur et le coût ; plus aucune reprise automatique', () => {
    const state = following();
    ingestEvent(state, frame('1', 'attempt.finished', { run_id: RUN, attempt: attempt(0, { result: 'blocked_by_protection' }), budget: { spent_usd: 0.004, max_usd: 0.5 } }), 0);
    ingestEvent(state, frame('2', 'status.changed', { run_id: RUN, status: 'bloquee', status_reason: { code: 'blocked_by_protection', params: {} }, at: '2026-10-01T10:05:00Z' }), 0);
    expect(state.blocked).toMatchObject({ cause: 'blocked_by_protection', domain: 'exemple.test', at: '2026-10-01T10:05:00Z', costUsd: 0.004 });
    expect(state.blocked?.attempt?.index).toBe(0);
    expect(state.terminal).toBe(true);
    // Raison historique `robots_disallowed` (plus produite, D-91) : lue comme un refus du site, sans variante robots.
    ingestEvent(state, frame('3', 'status.changed', { run_id: RUN, status: 'bloquee', status_reason: { code: 'robots_disallowed', params: {} } }), 0);
    expect(state.blocked?.cause).toBe('forbidden');
    ingestEvent(state, frame('4', 'status.changed', { run_id: RUN, status: 'enquete' }), 0);
    expect(state.blocked).toBeNull();
  });

  test('action requise : le bandeau devient « reprise » quand l’utilisateur agit (transition 17), puis disparaît à la reprise des essais', () => {
    const state = following();
    ingestEvent(state, frame('1', 'action.required', { run_id: RUN, cause: 'auth_required', platform: 'Exemple' }), 0);
    ingestEvent(state, frame('2', 'status.changed', { run_id: RUN, status: 'action_requise' }), 0);
    expect(state.action).toMatchObject({ cause: 'auth_required', resuming: false });
    expect(state.terminal).toBe(false);
    ingestEvent(state, frame('3', 'status.changed', { run_id: RUN, status: 'enquete' }), 0);
    expect(state.action?.resuming).toBe(true);
    ingestEvent(state, frame('4', 'attempt.finished', { run_id: RUN, attempt: attempt(0) }), 0);
    expect(state.action).toBeNull();
  });

  test('une cause d’action inconnue est ignorée', () => {
    const state = following();
    ingestEvent(state, frame('1', 'action.required', { run_id: RUN, cause: 'ouvrir_le_tunnel' }), 0);
    expect(state.action).toBeNull();
  });

  test('stratégie retenue : exécution et réseau lus à la fin de l’enquête', () => {
    const state = following();
    ingestEvent(state, frame('1', 'status.changed', { run_id: RUN, status: 'sain', strategy: { version: 1, execution: 'fetch_in_page', network: 'tunnel' }, input_schema: { type: 'object' } }), 0);
    expect(state.strategy).toEqual({ version: 1, execution: 'fetch_in_page', network: 'tunnel' });
    expect(state.inputSchema).toEqual({ type: 'object' });
  });

  test('la mémoire de dédoublonnage est bornée', () => {
    const state = following();
    for (let i = 0; i < 2100; i++) ingestEvent(state, frame(String(i), 'phase.started', { run_id: RUN, phase: 'testing' }), 0);
    expect(state.seen.length).toBeLessThanOrEqual(2000);
  });
});

describe('amorçage', () => {
  test('seedFromCreated : API, run, schéma proposé et rapport d’accès', () => {
    const state = emptyInvestigation();
    seedFromCreated(state, { api_id: API, slug: 'annonces', run_id: RUN, investigation_phase: 'awaiting_schema_validation', proposed_output_schema: { type: 'object' }, sample: [{ a: 1 }], access_report: null });
    expect(state).toMatchObject({ apiId: API, slug: 'annonces', runId: RUN, phase: 'awaiting_schema_validation', outputSchema: { type: 'object' }, sample: [{ a: 1 }] });
  });

  test('seedFromRun : essais déjà faits, coût engagé, fin d’un run terminé', () => {
    const state = emptyInvestigation();
    seedFromRun(state, { id: RUN, api_id: API, api_slug: 'annonces', state: 'cancelled', attempts: [attempt(1), attempt(0), { index: 5 }], cost: { total_usd: 0.007 } }, 99);
    expect(state.attempts.map((a) => a.index)).toEqual([0, 1]);
    expect(state.budget?.spentUsd).toBe(0.007);
    expect(state.terminal).toBe(true);
    expect(state.slug).toBe('annonces');
  });

  test('hostOf : l’hôte d’une URL saisie, null sinon', () => {
    expect(hostOf(' https://www.exemple.test/a?b=1 ')).toBe('www.exemple.test');
    expect(hostOf('pas une url')).toBeNull();
  });
});
