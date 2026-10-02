// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment vue-client
// Écran Catalogue monté côté client (3.17, 20 § 5.2) : la vue d'ensemble est lue d'abord, le tableau s'ouvre sur « À traiter »
// quand des API le demandent (u3 R16), la phrase de synthèse et la barre de santé viennent des comptes réels, et la région
// `status` annonce la variation d'un compteur de pastille (`assert_attention_filters_counts`).
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { components } from '@runtime/client';
import ApiCatalogView from '@/views/ApiCatalogView.vue';
import { setApi } from '@/lib/api';
import fr from '@/i18n/locales/fr.json';
import { apiSummary, installApi, json, textOf, UUID } from '@/testing/console-fixtures';
import { mountHtml, type MountedHtml } from '@/testing/memory-mount';

type Summary = components['schemas']['ApiSummary'];
const mounted: MountedHtml[] = [];

afterEach(() => {
  for (const page of mounted.splice(0)) page.unmount();
  vi.unstubAllGlobals();
  setApi(undefined);
});

const make = (statuses: Summary['status'][]): Summary[] => statuses.map((status, index) => apiSummary({ id: UUID(index + 1), slug: `zz-api-${index + 1}`, status }));

/** Serveur factice : filtre `status` et `limit` honorés comme le serveur, requêtes enregistrées. */
function serve(rows: () => Summary[]): string[] {
  return installApi({
    'GET /api/apis': (request) => {
      const status = new URL(request.url).searchParams.get('status');
      return json(200, { apis: rows().filter((api) => !status || api.status === status), next_cursor: null });
    },
  });
}

async function open(): Promise<MountedHtml> {
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
  const page = await mountHtml(ApiCatalogView, {}, 'fr');
  mounted.push(page);
  return page;
}

describe('écran Catalogue', () => {
  test('des API à traiter : la pastille « À traiter » est active à l’ouverture et le tableau ne montre qu’elles', async () => {
    const seen = serve(() => make(['sain', 'sain', 'warning', 'erreur', 'bloquee']));
    const html = (await open()).html();
    expect(html).toMatch(/aria-pressed="true"[^>]*data-pill="attention"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-pill="all"/);
    // Une lecture par statut à traiter (le serveur filtre un statut à la fois), pas la liste complète.
    expect(seen.some((entry) => entry.includes('status=warning'))).toBe(true);
    expect(seen.some((entry) => entry.includes('status=erreur'))).toBe(true);
    expect(seen.some((entry) => entry.includes('status=action_requise'))).toBe(true);
    const rows = [...html.matchAll(/data-testid="catalog-row" data-slug="([^"]+)"/g)].map((match) => match[1]);
    expect(rows).toEqual(['zz-api-3', 'zz-api-4']);
    expect(textOf(html)).toContain('À traiter · 2');
  });

  test('rien à traiter : le tableau s’ouvre sur Tout, sans filtre', async () => {
    const seen = serve(() => make(['sain', 'sain', 'bloquee']));
    const html = (await open()).html();
    expect(html).toMatch(/aria-pressed="true"[^>]*data-pill="all"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-pill="attention"/);
    expect(seen.filter((entry) => entry.includes('status=')).length).toBe(0);
    expect([...html.matchAll(/data-testid="catalog-row"/g)]).toHaveLength(3);
  });

  test('titre, phrase de synthèse en comptes réels, barre de santé sans l’API bloquée', async () => {
    serve(() => make(['sain', 'sain', 'sain', 'sain', 'sain', 'warning', 'bloquee']));
    const text = textOf((await open()).html());
    expect(text).toContain(fr.catalog.title);
    expect(text).toContain('6 API en service, 1 arrêtée. Une API demande ton attention.');
    expect(text).toContain('5 sur 6 saines · 1 arrêt volontaire');
  });

  test('la région status n’annonce que la variation d’un compteur de pastille, par le flux ou le sondage', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let rows = make(['sain', 'sain', 'warning']);
      serve(() => rows);
      const page = await open();
      const live = (): string => textOf(/data-testid="catalog-live">([\s\S]*?)<\/div>/.exec(page.html())?.[1] ?? '');
      expect(live()).toBe('');
      rows = make(['sain', 'sain', 'erreur', 'erreur']);
      await vi.advanceTimersByTimeAsync(15_100);
      expect(live()).toContain('Tout : 4.');
      expect(live()).toContain('À traiter : 2.');
      expect(live()).not.toContain('Saines');
    } finally {
      vi.useRealTimers();
    }
  });
});
