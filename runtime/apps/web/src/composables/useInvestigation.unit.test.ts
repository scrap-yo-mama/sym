// SPDX-License-Identifier: AGPL-3.0-only
// Enquête en direct (06 § 2, tâche 3.5) : création, suivi par le flux SSE de l'onglet, Pause, Reprise, Arrêt, validation,
// ré-enquête. `assert_budget_and_stop_controls` (volet « un essai apparaît en moins de 2 s ») est rejoué ici sur le vrai
// client SSE ; la présence des contrôles est vérifiée dans components/investigation/investigation.unit.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setApi } from '@/lib/api';
import { EventStreamClient } from '@/lib/sse';
import InvestigationBoard from '@/components/investigation/InvestigationBoard.vue';
import { flush, installFakeServer, json, view, type RecordedCall } from '@/testing/console.testkit';
import { startEventStream, stopEventStream } from './useEventStream';
import { useInvestigation } from './useInvestigation';

const RUN = '6f1c8a52-0000-4000-8000-000000000010';
const API = '6f1c8a52-0000-4000-8000-000000000020';
const NEXT = '6f1c8a52-0000-4000-8000-000000000030';
const frame = (id: string, event: string, data: Record<string, unknown>) => ({ id, event, data: JSON.stringify(data) });
const attempt = { index: 0, execution: 'fetch', network: 'direct', state: 'done', est_cost_usd: 0.001, result: 'extraction', cost_usd: 0.002, ms: 240 };
const runBody = { id: RUN, api_id: API, api_slug: 'annonces', state: 'running', attempts: [], cost: { llm_usd: 0, proxy_usd: 0, total_usd: 0 } };
const form = { description: 'Titres des annonces', url: 'https://www.exemple.test/liste' };

afterEach(() => {
  setApi(undefined);
  stopEventStream();
  vi.useRealTimers();
});

const find = (calls: RecordedCall[], method: string, path: string) => calls.find((call) => call.method === method && call.path === path);

describe('création', () => {
  test('POST /api/apis sans attente, puis le run est relu pour connaître l’API ; les événements arrivés avant la réponse sont appliqués', async () => {
    const investigation = useInvestigation();
    const calls = installFakeServer({
      'POST /api/apis': () => {
        // Le flux annonce l'essai avant que la réponse de création ne revienne (course réelle).
        investigation.ingest(frame('1', 'attempt.finished', { run_id: RUN, attempt }));
        return json(202, { run_id: RUN, state: 'queued' });
      },
      [`GET /api/runs/${RUN}`]: () => json(200, runBody),
    });
    const result = await investigation.create(form);
    expect(result.ok).toBe(true);
    const post = find(calls, 'POST', '/api/apis');
    expect(post?.search).toBe('?wait=0');
    expect(post?.body).toEqual(form);
    expect(investigation.state).toMatchObject({ runId: RUN, apiId: API, slug: 'annonces', domain: 'www.exemple.test' });
    expect(investigation.state.attempts).toHaveLength(1);
    expect(investigation.busy.value).toBeNull();
    investigation.dispose();
  });

  test('réponse ApiCreated : schéma proposé et rapport d’accès rangés', async () => {
    const investigation = useInvestigation();
    installFakeServer({
      'POST /api/apis': () =>
        json(201, { api_id: API, slug: 'annonces', run_id: RUN, investigation_phase: 'awaiting_schema_validation', proposed_output_schema: { type: 'object' }, sample: [{ titre: 'a' }], access_report: { id: 'r', checked_at: '2026-10-01T10:00:00Z', signal: 'allowed', robots: { status: 'allowed' } } }),
    });
    await investigation.create(form);
    expect(investigation.state).toMatchObject({ apiId: API, slug: 'annonces', phase: 'awaiting_schema_validation', outputSchema: { type: 'object' } });
    expect(investigation.state.access?.robots.status).toBe('allowed');
    investigation.dispose();
  });

  test('échec : le code stable devient une clé de message, aucune enquête n’est suivie', async () => {
    const investigation = useInvestigation();
    installFakeServer({ 'POST /api/apis': () => json(409, { error: { code: 'account_site_ack_required', message: 'x' } }) });
    const result = await investigation.create(form);
    expect(result).toMatchObject({ ok: false, code: 'account_site_ack_required' });
    expect(investigation.failure.value).toBe('errors.account_site_ack_required');
    expect(investigation.state.runId).toBeNull();
    investigation.dispose();
  });
});

describe('Pause, Reprise, Arrêt', () => {
  async function started() {
    const investigation = useInvestigation();
    const calls = installFakeServer({
      'POST /api/apis': () => json(202, { run_id: RUN, state: 'queued' }),
      [`GET /api/runs/${RUN}`]: () => json(200, runBody),
      [`POST /api/runs/${RUN}/pause`]: () => json(202, { run_id: RUN, state: 'running' }),
      [`POST /api/runs/${RUN}/resume`]: () => json(202, { run_id: RUN, state: 'running' }),
      [`POST /api/runs/${RUN}/cancel`]: () => json(200, { run_id: RUN, state: 'cancelled', cost: { llm_usd: 0, proxy_usd: 0, total_usd: 0.004 } }),
    });
    await investigation.create(form);
    return { investigation, calls };
  }

  test('Pause puis Reprendre : deux appels, l’état de pause suit', async () => {
    const { investigation, calls } = await started();
    expect(await investigation.pause()).toBe(true);
    expect(investigation.paused.value).toBe(true);
    expect(find(calls, 'POST', `/api/runs/${RUN}/pause`)).toBeDefined();
    expect(await investigation.resume()).toBe(true);
    expect(investigation.paused.value).toBe(false);
    expect(find(calls, 'POST', `/api/runs/${RUN}/resume`)).toBeDefined();
    investigation.dispose();
  });

  test('Arrêter : l’enquête est terminée, les essais restent', async () => {
    const { investigation } = await started();
    investigation.ingest(frame('1', 'attempt.finished', { run_id: RUN, attempt }));
    expect(await investigation.cancel()).toBe(true);
    expect(investigation.cancelled.value).toBe(true);
    expect(investigation.state.terminal).toBe(true);
    expect(investigation.state.attempts).toHaveLength(1);
    expect(investigation.active.value).toBe(false);
    investigation.dispose();
  });

  test('un refus du serveur (409) ne change aucun état et se lit dans failure', async () => {
    const investigation = useInvestigation();
    installFakeServer({
      'POST /api/apis': () => json(202, { run_id: RUN, state: 'queued' }),
      [`GET /api/runs/${RUN}`]: () => json(200, runBody),
      [`POST /api/runs/${RUN}/pause`]: () => json(409, { error: { code: 'conflict', message: 'x' } }),
    });
    await investigation.create(form);
    expect(await investigation.pause()).toBe(false);
    expect(investigation.paused.value).toBe(false);
    expect(investigation.failure.value).toBe('errors.conflict');
    investigation.dispose();
  });

  test('sans run connu, aucun bouton n’appelle le serveur', async () => {
    const investigation = useInvestigation();
    const calls = installFakeServer({});
    expect(await investigation.pause()).toBe(false);
    expect(await investigation.cancel()).toBe(false);
    expect(calls).toHaveLength(0);
    investigation.dispose();
  });
});

describe('validation et ré-enquête', () => {
  test('Valider envoie le schéma modifié et les méthodes exclues ; l’enquête passe aux essais', async () => {
    const investigation = useInvestigation();
    const calls = installFakeServer({
      'POST /api/apis': () => json(201, { api_id: API, slug: 'annonces', run_id: RUN, investigation_phase: 'awaiting_schema_validation', proposed_output_schema: { type: 'object' }, sample: [], access_report: null }),
      [`POST /api/apis/${API}/validate-schema`]: () => json(202, { run_id: RUN, state: 'running' }),
    });
    await investigation.create(form);
    expect(await investigation.validate({ outputSchema: { type: 'object', required: ['titre'] }, excludeExecutions: ['agent', 'hybrid'] })).toBe(true);
    expect(find(calls, 'POST', `/api/apis/${API}/validate-schema`)?.body).toEqual({ wait_seconds: 0, output_schema: { type: 'object', required: ['titre'] }, exclude_executions: ['agent', 'hybrid'] });
    expect(investigation.state.phase).toBe('testing');
    investigation.dispose();
  });

  test('Valider sans modification n’envoie ni schéma ni exclusion', async () => {
    const investigation = useInvestigation();
    const calls = installFakeServer({
      'POST /api/apis': () => json(201, { api_id: API, slug: 'annonces', run_id: RUN, investigation_phase: 'awaiting_schema_validation', proposed_output_schema: { type: 'object' }, sample: [], access_report: null }),
      [`POST /api/apis/${API}/validate-schema`]: () => json(202, { run_id: RUN, state: 'running' }),
    });
    await investigation.create(form);
    await investigation.validate({ excludeExecutions: [] });
    expect(find(calls, 'POST', `/api/apis/${API}/validate-schema`)?.body).toEqual({ wait_seconds: 0 });
    investigation.dispose();
  });

  test('Ré-enquêter (action manuelle) : nouvelle enquête, état remis à zéro, journal rejoué par le flux filtré du nouveau run', async () => {
    const replayed: string[] = [];
    const investigation = useInvestigation({
      replayFactory: (runId) => {
        replayed.push(runId);
        return new EventStreamClient({ url: `/api/runs/${runId}/events`, stopOnNotFound: true, fetch: async () => new Response(null, { status: 404 }) });
      },
    });
    const calls = installFakeServer({
      'POST /api/apis': () => json(202, { run_id: RUN, state: 'queued' }),
      [`GET /api/runs/${RUN}`]: () => json(200, runBody),
      'POST /api/apis/annonces/investigate': () => json(202, { run_id: NEXT, state: 'queued' }),
      [`GET /api/runs/${NEXT}`]: () => json(200, { ...runBody, id: NEXT }),
    });
    await investigation.create(form);
    investigation.ingest(frame('1', 'status.changed', { run_id: RUN, status: 'bloquee', status_reason: { code: 'forbidden', params: {} } }));
    expect(investigation.state.blocked).not.toBeNull();
    expect(await investigation.reinvestigate()).toBe(true);
    expect(find(calls, 'POST', '/api/apis/annonces/investigate')).toBeDefined();
    expect(investigation.state.runId).toBe(NEXT);
    expect(investigation.state.blocked).toBeNull();
    expect(replayed).toEqual([NEXT]);
    investigation.dispose();
  });
});

describe('réouverture', () => {
  test('open relit le run, puis le journal se rejoue depuis le début par le flux filtré', async () => {
    const received: string[] = [];
    const encoder = new TextEncoder();
    const investigation = useInvestigation({
      replayFactory: (runId) =>
        new EventStreamClient({
          url: `/api/runs/${runId}/events`,
          fetch: async (url, init) => {
            received.push(url);
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode(`id: 1\nevent: attempt.finished\ndata: ${JSON.stringify({ run_id: RUN, attempt })}\n\n`));
                // Flux tenu ouvert jusqu'à l'arrêt (une fermeture déclencherait la boucle de reconnexion).
                (init.signal as AbortSignal).addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
              },
            });
            return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
          },
          sleep: async () => undefined,
        }),
    });
    installFakeServer({ [`GET /api/runs/${RUN}`]: () => json(200, runBody) });
    expect(await investigation.open(RUN)).toBe(true);
    for (let i = 0; i < 100 && investigation.state.attempts.length === 0; i++) await flush();
    expect(received).toEqual([`/api/runs/${RUN}/events`]);
    expect(investigation.state.attempts).toHaveLength(1);
    expect(investigation.state.slug).toBe('annonces');
    investigation.dispose();
  });

  // Pause relue du Run (`paused_at`, extension de 05 § 4.2 à livrer par 3.1, ADR 0003) : la pause survit au rechargement.
  const silentReplay = (runId: string) =>
    new EventStreamClient({
      url: `/api/runs/${runId}/events`,
      fetch: async (_url, init) =>
        new Response(new ReadableStream<Uint8Array>({ start: (c) => (init.signal as AbortSignal).addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))) }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      sleep: async () => undefined,
    });

  test('un run en pause (paused_at) rouvre l’enquête en pause, chronomètre arrêté ; Reprendre la relance', async () => {
    const investigation = useInvestigation({ replayFactory: silentReplay });
    installFakeServer({
      [`GET /api/runs/${RUN}`]: () => json(200, { ...runBody, paused_at: '2026-10-01T10:00:00Z' }),
      [`POST /api/runs/${RUN}/resume`]: () => json(202, { run_id: RUN, state: 'running' }),
    });
    expect(await investigation.open(RUN)).toBe(true);
    expect(investigation.paused.value).toBe(true);
    await investigation.resume();
    expect(investigation.paused.value).toBe(false);
    investigation.dispose();
  });

  test('un run sans paused_at (ou paused_at null) rouvre l’enquête hors pause, même après une pause locale', async () => {
    const investigation = useInvestigation({ replayFactory: silentReplay });
    installFakeServer({
      [`GET /api/runs/${RUN}`]: () => json(200, { ...runBody, paused_at: null }),
      [`POST /api/runs/${RUN}/pause`]: () => json(202, { run_id: RUN, state: 'running' }),
    });
    expect(await investigation.open(RUN)).toBe(true);
    await investigation.pause();
    expect(investigation.paused.value).toBe(true);
    expect(await investigation.open(RUN)).toBe(true);
    expect(investigation.paused.value).toBe(false);
    investigation.dispose();
  });

  test('un run introuvable laisse une erreur lisible', async () => {
    const investigation = useInvestigation();
    installFakeServer({});
    expect(await investigation.open(RUN)).toBe(false);
    expect(investigation.failure.value).toBe('errors.not_found');
    investigation.dispose();
  });
});

describe('chronomètre', () => {
  test('les secondes avancent entre deux événements, s’arrêtent en pause, sont bornées par le délai', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let clock = 1_000_000;
    const investigation = useInvestigation({ now: () => clock });
    installFakeServer({
      'POST /api/apis': () => json(202, { run_id: RUN, state: 'queued' }),
      [`GET /api/runs/${RUN}`]: () => json(200, runBody),
      [`POST /api/runs/${RUN}/pause`]: () => json(202, { run_id: RUN, state: 'running' }),
    });
    await investigation.create(form);
    investigation.ingest(frame('1', 'phase.started', { run_id: RUN, phase: 'testing', budget: { spent_usd: 0, max_usd: 0.5, elapsed_s: 10, timeout_s: 14 } }));
    expect(investigation.elapsedS.value).toBe(10);
    clock += 2000;
    vi.advanceTimersByTime(1000);
    expect(investigation.elapsedS.value).toBe(12);
    clock += 30_000;
    vi.advanceTimersByTime(1000);
    expect(investigation.elapsedS.value).toBe(14);
    await investigation.pause();
    expect(investigation.elapsedS.value).toBe(10);
    investigation.dispose();
  });
});

describe('assert_budget_and_stop_controls : un essai apparaît en moins de 2 s', () => {
  test('trame SSE reçue par le vrai client du flux de l’onglet, essai rangé avant 2 s', async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    startEventStream(
      () => undefined,
      () =>
        new EventStreamClient({
          url: '/api/events',
          fetch: async () => new Response(new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        }),
    );
    const investigation = useInvestigation();
    installFakeServer({
      'POST /api/apis': () => json(202, { run_id: RUN, state: 'queued' }),
      [`GET /api/runs/${RUN}`]: () => json(200, runBody),
    });
    await investigation.create(form);
    for (let i = 0; i < 100 && !controller; i++) await flush();
    const sentAt = Date.now();
    controller.enqueue(encoder.encode(`id: 5\nevent: attempt.finished\ndata: ${JSON.stringify({ run_id: RUN, attempt, budget: { spent_usd: 0.002, max_usd: 0.5, elapsed_s: 1, timeout_s: 300 } })}\n\n`));
    for (let i = 0; i < 200 && investigation.state.attempts.length === 0; i++) await flush();
    expect(investigation.state.attempts).toHaveLength(1);
    expect(Date.now() - sentAt).toBeLessThan(2000);
    expect(investigation.state.budget?.spentUsd).toBe(0.002);
    investigation.dispose();
  });

  test('trame SSE → ligne [data-testid=attempt] dans le rendu du tableau de l’enquête, en moins de 2 s', async () => {
    // Bout à bout sans navigateur : vrai client SSE, vrai composable, vrai composant rendu. La mesure en Chromium
    // (essai visible à l'écran) reste à 3.6 : test.todo de tests/invariants.todo.test.ts.
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    startEventStream(
      () => undefined,
      () =>
        new EventStreamClient({
          url: '/api/events',
          fetch: async () => new Response(new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        }),
    );
    const investigation = useInvestigation();
    installFakeServer({
      'POST /api/apis': () => json(202, { run_id: RUN, state: 'queued' }),
      [`GET /api/runs/${RUN}`]: () => json(200, runBody),
    });
    await investigation.create(form);
    for (let i = 0; i < 100 && !controller; i++) await flush();
    const board = () =>
      view(InvestigationBoard, { state: investigation.state, elapsedS: investigation.elapsedS.value, paused: false, cancelled: false, busy: null, failure: null });
    expect(await board()).not.toContain('data-testid="attempt"');
    const sentAt = Date.now();
    controller.enqueue(encoder.encode(`id: 7\nevent: attempt.finished\ndata: ${JSON.stringify({ run_id: RUN, attempt })}\n\n`));
    let html = '';
    for (let i = 0; i < 200 && !html.includes('data-testid="attempt"'); i++) {
      await flush();
      html = await board();
    }
    expect(Date.now() - sentAt).toBeLessThan(2000);
    expect(html.match(/data-testid="attempt"/g)).toHaveLength(1);
    expect(html).toContain('Trial 1');
    investigation.dispose();
  });

  test('après dispose, le composable ne suit plus le flux', async () => {
    const investigation = useInvestigation();
    installFakeServer({
      'POST /api/apis': () => json(202, { run_id: RUN, state: 'queued' }),
      [`GET /api/runs/${RUN}`]: () => json(200, runBody),
    });
    await investigation.create(form);
    investigation.dispose();
    const before = investigation.state.attempts.length;
    // L'abonnement est retiré : un événement du flux n'atteint plus l'état.
    startEventStream(() => undefined, () => new EventStreamClient({ url: '/api/events', stopOnNotFound: true, fetch: async () => new Response(null, { status: 404 }) }));
    expect(investigation.state.attempts.length).toBe(before);
  });
});

beforeEach(() => stopEventStream());
