// SPDX-License-Identifier: AGPL-3.0-only
// Composables de données de la catalogue et de la fiche (06 § 2 et § 3) : requêtes, pagination à curseur, rafraîchissement
// par le flux SSE, bandeau « Action requise » devenu « Reprise de l'enquête… » sans rechargement (`assert_action_required_as_task`).
import { effectScope, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { startEventStream, stopEventStream } from '@/composables/useEventStream';
import { useApiActions } from '@/composables/useApiActions';
import { useInvestigationReplay } from '@/composables/useInvestigationReplay';
import { CATALOG_POLL_MS, statusChanges, useApiCatalog } from '@/composables/useApiCatalog';
import { eventConcernsApi, useApiDetail } from '@/composables/useApiDetail';
import { usePagedList } from '@/composables/usePagedList';
import { useSchedules } from '@/composables/useSchedules';
import { useRevertPreview, useStrategyVersions } from '@/composables/useStrategyVersions';
import { groupFailures } from '@/composables/useStatusEvents';
import ActionRequiredBanner from '@/components/api/ActionRequiredBanner.vue';
import fr from '@runtime/i18n/locales/fr.json';
import { setApi } from '@/lib/api';
import { EventStreamClient, type SseEvent } from '@/lib/sse';
import { apiDetail, apiSummary, installApi, json, renderHtml, textOf, UUID } from '@/testing/console-fixtures';

const scopes: EffectScope[] = [];
function inScope<T>(run: () => T): T {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(run) as T;
}
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  stopEventStream();
  setApi(undefined);
  vi.useRealTimers();
});

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

/** Flux SSE piloté par le test : `push` écrit une trame, `close` termine la réponse. */
function controlledStream(): { fetch: (url: string, init: RequestInit) => Promise<Response>; push: (event: string, data: unknown, id: string) => void } {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (event, data, id) => controller.enqueue(encoder.encode(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
  };
}

function openStream(): ReturnType<typeof controlledStream> {
  const stream = controlledStream();
  startEventStream(() => undefined, () => new EventStreamClient({ url: '/api/events', fetch: stream.fetch, sleep: async () => undefined }));
  return stream;
}

describe('useApiCatalog', () => {
  test('filtres et recherche passent dans la requête ; un changement de filtre repart de la première page', async () => {
    const seen = installApi({ 'GET /api/apis': () => json(200, { apis: [apiSummary()], next_cursor: null }) });
    const catalog = inScope(() => useApiCatalog({ pollMs: 0, searchDebounceMs: 0 }));
    await until(() => catalog.apis.value.length === 1);
    expect(seen[0]).toBe('GET /api/apis?limit=25');
    catalog.filters.status = 'bloquee';
    catalog.filters.execution = 'playwright';
    await until(() => seen.length >= 2 && seen.some((entry) => entry.includes('status=bloquee') && entry.includes('execution=playwright')));
    catalog.filters.q = 'livres';
    await until(() => seen.some((entry) => entry.includes('q=livres')));
    expect(catalog.hasActiveFilter.value).toBe(true);
  });

  test('pagination serveur : le curseur de la page suivante part dans la requête, « précédent » le rejoue', async () => {
    const seen = installApi({
      'GET /api/apis': (request) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return json(200, cursor === 'c2' ? { apis: [apiSummary({ slug: 'zz-page-2', id: UUID(2) })], next_cursor: null } : { apis: [apiSummary({ slug: 'zz-page-1' })], next_cursor: 'c2' });
      },
    });
    const catalog = inScope(() => useApiCatalog({ pollMs: 0 }));
    await until(() => catalog.apis.value[0]?.slug === 'zz-page-1');
    expect(catalog.hasNext.value).toBe(true);
    expect(catalog.hasPrevious.value).toBe(false);
    catalog.next();
    await until(() => catalog.apis.value[0]?.slug === 'zz-page-2');
    expect(seen.at(-1)).toContain('cursor=c2');
    expect(catalog.pageNumber.value).toBe(2);
    catalog.previous();
    await until(() => catalog.apis.value[0]?.slug === 'zz-page-1');
    expect(catalog.hasPrevious.value).toBe(false);
  });

  test('statusChanges : seul le changement de statut d’une ligne déjà connue est annoncé', () => {
    const before = [apiSummary({ slug: 'a', status: 'sain' }), apiSummary({ slug: 'b', status: 'erreur' })];
    const after = [apiSummary({ slug: 'a', status: 'warning' }), apiSummary({ slug: 'b', status: 'erreur' }), apiSummary({ slug: 'nouvelle', status: 'enquete' })];
    expect(statusChanges(before, after)).toEqual([{ slug: 'a', from: 'sain', to: 'warning' }]);
    expect(statusChanges([], after)).toEqual([]);
  });

  test('relecture toutes les 15 s (sans repasser par l’état de chargement) et à chaque changement de statut du flux SSE', async () => {
    expect(CATALOG_POLL_MS).toBe(15_000);
    let status: 'sain' | 'erreur' = 'sain';
    const seen = installApi({ 'GET /api/apis': () => json(200, { apis: [apiSummary({ status })], next_cursor: null }) });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stream = openStream();
    const catalog = inScope(() => useApiCatalog());
    await until(() => catalog.apis.value.length === 1);
    vi.advanceTimersByTime(CATALOG_POLL_MS);
    await until(() => seen.length === 2);
    expect(catalog.loading.value).toBe(false);
    vi.useRealTimers();
    status = 'erreur';
    stream.push('status.changed', { slug: 'zz-books' }, '1');
    await until(() => catalog.apis.value[0]?.status === 'erreur');
    expect(catalog.statusChanges.value).toEqual([{ slug: 'zz-books', from: 'sain', to: 'erreur' }]);
  });
});

describe('useApiCatalog : Suspendre le suivi (WCAG 2.2.2, tâche 3.9)', () => {
  test('suspendu : ni relecture périodique ni relecture par le flux SSE, donc aucune annonce ; à la reprise, une relecture rattrape', async () => {
    let status: 'sain' | 'erreur' = 'sain';
    const seen = installApi({ 'GET /api/apis': () => json(200, { apis: [apiSummary({ status })], next_cursor: null }) });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stream = openStream();
    const catalog = inScope(() => useApiCatalog());
    await until(() => catalog.apis.value.length === 1);
    expect(catalog.suspended.value).toBe(false);

    catalog.suspended.value = true;
    status = 'erreur';
    vi.advanceTimersByTime(CATALOG_POLL_MS * 3);
    vi.useRealTimers();
    stream.push('status.changed', { slug: 'zz-books' }, '1');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen).toHaveLength(1);
    expect(catalog.apis.value[0]?.status).toBe('sain');
    expect(catalog.statusChanges.value).toEqual([]);

    catalog.suspended.value = false;
    await until(() => catalog.apis.value[0]?.status === 'erreur');
    expect(seen).toHaveLength(2);
  });
});

describe('useApiDetail : bandeau « Action requise »', () => {
  const asking = apiDetail({ status: 'action_requise', status_reason: { code: 'cookie_expired', params: { domain: 'monsite.example' } }, requires: { session_domain: 'monsite.example', tunnel: false } });

  test('assert_action_required_as_task : le bandeau devient « Reprise de l’enquête… » sans rechargement, puis s’efface à la fin', async () => {
    const answers = [asking, apiDetail({ ...asking, status: 'enquete', status_reason: { code: 'investigating', params: { n: 1, m: 6 } } }), apiDetail({ status: 'sain' })];
    let call = 0;
    const seen = installApi({ 'GET /api/apis/zz-books': () => json(200, answers[Math.min(call++, answers.length - 1)]) });
    const stream = openStream();
    const page = inScope(() => useApiDetail('zz-books'));
    await until(() => page.detail.value?.status === 'action_requise');

    // 1. L'API attend une action : une tâche (titre, bouton principal, vérification), annoncée comme alerte.
    const task = await renderHtml(ActionRequiredBanner, { detail: page.detail.value, resuming: page.resuming.value });
    expect(task).toContain('role="alert"');
    expect(textOf(task)).toContain('Connecte monsite.example');
    expect(task).toContain('data-testid="action-primary"');
    expect(task).toContain('href="/settings/extension"');
    expect(task).toContain('data-testid="action-verify"');
    expect(page.resuming.value).toBe(false);

    // 2. L'utilisateur connecte le site : le flux annonce le changement, l'API repasse en enquête (transition 17).
    stream.push('status.changed', { api_slug: 'zz-books', to: 'enquete' }, '1');
    await until(() => page.detail.value?.status === 'enquete');
    expect(page.resuming.value).toBe(true);
    const resuming = await renderHtml(ActionRequiredBanner, { detail: page.detail.value, resuming: page.resuming.value });
    expect(textOf(resuming)).toContain(fr.actionRequired.resuming);
    expect(resuming).not.toContain('data-testid="action-banner"');
    expect(resuming).toContain('data-testid="action-resuming"');

    // 3. L'enquête se termine : le bandeau s'efface. Aucune relecture de la page : seulement des lectures de la fiche.
    stream.push('status.changed', { api_slug: 'zz-books', to: 'sain' }, '2');
    await until(() => page.detail.value?.status === 'sain');
    expect(page.resuming.value).toBe(false);
    expect(seen.every((entry) => entry === 'GET /api/apis/zz-books')).toBe(true);
  });

  test('un événement qui concerne une autre API ne relit pas cette fiche', () => {
    const frame = (data: unknown): SseEvent => ({ id: '1', event: 'status.changed', data: JSON.stringify(data) });
    expect(eventConcernsApi(frame({ api_slug: 'autre' }), 'zz-books')).toBe(false);
    expect(eventConcernsApi(frame({ slug: 'zz-books' }), 'zz-books')).toBe(true);
    expect(eventConcernsApi(frame({ payload: { slug: 'autre' } }), 'zz-books')).toBe(false);
    expect(eventConcernsApi(frame({}), 'zz-books')).toBe(true);
    expect(eventConcernsApi({ id: null, event: 'status.changed', data: 'pas du json' }, 'zz-books')).toBe(true);
  });

  test('une erreur de lecture est exposée en code stable, la fiche déjà affichée reste en place pendant une relecture', async () => {
    let fail = false;
    installApi({ 'GET /api/apis/zz-books': () => (fail ? json(404, { error: { code: 'not_found', message: 'x' } }) : json(200, apiDetail())) });
    const page = inScope(() => useApiDetail('zz-books'));
    await until(() => page.detail.value !== null);
    fail = true;
    await page.refetch({ silent: true });
    expect(page.error.value?.code).toBe('not_found');
    expect(page.detail.value?.slug).toBe('zz-books');
  });
});

describe('actions de la fiche', () => {
  test('Lancer : sans attente (wait=0), version choisie, corps conforme à RunRequest ; erreur 400 en code stable', async () => {
    let body: unknown;
    let query = '';
    installApi({
      'POST /api/apis/zz-books/runs': async (request) => {
        body = await request.json();
        query = new URL(request.url).search;
        return json(202, { run_id: UUID(7), state: 'queued' });
      },
    });
    const actions = inScope(() => useApiActions('zz-books'));
    expect(await actions.launch({ max_pages: 2 }, 2)).toBe(UUID(7));
    expect(body).toEqual({ input: { max_pages: 2 }, strategy_version: 2 });
    expect(query).toBe('?wait=0');
    installApi({ 'POST /api/apis/zz-books/runs': () => json(400, { error: { code: 'invalid_input', message: 'x' } }) });
    expect(await actions.launch({})).toBeNull();
    expect(actions.error.value?.code).toBe('invalid_input');
  });

  test('Ré-enquêter, revenir à une version et modifier la sortie appellent les routes du CDC', async () => {
    const seen = installApi({
      'POST /api/apis/zz-books/investigate': () => json(202, { run_id: UUID(8), state: 'queued' }),
      'POST /api/apis/zz-books/versions/2/revert': () => json(200, apiDetail({ status: 'warning', status_reason: { code: 'reverted', params: { a: 2 } } })),
      'PATCH /api/apis/zz-books': async (request) => json(200, apiDetail({ output_schema: ((await request.json()) as { output_schema: Record<string, unknown> }).output_schema })),
    });
    const actions = inScope(() => useApiActions('zz-books'));
    expect(await actions.reinvestigate()).toBe(UUID(8));
    expect((await actions.revert(2))?.status).toBe('warning');
    expect((await actions.updateOutputSchema({ type: 'object' }))?.output_schema).toEqual({ type: 'object' });
    expect(seen).toEqual(['POST /api/apis/zz-books/investigate', 'POST /api/apis/zz-books/versions/2/revert', 'PATCH /api/apis/zz-books']);
  });
});

describe('listes et versions', () => {
  test('usePagedList : « charger la suite » ajoute la page suivante, une relecture repart de la première', async () => {
    const pages: Record<string, { items: string[]; nextCursor: string | null }> = { '': { items: ['a', 'b'], nextCursor: 'x' }, x: { items: ['c'], nextCursor: null } };
    const list = inScope(() => usePagedList(async (cursor) => pages[cursor ?? '']!));
    await until(() => list.items.value.length === 2);
    expect(list.hasMore()).toBe(true);
    await list.loadMore();
    expect(list.items.value).toEqual(['a', 'b', 'c']);
    expect(list.hasMore()).toBe(false);
    await list.refetch();
    expect(list.items.value).toEqual(['a', 'b']);
  });

  test('versions : liste, diff entre deux versions (requête against), effacement du diff', async () => {
    const diff = { from: 3, to: 2, summary: { code: 'no_change', params: {} }, fields: [], raw: { before: null, after: null } };
    const seen = installApi({
      'GET /api/apis/zz-books/versions': () => json(200, { versions: [{ version: 3, execution: 'fetch', network: 'direct', est_cost_usd: 0.001, created_by: 'repair', parent_version: 2, created_at: '2026-09-30T10:00:00.000Z', validated_samples: 5, run_id: UUID(3) }], next_cursor: null }),
      'GET /api/apis/zz-books/versions/3/diff': () => json(200, diff),
    });
    const versions = inScope(() => useStrategyVersions('zz-books'));
    await until(() => versions.versions.value.length === 1);
    await versions.loadDiff(3, 2);
    expect(seen.at(-1)).toBe('GET /api/apis/zz-books/versions/3/diff?against=2');
    expect(versions.diff.value?.summary.code).toBe('no_change');
    versions.clearDiff();
    expect(versions.diff.value).toBeNull();
  });

  test('assert_revert_shows_preview : revenir à une version charge le diff de la version visée contre la courante, sans toucher au comparateur', async () => {
    const diff = { from: 2, to: 3, summary: { code: 'selector_changed', params: { field: 'price' } }, fields: [], raw: { before: {}, after: {} } };
    const seen = installApi({ 'GET /api/apis/zz-books/versions/2/diff': () => json(200, diff) });
    let current: number | null = 3;
    const versions = inScope(() => useStrategyVersions('zz-books', { immediate: false }));
    const preview = inScope(() => useRevertPreview('zz-books', () => current));
    preview.start(2);
    expect(preview.target.value).toBe(2);
    await until(() => preview.diff.value !== null);
    expect(seen).toEqual(['GET /api/apis/zz-books/versions/2/diff?against=3']);
    expect(preview.diff.value?.summary.code).toBe('selector_changed');
    // Le diff de l'aperçu est distinct de celui du comparateur de l'onglet.
    expect(versions.diff.value).toBeNull();
    preview.cancel();
    expect(preview.target.value).toBeNull();
    expect(preview.diff.value).toBeNull();
    // Sans version courante, rien à comparer : l'aperçu montre la conséquence seule, aucune requête.
    current = null;
    preview.start(2);
    expect(preview.diff.value).toBeNull();
    expect(seen).toHaveLength(1);
  });

  test('groupFailures : erreurs regroupées par classe, la plus fréquente d’abord, dernière occurrence retenue', () => {
    const run = (n: number, failure_class: string | null, created_at: string) => ({ id: UUID(n), failure_class, created_at }) as never;
    const groups = groupFailures([run(1, 'extraction', '2026-09-01T00:00:00Z'), run(2, null, '2026-09-02T00:00:00Z'), run(3, 'extraction', '2026-09-03T00:00:00Z'), run(4, 'forbidden', '2026-09-04T00:00:00Z')]);
    expect(groups).toEqual([
      { failureClass: 'extraction', count: 2, lastRunId: UUID(3) },
      { failureClass: 'forbidden', count: 1, lastRunId: UUID(4) },
    ]);
  });

  test('planifications : création avec le corps de ScheduleWrite, la liste est relue ensuite', async () => {
    let created: unknown;
    const seen = installApi({
      'GET /api/apis/zz-books/schedules': () => json(200, { schedules: [] }),
      'POST /api/apis/zz-books/schedules': async (request) => {
        created = await request.json();
        return json(201, {});
      },
    });
    const schedules = inScope(() => useSchedules('zz-books'));
    await until(() => schedules.schedules.value !== null);
    expect(await schedules.create({ cron: '0 8 * * *', timezone: 'Europe/Paris', input: {}, overlap: 'skip', missed: 'once' })).toBe(true);
    expect(created).toEqual({ cron: '0 8 * * *', timezone: 'Europe/Paris', input: {}, overlap: 'skip', missed: 'once' });
    expect(seen.filter((entry) => entry === 'GET /api/apis/zz-books/schedules')).toHaveLength(2);
  });
});

describe('replay d’enquête', () => {
  const frames = [
    'id: 1\nevent: investigation.started\ndata: {"seq":1,"at":"2026-10-01T08:00:00Z","payload":{}}\n\n',
    'id: 2\nevent: phase.started\ndata: {"seq":2,"at":"2026-10-01T08:00:01Z","payload":{"phase":"access_check"}}\n\n',
    'id: 3\nevent: attempt.finished\ndata: pas du json\n\n',
  ];
  const finite = () => new Response(new ReadableStream<Uint8Array>({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(f)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  test('les événements du flux filtré du run sont lus ; une lecture terminée s’arrête sans reconnecter', async () => {
    const urls: string[] = [];
    const replay = inScope(() => useInvestigationReplay({ sleep: async () => undefined, fetch: async (url) => { urls.push(url); return finite(); } }));
    replay.open('run/1');
    await until(() => replay.status.value === 'stopped');
    expect(urls).toEqual(['/api/runs/run%2F1/events']);
    expect(replay.events.value.map((event) => [event.kind, event.seq])).toEqual([['investigation.started', 1], ['phase.started', 2]]);
    expect(replay.events.value[1]?.params).toEqual({ phase: 'access_check' });
  });

  test('une enquête en cours reste suivie : une fin propre de la réponse (redémarrage du serveur) reconnecte avec Last-Event-ID', async () => {
    const calls: (string | null)[] = [];
    const replay = inScope(() =>
      useInvestigationReplay({
        // Une vraie attente (macrotâche) : sans elle, la boucle de reconnexion ne rendrait jamais la main au test.
        sleep: (ms, signal) => new Promise((resolve) => { const timer = setTimeout(resolve, 1); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }),
        fetch: async (_url, init) => {
          calls.push(new Headers(init.headers).get('last-event-id'));
          return finite();
        },
      }),
    );
    replay.open('en-cours', { live: true });
    await until(() => calls.length >= 2);
    replay.close();
    // Reprise à la position lue, sans rejouer : les événements déjà reçus ne sont pas dupliqués.
    expect(calls.slice(0, 2)).toEqual([null, '3']);
    expect(replay.events.value.map((event) => event.seq)).toEqual([1, 2]);
  });

  test('une enquête suivie en direct qui se termine : la fin de la réponse suivante arrête la lecture, sans boucle de reconnexion', async () => {
    let calls = 0;
    const replay = inScope(() =>
      useInvestigationReplay({
        sleep: (_ms, signal) => new Promise((resolve) => { const timer = setTimeout(resolve, 1); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }),
        fetch: async () => {
          calls += 1;
          return finite();
        },
      }),
    );
    replay.open('en-cours', { live: true });
    await until(() => calls >= 2);
    replay.markFinished();
    await until(() => replay.status.value === 'stopped');
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(after);
  });

  test('ouvrir un autre run repart de zéro ; fermer arrête la lecture', async () => {
    const replay = inScope(() => useInvestigationReplay({ sleep: async () => undefined, fetch: async () => finite() }));
    replay.open('a');
    await until(() => replay.events.value.length === 2);
    replay.open('b');
    expect(replay.events.value).toEqual([]);
    await until(() => replay.events.value.length === 2);
    replay.close();
    expect(replay.status.value).toBe('idle');
  });
});

beforeEach(() => stopEventStream());
