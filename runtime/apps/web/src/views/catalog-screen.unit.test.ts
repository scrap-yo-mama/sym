// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment vue-client
// Écran Catalogue monté côté client (3.17, 20 § 5.2) : la vue d'ensemble est lue d'abord, le tableau s'ouvre sur « À traiter »
// quand des API le demandent (u3 R16), la phrase de synthèse et la barre de santé viennent des comptes réels, et la région
// `status` annonce la variation d'un compteur de pastille (`assert_attention_filters_counts`).
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { components } from '@runtime/client';
import ApiCatalogView from '@/views/ApiCatalogView.vue';
import { setApi } from '@/lib/api';
import fr from '@runtime/i18n/locales/fr.json';
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

  /** Serveur factice paginé par curseur, comme l'API : `limit` au plus 200, `next_cursor` tant qu'il reste des lignes. */
  function servePaged(rows: () => Summary[]): string[] {
    return installApi({
      'GET /api/apis': (request) => {
        const params = new URL(request.url).searchParams;
        const status = params.get('status');
        const limit = Math.min(Number(params.get('limit') ?? 25), 200);
        const from = Number(params.get('cursor') ?? 0);
        const matching = rows().filter((api) => !status || api.status === status);
        const page = matching.slice(from, from + limit);
        return json(200, { apis: page, next_cursor: from + limit < matching.length ? String(from + limit) : null });
      },
    });
  }

  test('« À traiter » au-delà d’une page de 200 : les pages suivantes sont lues par curseur, aucune ligne ne manque', async () => {
    const seen = servePaged(() => make([...Array<Summary['status']>(250).fill('warning'), 'erreur', 'sain']));
    const html = (await open()).html();
    expect(seen.some((entry) => entry.includes('status=warning') && entry.includes('cursor=200'))).toBe(true);
    expect([...html.matchAll(/data-testid="catalog-row"/g)]).toHaveLength(251);
    expect(html).not.toContain('data-testid="attention-partial"');
  });

  test('« À traiter » plus grand que le plafond de lecture : la mention « comptes partiels » le dit, jamais des lignes manquantes en silence', async () => {
    servePaged(() => make([...Array<Summary['status']>(1100).fill('warning'), 'sain']));
    const page = await open();
    // Six pages de 200 à lire puis à décoder : sur une machine chargée, cela dépasse les tours d'attente du montage.
    for (let turn = 0; turn < 200 && !page.html().includes('data-testid="attention-partial"'); turn += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const html = page.html();
    expect(html).toContain('data-testid="attention-partial"');
    expect(textOf(html)).toContain(fr.catalog.attentionPartial.replace('{n}', '1000'));
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

  test('planche (D-60) : titre Bricolage de 44 px, phrase de synthèse dessous, recherche « Rechercher » à droite du titre, avant la carte de santé et les pastilles', async () => {
    serve(() => make(['sain', 'sain', 'sain', 'warning', 'reparation', 'action_requise', 'bloquee']));
    const html = (await open()).html();
    expect(html).toMatch(/<h1[^>]*class="[^"]*font-display[^"]*text-\[44px\]/);
    const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
    expect(header).toContain('data-testid="catalog-summary"');
    expect(header).toContain('id="catalog-search"');
    expect(header).toContain(`placeholder="${fr.catalog.filters.searchPlaceholder}"`);
    expect(textOf(header)).toContain(fr.catalog.filters.search);
    // Phrase de la planche, mot pour mot : le nombre à traiter en lettres en tête de phrase (« Deux »).
    expect(textOf(html)).toContain('6 API en service, 1 arrêtée. Deux demandent ton attention.');
    expect(html.indexOf('id="catalog-search"')).toBeLessThan(html.indexOf('data-testid="catalog-health"'));
    expect(html.indexOf('data-testid="catalog-health"')).toBeLessThan(html.indexOf('data-testid="catalog-pills"'));
  });

  test('assert_row_action_by_status : sur « À traiter » (vue par défaut), une action requise reprise reste visible et dit « Reprise de l’enquête… », puis sort une fois l’enquête finie', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let rows = make(['sain', 'warning', 'action_requise']);
      serve(() => rows);
      const page = await open();
      expect(page.html()).toMatch(/aria-pressed="true"[^>]*data-pill="attention"/);
      const row = (slug: string): string => {
        const html = page.html();
        const at = html.indexOf(`data-slug="${slug}"`);
        return at < 0 ? '' : html.slice(at, html.indexOf('</tr>', at));
      };
      expect(row('zz-api-3')).toContain('data-status="action_requise"');
      // L'utilisateur a connecté sa session : la ligne se coche seule et l'enquête reprend (transition 17).
      rows = make(['sain', 'warning', 'enquete']);
      await vi.advanceTimersByTimeAsync(15_100);
      expect(row('zz-api-3')).toContain('data-testid="row-resuming"');
      expect(textOf(row('zz-api-3'))).toContain(fr.actionRequired.resuming);
      // Toujours en enquête au sondage suivant : la ligne reste là.
      await vi.advanceTimersByTimeAsync(15_100);
      expect(row('zz-api-3')).toContain('data-testid="row-resuming"');
      // Enquête finie (saine) : plus rien à traiter sur cette ligne, elle sort de « À traiter ».
      rows = make(['sain', 'warning', 'sain']);
      await vi.advanceTimersByTimeAsync(15_100);
      expect(row('zz-api-3')).toBe('');
    } finally {
      vi.useRealTimers();
    }
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

describe('écran Catalogue : états vides, en-tête et nom de ligne de la planche (20 § 5.2, revue de 3.17)', () => {
  test('catalogue vide : formes plates aria-hidden, titre positif, bouton « Nouvelle API », plus de boîte en pointillés', async () => {
    serve(() => []);
    const html = (await open()).html();
    const empty = /<section[^>]*data-testid="empty-state"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(empty).not.toBe('');
    expect(empty).toMatch(/data-testid="empty-shapes"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-testid="empty-shapes"/);
    expect(empty).not.toContain('border-dashed');
    expect(empty).toContain('href="/apis/new"');
    expect(textOf(empty)).toContain(fr.catalog.empty.title);
  });

  test.todo('catalogue vide : lien « Voir un exemple avec la démo » (u3 R5), dès que la démo de 3.16 est fusionnée');

  test('filtre vide : texte seul (ni bouton, ni formes, ni boîte)', async () => {
    // Vue d'ensemble : une API à traiter (la pastille « À traiter » s'ouvre) ; la lecture filtrée par statut ne rend rien.
    installApi({
      'GET /api/apis': (request) => json(200, { apis: new URL(request.url).searchParams.get('status') ? [] : make(['sain', 'warning']), next_cursor: null }),
    });
    const html = (await open()).html();
    const noMatch = /<p[^>]*data-testid="catalog-no-match"[\s\S]*?<\/p>/.exec(html)?.[0] ?? '';
    expect(noMatch).not.toBe('');
    expect(textOf(noMatch)).toContain(fr.catalog.noMatch.title);
    expect(html).not.toContain('data-testid="empty-state"');
    expect(html).not.toContain('data-testid="empty-shapes"');
  });

  test('en-tête : aucun second « Nouvelle API » à côté de la recherche, celui de la barre de navigation suffit (3.21, planche)', async () => {
    serve(() => make(['sain']));
    const header = /<header[\s\S]*?<\/header>/.exec((await open()).html())?.[0] ?? '';
    expect(header).toContain('id="catalog-search"');
    expect(header).not.toContain('href="/apis/new"');
  });

  test('ligne : la description est le nom (« Livres de l’accueil »), le domaine et le slug en secondaire', async () => {
    serve(() => [apiSummary({ slug: 'livres-accueil', description: 'Livres de l’accueil', domain: 'books.toscrape.com' })]);
    const html = (await open()).html();
    const row = /<tr[^>]*data-testid="catalog-row"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
    const link = /<a[^>]*href="\/apis\/livres-accueil"[^>]*>([\s\S]*?)<\/a>/.exec(row)?.[1] ?? '';
    expect(textOf(link)).toBe('Livres de l’accueil');
    const secondary = /data-testid="row-secondary"[^>]*>([\s\S]*?)<\/p>/.exec(row)?.[1] ?? '';
    expect(textOf(secondary)).toContain('books.toscrape.com');
    expect(textOf(secondary)).toContain('livres-accueil');
  });
});
