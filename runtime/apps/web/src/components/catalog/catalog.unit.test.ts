// SPDX-License-Identifier: AGPL-3.0-only
// Catalogue (06 § 2, critères de 06 § 4.3) : raison lisible sans survol ni focus, statut jamais porté par la couleur seule,
// `stale` comme drapeau et non comme statut. Rendu côté serveur sous Node (aucun navigateur, aucun survol possible).
import { describe, expect, test } from 'vitest';
import ApiCatalogTable from '@/components/catalog/ApiCatalogTable.vue';
import StatusBadge from '@/components/catalog/StatusBadge.vue';
import en from '@/i18n/locales/en.json';
import fr from '@/i18n/locales/fr.json';
import { API_STATUSES, showsStaleFlag, STATUS_ICON, type ApiStatus } from '@/lib/status';
import { apiSummary, oneApiPerStatus, renderHtml, textOf } from '@/testing/console-fixtures';

/** Fragment HTML de la ligne du catalogue d'une API. */
function rowOf(html: string, slug: string): string {
  const start = html.indexOf(`data-slug="${slug}"`);
  expect(start, slug).toBeGreaterThan(-1);
  const end = html.indexOf('</tr>', start);
  return html.slice(start, end);
}

const EXPECTED_REASON: Record<'fr' | 'en', Record<ApiStatus, string>> = {
  fr: {
    enquete: 'Essai 3 sur ~6 : Fetch dans le navigateur',
    sain: '3 runs propres, dernier le',
    warning: fr.reasons.escalated,
    reparation: 'Extraction cassée ; réparation 1 sur 3 en cours.',
    erreur: 'Budget de réparation épuisé ; version v4 conservée.',
    action_requise: 'La session de monsite.example a expiré.',
    bloquee: fr.reasons.blocked_by_protection,
  },
  en: {
    enquete: 'Attempt 3 of ~6: Fetch in the browser',
    sain: '3 clean runs, latest on',
    warning: en.reasons.escalated,
    reparation: 'Extraction broken; repair 1 of 3 in progress.',
    erreur: 'Repair budget exhausted; version v4 kept.',
    action_requise: 'The session on monsite.example has expired.',
    bloquee: en.reasons.blocked_by_protection,
  },
};

describe('catalogue : statut et raison', () => {
  for (const locale of ['fr', 'en'] as const) {
    test(`assert_reason_visible_without_hover : 7 API, une par statut, icône + libellé + raison en texte visible (${locale})`, async () => {
      const apis = oneApiPerStatus();
      const html = await renderHtml(ApiCatalogTable, { apis }, locale);
      const labels = locale === 'fr' ? fr.status : en.status;
      for (const api of apis) {
        const row = rowOf(html, api.slug);
        const reasonCell = /<p ([^>]*data-testid="status-reason"[^>]*)>([^<]*)<\/p>/.exec(row);
        // La raison est un paragraphe de texte ordinaire : ni info-bulle, ni région masquée, ni contenu qui n'apparaît qu'au survol.
        expect(reasonCell, api.slug).not.toBeNull();
        expect(textOf(reasonCell?.[2] ?? ""), api.slug).toContain(EXPECTED_REASON[locale][api.status]);
        expect(reasonCell?.[1], api.slug).not.toMatch(/\stitle=|aria-hidden|(?:^|\s)hidden(?:\s|=|$)|sr-only|\bhidden\b(?!-)|display/i);
        expect(row).not.toMatch(/<details|popover|tooltip|onmouseover|onfocus/i);
        expect(row).toContain(`data-icon="${STATUS_ICON[api.status]}"`);
        expect(textOf(row)).toContain(labels[api.status]);
      }
    });
  }

  test('assert_status_not_color_only : 7 statuts, 7 icônes de forme distincte, chacune avec son libellé', async () => {
    expect(new Set(API_STATUSES.map((status) => STATUS_ICON[status])).size).toBe(7);
    const signatures = new Set<string>();
    for (const status of API_STATUSES) {
      const html = await renderHtml(StatusBadge, { status });
      const svg = /<svg[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
      // Le tracé de l'icône (la forme) diffère d'un statut à l'autre ; l'icône est décorative, le libellé porte le sens.
      signatures.add(svg.replace(/<svg[^>]*>/, ''));
      expect(svg).toContain('aria-hidden="true"');
      expect(textOf(html)).toContain(fr.status[status]);
    }
    expect(signatures.size).toBe(7);
  });

  test('un statut sans raison reçue affiche la phrase générique du statut, jamais un code brut', async () => {
    const html = await renderHtml(ApiCatalogTable, { apis: [apiSummary({ status: 'sain', status_reason: null }), apiSummary({ id: '1', slug: 'zz-x', status: 'erreur', status_reason: { code: 'code_inconnu', params: {} } })] });
    expect(textOf(html)).toContain(fr.statusDefault.sain);
    expect(textOf(html)).toContain(fr.statusDefault.erreur);
    expect(html).not.toContain('code_inconnu</p>');
  });
});

describe('catalogue : drapeau stale', () => {
  test('assert_stale_is_flag : la pastille s’ajoute au badge d’une API sain ou warning, sans nouveau statut', async () => {
    expect(API_STATUSES).toHaveLength(7);
    expect(API_STATUSES as readonly string[]).not.toContain('stale');
    const apis = [
      apiSummary({ id: '1', slug: 'zz-fresh', status: 'sain', stale: false }),
      apiSummary({ id: '2', slug: 'zz-old', status: 'sain', stale: true }),
      apiSummary({ id: '3', slug: 'zz-old-warning', status: 'warning', stale: true }),
      apiSummary({ id: '4', slug: 'zz-old-error', status: 'erreur', stale: true }),
    ];
    const html = await renderHtml(ApiCatalogTable, { apis });
    const old = rowOf(html, 'zz-old');
    expect(old).toContain('data-testid="stale-flag"');
    expect(textOf(old)).toContain(fr.status.sain);
    expect(textOf(old)).toContain(fr.status.staleFlag);
    expect(old).toContain('data-status="sain"');
    expect(rowOf(html, 'zz-fresh')).not.toContain('stale-flag');
    expect(rowOf(html, 'zz-old-warning')).toContain('stale-flag');
    // Le drapeau n'a de sens que pour un statut sain ou à surveiller : ailleurs il n'est pas affiché.
    expect(rowOf(html, 'zz-old-error')).not.toContain('stale-flag');
    expect(API_STATUSES.map((status) => showsStaleFlag(status, true))).toEqual([false, true, true, false, false, false, false]);
  });
});

describe('catalogue : colonnes', () => {
  test('badge d’exécution, badge réseau, coût préfixé de « ~ » quand estimé, succès, ordinateur requis, pastille Accès', async () => {
    const apis = [
      apiSummary({ slug: 'zz-a', execution: 'fetch_in_page', network: 'tunnel', requires: { session_domain: 'monsite.example', tunnel: true }, avg_cost_usd: 0.0024, avg_cost_estimated: true, success_rate_30d: 0.5, access_signal: 'review' }),
      apiSummary({ id: '2', slug: 'zz-b', avg_cost_usd: 1.5, avg_cost_estimated: false, access_signal: 'disallowed', last_run_at: null, success_rate_30d: null, execution: null, network: null }),
    ];
    const html = await renderHtml(ApiCatalogTable, { apis });
    const a = textOf(rowOf(html, 'zz-a'));
    expect(a).toContain(fr.execution.fetch_in_page);
    expect(a).toContain(fr.network.tunnel);
    expect(a).toContain(fr.catalog.computerRequired);
    expect(a).toContain('~0,0024 $');
    expect(a).toContain('50 %');
    expect(a).toContain(fr.access.signal.review);
    const b = textOf(rowOf(html, 'zz-b'));
    expect(b).toContain('1,5 $');
    expect(b).not.toContain('~1,5');
    expect(b).toContain(fr.access.signal.disallowed);
    expect(rowOf(html, 'zz-b')).not.toContain('computer-required');
  });

  test('une API est un lien vers sa fiche ; le tableau a une légende et des en-têtes de colonne', async () => {
    const html = await renderHtml(ApiCatalogTable, { apis: [apiSummary({ slug: 'zz-books' })] });
    expect(html).toContain('href="/apis/zz-books"');
    expect(html).toContain('<caption');
    expect(html.match(/<th scope="col"/g)).toHaveLength(8);
  });
});
