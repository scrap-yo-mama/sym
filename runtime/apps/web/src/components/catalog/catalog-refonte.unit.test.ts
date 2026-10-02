// SPDX-License-Identifier: AGPL-3.0-only
// Refonte du Catalogue (3.17, 20 § 5.2, critères de 20b § 3.3) : barre de santé sans les API bloquées, pastilles-filtres avec
// compteurs en texte, une action utile par ligne. Rendu côté serveur sous Node ; le comportement à l'ouverture (« À traiter »
// d'abord) et l'annonce des compteurs sont dans views/catalog-screen.unit.test.ts, le navigateur réel dans e2e/catalog-new-api.e2e.ts.
import { describe, expect, test } from 'vitest';
import ActionRequiredBanner from '@/components/api/ActionRequiredBanner.vue';
import ApiCatalogTable from '@/components/catalog/ApiCatalogTable.vue';
import CatalogHealth from '@/components/catalog/CatalogHealth.vue';
import CatalogPills from '@/components/catalog/CatalogPills.vue';
import en from '@/i18n/locales/en.json';
import fr from '@/i18n/locales/fr.json';
import { ACTION_CAUSE_CODES } from '@/lib/action-required';
import { rowAction } from '@/lib/catalog-actions';
import { activePill, catalogHealth, countByStatus, countChanges, pillCounts } from '@/lib/catalog-health';
import { API_STATUSES, type ApiStatus } from '@/lib/status';
import { apiDetail, apiSummary, controls, oneApiPerStatus, renderHtml, TUNNEL_WORDING, textOf, UUID } from '@/testing/console-fixtures';

/** 7 API : 5 saines, 1 à surveiller, 1 bloquée (le cas de 20b § 3.3). */
function sevenApis() {
  const statuses: ApiStatus[] = ['sain', 'sain', 'sain', 'sain', 'sain', 'warning', 'bloquee'];
  return statuses.map((status, index) => apiSummary({ id: UUID(index + 1), slug: `zz-api-${index + 1}`, status }));
}

describe('assert_catalog_health_excludes_blocked : la barre de santé laisse les arrêts volontaires hors du dénominateur', () => {
  test('logique : 7 API dont 5 sain, 1 warning et 1 bloquee ; 6 en service, 5 saines, 1 arrêt', () => {
    const health = catalogHealth(countByStatus(sevenApis()));
    expect(health).toMatchObject({ total: 7, inService: 6, healthy: 5, stopped: 1 });
    expect(health.segments.map((segment) => segment.status)).not.toContain('bloquee');
    expect(health.segments.reduce((sum, segment) => sum + segment.count, 0)).toBe(6);
  });

  test('« à surveiller » n’est pas « saine » : une API warning est au dénominateur mais pas au numérateur', () => {
    const health = catalogHealth(countByStatus([apiSummary({ status: 'warning' })]));
    expect(health).toMatchObject({ inService: 1, healthy: 0 });
  });

  test.each([
    ['fr', '5 sur 6 saines', '1 arrêt volontaire', fr] as const,
    ['en', '5 of 6 healthy', '1 intentional stop', en] as const,
  ])('%s : « %s · %s », légende en texte, arrêt à part et hors de la barre', async (locale, ratio, stopped, messages) => {
    const html = await renderHtml(CatalogHealth, { health: catalogHealth(countByStatus(sevenApis())) }, locale);
    const line = /data-testid="health-line"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
    expect(textOf(line)).toBe(`${ratio} · ${stopped}`);
    // La barre est décorative (aria-hidden) : le sens est dans la légende en texte, qui ne compte jamais les arrêts.
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*data-testid="health-bar"/);
    const bar = /<svg[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
    expect(bar).not.toContain('bloquee');
    expect(bar).not.toContain('status-bloquee');
    const legend = /data-testid="health-legend"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
    expect(textOf(legend)).toContain(locale === 'fr' ? '5 saines' : '5 healthy');
    expect(textOf(legend)).toContain(locale === 'fr' ? '1 à surveiller' : '1 to watch');
    expect(legend).not.toContain('data-status="bloquee"');
    expect(html).toContain('data-testid="health-stopped-mark"');
    expect(html).toContain(messages.catalog.health.legendLabel);
  });

  test('sans API bloquée : ni compte d’arrêts ni repère à part ; sans API en service : phrase dédiée, pas « 0 sur 0 »', async () => {
    const calm = await renderHtml(CatalogHealth, { health: catalogHealth(countByStatus([apiSummary(), apiSummary({ id: UUID(2), slug: 'zz-2' })])) }, 'fr');
    expect(textOf(calm)).toContain('2 sur 2 saines');
    expect(calm).not.toContain('health-stopped');
    const onlyStopped = await renderHtml(CatalogHealth, { health: catalogHealth(countByStatus([apiSummary({ status: 'bloquee' })])) }, 'fr');
    expect(textOf(onlyStopped)).toContain(fr.catalog.health.noneInService);
    expect(textOf(onlyStopped)).not.toMatch(/0 sur 0/);
  });
});

describe('assert_attention_filters_counts : pastilles-filtres, compteurs en texte et variations annoncées', () => {
  const counts = countByStatus([...sevenApis(), apiSummary({ id: UUID(20), slug: 'zz-erreur', status: 'erreur' }), apiSummary({ id: UUID(21), slug: 'zz-action', status: 'action_requise' })]);

  test('« À traiter » regroupe warning, erreur et action requise ; Tout les compte toutes ; Saines et Arrêts sont des statuts', () => {
    expect(pillCounts(counts)).toEqual({ all: 9, attention: 3, healthy: 5, stopped: 1 });
  });

  test('la pastille active suit le filtre ; un statut précis (« En réparation ») n’en allume aucune', () => {
    expect(activePill({ status: '', attention: true })).toBe('attention');
    expect(activePill({ status: '', attention: false })).toBe('all');
    expect(activePill({ status: 'sain', attention: false })).toBe('healthy');
    expect(activePill({ status: 'bloquee', attention: false })).toBe('stopped');
    expect(activePill({ status: 'reparation', attention: false })).toBeNull();
  });

  test('seule la variation d’un compteur est annoncée ; première lecture et lecture identique : rien', () => {
    const before = pillCounts(counts);
    expect(countChanges(null, before)).toEqual([]);
    expect(countChanges(before, before)).toEqual([]);
    const after = pillCounts(countByStatus([...sevenApis(), apiSummary({ id: UUID(20), slug: 'zz-erreur', status: 'erreur' })]));
    expect(countChanges(before, after)).toEqual([
      { pill: 'all', count: 8 },
      { pill: 'attention', count: 2 },
    ]);
  });

  test.each(['fr', 'en'] as const)('%s : quatre boutons à bascule avec leur compteur en texte, la pastille active est pressée', async (locale) => {
    const html = await renderHtml(CatalogPills, { counts: pillCounts(counts), active: 'attention' }, locale);
    const messages = locale === 'fr' ? fr : en;
    const buttons = controls(html).filter((control) => control.tag === 'button');
    expect(buttons.map((button) => button.text)).toEqual([
      `${messages.catalog.pills.all} · 9`,
      `${messages.catalog.pills.attention} · 3`,
      `${messages.catalog.pills.healthy} · 5`,
      `${messages.catalog.pills.stopped} · 1`,
    ]);
    expect(html).toContain('role="group"');
    expect(buttons.map((button) => /aria-pressed="(true|false)"/.exec(button.attrs)?.[1])).toEqual(['false', 'true', 'false', 'false']);
    // Cible tactile d'au moins 44 px (min-h-11).
    for (const button of buttons) expect(button.attrs).toContain('min-h-11');
  });

  test('les libellés de pastille sont ceux de 20 § 5.2 en français', () => {
    expect([fr.catalog.pills.all, fr.catalog.pills.attention, fr.catalog.pills.healthy, fr.catalog.pills.stopped]).toEqual(['Tout', 'À traiter', 'Saines', 'Arrêtées']);
  });
});

describe('assert_row_action_by_status : une action utile par ligne, aucune relance ni tunnel après un blocage', () => {
  /** Cellule « action » d'une ligne du tableau. */
  const actionCell = (html: string, slug: string): string => {
    const start = html.indexOf(`data-slug="${slug}"`);
    const end = html.indexOf('</tr>', start);
    return /data-testid="row-action-cell">([\s\S]*)$/.exec(html.slice(start, end))?.[1] ?? '';
  };

  test.each(['fr', 'en'] as const)('%s : bloquee n’offre que « Voir les alternatives » (ancre du panneau), action_requise le verbe du bandeau, les autres rien', async (locale) => {
    const messages = locale === 'fr' ? fr : en;
    const html = await renderHtml(ApiCatalogTable, { apis: oneApiPerStatus() }, locale);
    for (const status of API_STATUSES) {
      const cell = actionCell(html, `zz-${status.replace('_', '-')}`);
      const actions = controls(cell);
      if (status === 'bloquee') {
        expect(actions.map((action) => action.text)).toEqual([messages.catalog.rowAction.alternatives]);
        expect(actions[0]?.attrs).toContain('href="/apis/zz-bloquee#blocked-panel"');
        expect(actions[0]?.text).not.toMatch(TUNNEL_WORDING);
        expect(textOf(cell)).not.toMatch(/relanc|réessay|retry|try again|re-?investigate|ré-enquêter/i);
      } else if (status === 'action_requise') {
        // Même verbe que le bandeau de la fiche (cause `connect` pour cookie_expired) et même destination.
        expect(actions.map((action) => action.text)).toEqual([messages.actionRequired.connect.button]);
        expect(actions[0]?.attrs).toContain('href="/settings/extension"');
      } else {
        expect(actions, status).toEqual([]);
        expect(textOf(cell), status).toBe('');
      }
    }
  });

  test('logique : une cause sans écran de la console mène à la fiche ; jamais de relance', () => {
    expect(rowAction({ slug: 'zz-a', status: 'sain' })).toBeNull();
    expect(rowAction({ slug: 'zz-a', status: 'erreur' })).toBeNull();
    expect(rowAction({ slug: 'zz-a', status: 'bloquee' })).toMatchObject({ kind: 'alternatives', labelKey: 'catalog.rowAction.alternatives' });
    expect(rowAction({ slug: 'zz-a', status: 'action_requise', status_reason: { code: 'account_limit' } })).toMatchObject({ labelKey: 'catalog.rowAction.openTask', to: '/apis/zz-a' });
    expect(rowAction({ slug: 'zz-a', status: 'action_requise', status_reason: { code: 'proxy_not_configured' } })).toMatchObject({ labelKey: 'actionRequired.proxy.button', to: '/settings/proxies' });
    // Une API bloquée ne propose jamais autre chose que ses alternatives, quelle que soit sa raison.
    expect(rowAction({ slug: 'zz-a', status: 'bloquee', status_reason: { code: 'tunnel_offline' } })?.kind).toBe('alternatives');
  });

  test.each(ACTION_CAUSE_CODES.flatMap((code) => [[code, 'zz-editeur.example'] as const, [code, null] as const]))(
    'assert_row_action_by_status : cause %s (domaine %s) : la ligne reprend le bouton du bandeau de la fiche, même libellé, même destination',
    async (code, domain) => {
      const reason: { code: string; params: Record<string, string> } = { code, params: domain ? { domain } : {} };
      for (const locale of ['fr', 'en'] as const) {
        const banner = await renderHtml(ActionRequiredBanner, { detail: apiDetail({ slug: 'zz-a', status: 'action_requise', status_reason: reason }), resuming: false }, locale);
        const primary = /<a\b[^>]*data-testid="action-primary"[^>]*>[\s\S]*?<\/a>/.exec(banner)?.[0] ?? null;
        const table = await renderHtml(ApiCatalogTable, { apis: [apiSummary({ slug: 'zz-a', status: 'action_requise', status_reason: reason })] }, locale);
        const row = controls(actionCell(table, 'zz-a'));
        expect(row, `${code}/${locale}`).toHaveLength(1);
        if (primary !== null) {
          const [bannerButton] = controls(primary);
          expect(row[0]?.text, `${code}/${locale}`).toBe(bannerButton?.text);
          expect(/href="([^"]*)"/.exec(row[0]?.attrs ?? '')?.[1], `${code}/${locale}`).toBe(/href="([^"]*)"/.exec(bannerButton?.attrs ?? '')?.[1]?.replace(/^#/, '/apis/zz-a#'));
        } else {
          // Le bandeau n'a aucun bouton (limite de compte, paiement sans site connu) : la ligne mène à la fiche, qui dit la tâche.
          expect(row[0]?.text, `${code}/${locale}`).toBe((locale === 'fr' ? fr : en).catalog.rowAction.openTask);
          expect(row[0]?.attrs, `${code}/${locale}`).toContain('href="/apis/zz-a"');
        }
      }
    },
  );

  test('une ligne dont l’utilisateur vient d’agir dit « Reprise de l’enquête… » à la place du bouton', async () => {
    const apis = oneApiPerStatus().filter((api) => api.status === 'enquete');
    const html = await renderHtml(ApiCatalogTable, { apis, resuming: new Set(['zz-enquete']) }, 'fr');
    expect(textOf(actionCell(html, 'zz-enquete'))).toBe(fr.actionRequired.resuming);
  });
});
