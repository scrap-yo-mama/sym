// SPDX-License-Identifier: AGPL-3.0-only
// Fidélité du Catalogue à sa planche (3.17, D-60, 20 § 5.2 ; maquette-ux/latest/project/Catalogue.dc.html du CDC) : textes repris
// MOT POUR MOT en français, même structure (titre Bricolage de 44 px et phrase de synthèse, recherche à droite du titre, carte de
// santé, pastilles, tableau en carte), seules les données fictives devenant réelles. Les écarts gardés sont ceux que justifient
// 20 § 5.2 (libellés de statut et d'exécution de 06, colonnes de 06) et 20b § 3.3 (ligne de ratio) ; ils
// sont listés ici. La comparaison visuelle côte à côte (maquette servie en statique, même viewport, fr et en) est
// e2e/maquette-fidelity.e2e.ts. Rendu côté serveur sous Node.
import { describe, expect, test } from 'vitest';
import ApiCatalogTable from '@/components/catalog/ApiCatalogTable.vue';
import CatalogHealth from '@/components/catalog/CatalogHealth.vue';
import fr from '@runtime/i18n/locales/fr.json';
import { actionCause } from '@/lib/action-required';
import { rowAction } from '@/lib/catalog-actions';
import { catalogHealth, countByStatus } from '@/lib/catalog-health';
import { apiSummary, controls, renderHtml, textOf, UUID } from '@/testing/console-fixtures';
import type { ApiStatus } from '@/lib/status';

/** Textes de la planche Catalogue, repris mot pour mot (fr). */
const MAQUETTE = {
  title: 'Ton catalogue',
  search: 'Rechercher',
  searchPlaceholder: 'nom, domaine…',
  columns: ['API', 'STATUT', 'MODE · RÉSEAU', 'COÛT / RUN', 'DERNIER RUN'],
  legend: ['3 saines', '1 à surveiller', '1 en réparation', '1 attend ton action'],
  stopped: '1 arrêtée',
  pills: ['Tout', 'À traiter', 'Saines', 'Arrêtées'],
  /** Ligne de la planche : nom, puis domaine en dessous. */
  row: ['livres-accueil', 'books.toscrape.com'] as const,
  connect: 'Connecter ma session',
  alternatives: 'Voir les alternatives',
};

/** Le catalogue de la planche : 3 saines, 1 à surveiller, 1 en réparation, 1 action requise, 1 arrêtée. */
function planche() {
  const statuses: ApiStatus[] = ['sain', 'sain', 'sain', 'warning', 'reparation', 'action_requise', 'bloquee'];
  return statuses.map((status, index) =>
    apiSummary({ id: UUID(index + 1), slug: `zz-api-${index + 1}`, status, ...(status === 'action_requise' ? { status_reason: { code: 'auth_required', params: {} } } : {}) }),
  );
}

describe('fidélité à la planche Catalogue (D-60) : textes mot pour mot', () => {
  test('titre, recherche, pastilles, actions : les chaînes françaises sont celles de la planche', () => {
    expect(fr.catalog.title).toBe(MAQUETTE.title);
    expect(fr.catalog.filters.search).toBe(MAQUETTE.search);
    expect(fr.catalog.filters.searchPlaceholder).toBe(MAQUETTE.searchPlaceholder);
    expect([fr.catalog.pills.all, fr.catalog.pills.attention, fr.catalog.pills.healthy, fr.catalog.pills.stopped]).toEqual(MAQUETTE.pills);
    expect(fr.catalog.rowAction.alternatives).toBe(MAQUETTE.alternatives);
  });

  test('en-têtes du tableau : ceux de la planche, en capitales (les colonnes de 06 suivent, 20 § 5.2)', async () => {
    const html = await renderHtml(ApiCatalogTable, { apis: planche() }, 'fr');
    const head = /<thead[\s\S]*?<\/thead>/.exec(html)?.[0] ?? '';
    const labels = [...head.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((match) => textOf(match[1] ?? '').toLocaleUpperCase('fr'));
    expect(labels.slice(0, 5)).toEqual(MAQUETTE.columns);
    expect(head).toContain('uppercase');
  });

  test('carte de santé : légende « 3 saines · 1 à surveiller · 1 en réparation · 1 attend ton action », chiffres en gras, « 1 arrêtée » à part', async () => {
    const html = await renderHtml(CatalogHealth, { health: catalogHealth(countByStatus(planche())) }, 'fr');
    const legend = /data-testid="health-legend"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
    const items = [...legend.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) => textOf(match[1] ?? ''));
    expect(items).toEqual(MAQUETTE.legend);
    expect(legend).toMatch(/<b[^>]*>3<\/b>/);
    const mark = /data-testid="health-stopped-mark"[\s\S]*?<\/span>\s*<\/span>|data-testid="health-stopped-mark"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    expect(textOf(mark)).toContain(MAQUETTE.stopped);
  });

  test('assert_row_action_by_status : la ligne action_requise dit « Connecter ma session », le même verbe que le bandeau de la fiche', async () => {
    const connect = actionCause('auth_required');
    expect(connect?.cause).toBe('connect');
    expect(fr.actionRequired.connect.button).toBe(MAQUETTE.connect);
    expect(rowAction({ slug: 'zz-a', status: 'action_requise', status_reason: { code: 'auth_required' } })?.labelKey).toBe('actionRequired.connect.button');
    const html = await renderHtml(ApiCatalogTable, { apis: planche() }, 'fr');
    const row = html.slice(html.indexOf('data-status="action_requise"'), html.indexOf('</tr>', html.indexOf('data-status="action_requise"')));
    expect(controls(row).map((control) => control.text)).toContain(MAQUETTE.connect);
  });
});

describe('fidélité à la planche Catalogue (D-60) : structure et hiérarchie', () => {
  test('la carte de santé et le tableau sont des cartes papier de 20 px de rayon ; la ligne action requise est surlignée', async () => {
    const health = await renderHtml(CatalogHealth, { health: catalogHealth(countByStatus(planche())) }, 'fr');
    expect(health).toMatch(/<section[^>]*class="[^"]*rounded-xl[^"]*bg-card/);
    const table = await renderHtml(ApiCatalogTable, { apis: planche() }, 'fr');
    expect(table).toMatch(/^<div[^>]*class="[^"]*rounded-xl[^"]*bg-card/);
    expect(table).toMatch(/class="[^"]*bg-accent[^"]*"[^>]*data-testid="catalog-row"[^>]*data-status="action_requise"/);
  });

  test('ligne : le nom puis le domaine en dessous (« Livres de l’accueil / books.toscrape.com ») ; la description n’apparaît qu’à défaut de domaine', async () => {
    const [name, domain] = MAQUETTE.row;
    const html = await renderHtml(ApiCatalogTable, { apis: [apiSummary({ slug: name, domain, description: 'Je veux les livres depuis books.toscrape.com pour suivre les prix' })] }, 'fr');
    const cell = /<th scope="row"[\s\S]*?<\/th>/.exec(html)?.[0] ?? '';
    expect(textOf(cell)).toBe(`${name} ${domain}`);
    expect(cell).toMatch(/data-testid="row-domain"[^>]*translate="no"|translate="no"[^>]*data-testid="row-domain"/);
    // Domaine connu seulement par la session (action requise) : c'est lui qui s'affiche.
    const session = await renderHtml(ApiCatalogTable, { apis: [apiSummary({ slug: 'zz-post', domain: null, requires: { session_domain: 'zz-site-a-compte.example', tunnel: true } })] }, 'fr');
    expect(textOf(/<th scope="row"[\s\S]*?<\/th>/.exec(session)?.[0] ?? '')).toBe('zz-post zz-site-a-compte.example');
    // Aucun domaine connu : la description (06 § 2, « nom et description ») tient la seconde ligne.
    const none = await renderHtml(ApiCatalogTable, { apis: [apiSummary({ slug: 'zz-books', domain: null })] }, 'fr');
    expect(textOf(/<th scope="row"[\s\S]*?<\/th>/.exec(none)?.[0] ?? '')).toBe('zz-books Livres de la page d’accueil');
  });

  test('dernier run en <time datetime> (20 § 5.2) : une date formatée par Intl est une donnée, pas une chaîne de l’interface', async () => {
    const html = await renderHtml(ApiCatalogTable, { apis: [apiSummary({ last_run_at: '2026-10-01T08:00:00.000Z' })] }, 'fr');
    expect(html).toMatch(/<time datetime="2026-10-01T08:00:00.000Z"[^>]*>[^<]+<\/time>/);
  });

  test('mode · réseau dans une seule colonne, comme la planche (« fetch seul · direct », libellés de 06)', async () => {
    const html = await renderHtml(ApiCatalogTable, { apis: [apiSummary()] }, 'fr');
    expect(textOf(html)).toContain(`${fr.execution.fetch} · ${fr.network.direct}`);
  });
});
