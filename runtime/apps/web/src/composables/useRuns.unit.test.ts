// SPDX-License-Identifier: AGPL-3.0-only
// « Tous les runs » : filtres envoyés au serveur, pagination par curseur opaque, réponse la plus récente seule retenue.
import { afterEach, describe, expect, test } from 'vitest';
import { setApi } from '@/lib/api';
import { installFakeServer, json } from '@/testing/console.testkit';
import { PAGE_SIZE, runQuery, useRuns, type RunFilters } from './useRuns';

afterEach(() => setApi(undefined));

const run = (id: string) => ({
  id,
  api_id: 'a',
  api_slug: 'annonces',
  owner_id: 'o',
  trigger: 'rest',
  state: 'succeeded',
  outcome: 'clean',
  degraded_reasons: [],
  failure_class: null,
  created_at: '2026-10-01T10:00:00Z',
  started_at: '2026-10-01T10:00:01Z',
  finished_at: '2026-10-01T10:00:03Z',
  duration_ms: 2000,
  cost: { llm_usd: 0, proxy_usd: 0, total_usd: 0.001 },
  items: 3,
});

describe('runQuery', () => {
  test('seuls les filtres renseignés sont envoyés, les jours deviennent des bornes ISO', () => {
    const none: RunFilters = { api: '', state: '', trigger: '', since: '', until: '' };
    expect(runQuery(none, undefined)).toEqual({ api: undefined, state: undefined, trigger: undefined, since: undefined, until: undefined, cursor: undefined, limit: PAGE_SIZE });
    const full = runQuery({ api: ' annonces ', state: 'failed', trigger: 'schedule', since: '2026-09-01', until: '2026-09-30' }, 'c2');
    expect(full).toMatchObject({ api: 'annonces', state: 'failed', trigger: 'schedule', cursor: 'c2' });
    expect(new Date(full.since ?? '').getTime()).toBeLessThan(new Date(full.until ?? '').getTime());
    expect(runQuery({ ...none, since: 'pas une date' }, undefined).since).toBeUndefined();
  });
});

describe('useRuns', () => {
  test('première page, page suivante par curseur, retour à la page précédente', async () => {
    const calls = installFakeServer({
      'GET /api/runs': (call) => {
        const cursor = new URLSearchParams(call.search).get('cursor');
        if (cursor === 'c2') return json(200, { runs: [run('r3')], next_cursor: null });
        return json(200, { runs: [run('r1'), run('r2')], next_cursor: 'c2' });
      },
    });
    const runs = useRuns();
    await runs.apply();
    expect(runs.runs.value.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(runs.hasNext.value).toBe(true);
    expect(runs.hasPrevious.value).toBe(false);
    await runs.next();
    expect(runs.runs.value.map((r) => r.id)).toEqual(['r3']);
    expect(runs.pageNumber.value).toBe(2);
    expect(runs.hasNext.value).toBe(false);
    await runs.previous();
    expect(runs.runs.value.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(runs.pageNumber.value).toBe(1);
    expect(calls.map((c) => new URLSearchParams(c.search).get('cursor'))).toEqual([null, 'c2', null]);
    expect(new URLSearchParams(calls[0]?.search).get('limit')).toBe(String(PAGE_SIZE));
  });

  test('un filtre appliqué repart de la première page ; Réinitialiser les efface', async () => {
    const calls = installFakeServer({ 'GET /api/runs': () => json(200, { runs: [], next_cursor: null }) });
    const runs = useRuns();
    runs.filters.state = 'failed';
    runs.filters.api = 'annonces';
    await runs.apply();
    expect(new URLSearchParams(calls[0]?.search).get('state')).toBe('failed');
    expect(new URLSearchParams(calls[0]?.search).get('api')).toBe('annonces');
    await runs.reset();
    expect(new URLSearchParams(calls[1]?.search).has('state')).toBe(false);
    expect(runs.filters.state).toBe('');
  });

  test('une erreur du serveur devient une clé de message ; un 403 aussi, sans exception', async () => {
    installFakeServer({ 'GET /api/runs': () => json(403, { error: { code: 'forbidden', message: 'x' } }) });
    const runs = useRuns();
    await runs.apply();
    expect(runs.failure.value).toBe('errors.forbidden');
    expect(runs.loading.value).toBe(false);
  });

  test('une réponse tardive d’une requête périmée n’écrase pas la plus récente', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    installFakeServer({
      'GET /api/runs': async (call) => {
        if (new URLSearchParams(call.search).get('api') === 'lent') {
          await gate;
          return json(200, { runs: [run('ancien')], next_cursor: null });
        }
        return json(200, { runs: [run('recent')], next_cursor: null });
      },
    });
    const runs = useRuns();
    runs.filters.api = 'lent';
    const slow = runs.apply();
    runs.filters.api = 'rapide';
    await runs.apply();
    release();
    await slow;
    expect(runs.runs.value.map((r) => r.id)).toEqual(['recent']);
  });
});
