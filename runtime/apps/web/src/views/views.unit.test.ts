// SPDX-License-Identifier: AGPL-3.0-only
// « Tous les runs » et « Nouvelle API » (06 § 2, tâche 3.5), rendus côté serveur avec un faux serveur REST (aucun réseau réel).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import en from '@runtime/i18n/locales/en.json';
import { resetSession } from '@/composables/useSession';
import { setApi } from '@/lib/api';
import { esc, installFakeServer, json, ME, sessionRoutes, signedIn, view } from '@/testing/console.testkit';
import NewApiView from './NewApiView.vue';
import RunsView from './RunsView.vue';

beforeEach(() => resetSession());
afterEach(() => {
  setApi(undefined);
  resetSession();
});

const OTHER = '3f2b6c1e-0000-4000-8000-0000000000ff';
const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  api_id: 'a',
  api_slug: 'annonces',
  owner_id: ME.id,
  trigger: 'schedule',
  state: 'succeeded',
  outcome: 'clean',
  degraded_reasons: [],
  failure_class: null,
  created_at: '2026-10-01T10:00:00Z',
  started_at: '2026-10-01T10:00:01Z',
  finished_at: '2026-10-01T10:00:03Z',
  duration_ms: 2000,
  cost: { llm_usd: 0, proxy_usd: 0, total_usd: 0.001, estimated: true },
  items: 48,
  ...extra,
});

describe('Tous les runs', () => {
  test('tableau : API, déclencheur, état (icône et libellé), résultat, raisons, durée, coût estimé préfixé de ~, items', async () => {
    installFakeServer({
      ...sessionRoutes,
      'GET /api/runs': () =>
        json(200, {
          runs: [
            run('r1', { outcome: 'degraded', degraded_reasons: ['retried', 'escalated'], cost: { llm_usd: 0.01, proxy_usd: 0, total_usd: 0.002, estimated: true } }),
            run('r2', { state: 'failed', outcome: 'failed', failure_class: 'blocked_by_protection', items: null, cost: { llm_usd: null, proxy_usd: null, total_usd: null } }),
            run('r3', { state: 'queued', outcome: null, started_at: null, duration_ms: null }),
          ],
          next_cursor: 'suite',
        }),
    });
    await signedIn();
    const html = await view(RunsView);
    expect(html).toContain('<caption class="sr-only">Runs, newest first</caption>');
    expect(html).toContain('href="/apis/annonces"');
    expect(html).toContain('>Succeeded</span>');
    expect(html).toContain('>Failed</span>');
    expect(html).toContain('>Queued</span>');
    expect(html).toContain('Degraded');
    expect(html).toContain('Retried, Costlier method');
    expect(html).toContain('~$0.002');
    expect(html).toContain('2 s');
    expect(html).toContain('>48<');
    expect(html).toContain('not started');
    // Un prix inconnu n'est jamais 0 ; une classe d'échec remplace le résultat d'un run sans issue.
    expect(html).toMatch(/Failed<\/td><td class="p-3">—<\/td>/);
    expect(html).toContain('Page 1');
    expect(html).toContain('Next page');
  });

  test('l’état n’est pas porté par la couleur seule : chaque badge a une icône de forme et un libellé', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/runs': () => json(200, { runs: [run('r1'), run('r2', { state: 'failed' }), run('r3', { state: 'cancelled' })], next_cursor: null }) });
    await signedIn();
    const html = await view(RunsView);
    const badges = [...html.matchAll(/<span class="inline-flex[^>]*data-state="([a-z_]+)"><span aria-hidden="true">([^<]+)<\/span><span>([^<]+)<\/span>/g)];
    expect(badges.map((m) => m[1])).toEqual(['succeeded', 'failed', 'cancelled']);
    expect(new Set(badges.map((m) => m[2])).size).toBe(3);
    for (const badge of badges) expect((badge[3] ?? '').length).toBeGreaterThan(2);
  });

  test('run d’un autre membre : état, coût et durée seulement ; aucun contrôle d’impersonation ni contenu', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/runs': () => json(200, { runs: [run('r1'), run('r2', { owner_id: OTHER })], next_cursor: null }) });
    await signedIn();
    const html = await view(RunsView);
    expect((html.match(/data-testid="run-other"/g) ?? []).length).toBe(1);
    expect(html).toContain(esc(en.runs.other));
    expect(html).not.toMatch(/impersonat|sign in as|act as|se connecter en tant|agir en tant|view (the )?(items|dataset|content)/i);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*(items|dataset|contenu)/i);
  });

  test('filtres : API, état, déclencheur, période ; chaque champ est étiqueté', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/runs': () => json(200, { runs: [run('r1')], next_cursor: null }) });
    await signedIn();
    const html = await view(RunsView);
    for (const id of ['runs-api', 'runs-state', 'runs-trigger', 'runs-since', 'runs-until']) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    for (const label of ['Succeeded', 'Waiting for your computer', 'Skipped: quota reached', 'MCP', 'Schedule', 'Canary']) expect(html).toContain(`>${label}</option>`);
  });

  test('vide : titre positif, explication et bouton, distinct d’une erreur ; vide filtré : autre texte', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/runs': () => json(200, { runs: [], next_cursor: null }) });
    await signedIn();
    const html = await view(RunsView);
    expect(html).toContain(en.runs.empty.title);
    expect(html).toContain(en.runs.empty.text);
    expect(html).toContain('href="/apis/new"');
    expect(html).not.toContain('role="alert"');
  });

  test('erreur : message lisible et bouton Réessayer ; 403 : message traduit', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/runs': () => json(503, { error: { code: 'not_ready', message: 'x' } }) });
    await signedIn();
    const html = await view(RunsView);
    expect(html).toContain('data-testid="runs-error"');
    expect(html).toContain(en.errors.server);
    expect(html).toContain(en.common.retry);
    installFakeServer({ ...sessionRoutes, 'GET /api/runs': () => json(403, { error: { code: 'forbidden', message: 'x' } }) });
    expect(await view(RunsView)).toContain(en.errors.forbidden);
  });
});

describe('Nouvelle API : formulaire', () => {
  test('champs étiquetés, politique réseau avec le réglage neutre du tunnel, exemple facultatif', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(403, { error: { code: 'forbidden', message: 'x' } }) });
    const html = await view(NewApiView);
    expect(html).toContain('data-testid="new-api-form"');
    for (const id of ['api-description', 'api-url', 'api-example']) expect(html).toContain(`for="${id}"`);
    expect(html).toContain(en.newApi.network.legend);
    expect(html).toContain(en.newApi.network.tunnel);
    expect(html).toContain('Run from my browser (my session, my IP); a verification will hand control back to me');
    expect(html).toContain(en.newApi.network.resProxy);
    expect(html).toContain(en.newApi.example);
    expect(html).toContain(en.newApi.submit);
  });

  test('l’avertissement des sites à compte n’apparaît qu’une fois déclaré ou exigé', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(403, { error: { code: 'forbidden', message: 'x' } }) });
    const html = await view(NewApiView);
    expect(html).toContain('data-testid="account-declare"');
    expect(html).not.toContain('data-testid="account-warning"');
  });

  test('fournisseur de modèle : le nom du fournisseur qui recevra des extraits nettoyés ; message générique sans accès aux réglages', async () => {
    const settings = {
      providers: [
        { id: 'autre', preset: 'openai', base_url: 'https://x.test/v1', api_key_set: true, headers_set: false },
        { id: 'zai', preset: 'zai', base_url: 'https://api.z.test/v1', api_key_set: true, headers_set: false },
      ],
      roles: { investigate: { provider: 'zai', model: 'glm' } },
    };
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, settings) });
    expect(await view(NewApiView)).toContain('zai will receive cleaned traffic excerpts.');
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(403, { error: { code: 'forbidden', message: 'x' } }) });
    expect(await view(NewApiView)).toContain(en.newApi.providerNoticeGeneric);
  });
});

describe('robots.txt : ni règle ni réglage (D-91)', () => {
  test('le formulaire de création n’a aucun champ robots', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(403, { error: { code: 'forbidden', message: 'x' } }) });
    const html = await view(NewApiView);
    expect(html).not.toMatch(/robots/i);
  });
});
