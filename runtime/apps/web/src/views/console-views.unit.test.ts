// SPDX-License-Identifier: AGPL-3.0-only
// Vues du catalogue et de la fiche : état vide positif, régions annoncées, routes. Les vues lisent leurs données au montage
// (aucun navigateur ici) : les comportements en direct sont vérifiés sur les composables (console-data.unit.test.ts).
import { describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import ApiCatalogView from '@/views/ApiCatalogView.vue';
import { createAppRouter } from '@/router/index';
import fr from '@runtime/i18n/locales/fr.json';
import { renderHtml, textOf } from '@/testing/console-fixtures';

describe('catalogue', () => {
  test('un catalogue vide a un titre positif, une explication et un bouton, et ne se confond pas avec une erreur', async () => {
    const html = await renderHtml(ApiCatalogView);
    expect(textOf(html)).toContain(fr.catalog.empty.title);
    expect(textOf(html)).toContain(fr.catalog.empty.description);
    expect(html).toContain('href="/apis/new"');
    expect(html).toContain('data-testid="empty-state"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('data-testid="error-state"');
  });

  test('titre de page focalisable à chaque route, formulaire de recherche, région status toujours présente', async () => {
    const html = await renderHtml(ApiCatalogView);
    expect(html).toContain('<h1 data-route-heading tabindex="-1"');
    expect(html).toContain('role="search"');
    expect(html).toContain('data-testid="catalog-live"');
    expect(/data-testid="catalog-live"/.test(html) && /role="status" aria-live="polite" class="sr-only" data-testid="catalog-live"/.test(html)).toBe(true);
    for (const id of ['catalog-search', 'catalog-status', 'catalog-execution', 'catalog-network']) expect(html).toContain(`for="${id}"`);
  });
});

describe('routes', () => {
  test('/apis est le catalogue ; /apis/:slug et /apis/:slug/:onglet sont la fiche ; un onglet inconnu n’existe pas', () => {
    const router = createAppRouter(createMemoryHistory());
    expect(router.resolve('/apis').name).toBe('catalog');
    expect(router.resolve('/apis/zz-books').name).toBe('api');
    const tab = router.resolve('/apis/zz-books/investigations');
    expect(tab.name).toBe('api');
    expect(tab.params).toMatchObject({ slug: 'zz-books', tab: 'investigations' });
    expect(router.resolve('/apis/zz-books/inconnu').name).toBe('not-found');
    expect(router.resolve('/apis/zz-books').meta.titleKey).toBe('detail.title');
  });

  test('les routes statiques de /apis/… ajoutées plus tard (nouvelle API) l’emportent sur le paramètre de la fiche', () => {
    const router = createAppRouter(createMemoryHistory());
    router.addRoute({ path: '/apis/new', name: 'new-api', component: { render: () => null }, meta: { titleKey: 'x' } });
    expect(router.resolve('/apis/new').name).toBe('new-api');
    expect(router.resolve('/apis/new-york').name).toBe('api');
  });
});
