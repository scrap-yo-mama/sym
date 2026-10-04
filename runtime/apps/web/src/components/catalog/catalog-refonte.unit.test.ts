// SPDX-License-Identifier: AGPL-3.0-only
// Refonte du Catalogue (3.17, 20 § 5.2, critères de 20b § 3.3) : barre de santé sans les API bloquées, pastilles-filtres avec
// compteurs en texte, une action utile par ligne. Rendu côté serveur sous Node ; le comportement à l'ouverture (« À traiter »
// d'abord) et l'annonce des compteurs sont dans views/catalog-screen.unit.test.ts, le navigateur réel dans e2e/catalog-new-api.e2e.ts.
import { describe, expect, test } from 'vitest';
import { contrast, cssVariables, readText, resolveColor, toHex } from '@runtime/ui/testing/contrast';
import ActionRequiredBanner from '@/components/api/ActionRequiredBanner.vue';
import ApiCatalogTable from '@/components/catalog/ApiCatalogTable.vue';
import CatalogHealth from '@/components/catalog/CatalogHealth.vue';
import CatalogPills from '@/components/catalog/CatalogPills.vue';
import en from '@runtime/i18n/locales/en.json';
import fr from '@runtime/i18n/locales/fr.json';
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

describe('assert_health_bar_enquete_visible : le segment « en enquête » se voit sur la carte, en clair comme en sombre', () => {
  // La surface du statut `enquete` est celle de la carte (papier en clair, anthracite relevé en sombre) : posé tel quel, le
  // segment laissait un trou dans la barre. Il porte donc une surface distincte de la carte et un contour contrasté (1.4.11).
  const mainCss = readText(new URL('../../assets/main.css', import.meta.url));
  const themeCss = readText(new URL('../../../../../packages/ui/src/theme.css', import.meta.url));
  const ROOT = cssVariables(themeCss, ':root');
  const VARIABLES = { light: ROOT, dark: { ...ROOT, ...cssVariables(themeCss, '.dark, .sym-on-ink') } };
  const colorMap = Object.fromEntries([...mainCss.matchAll(/--color-([\w-]+):\s*var\((--[\w-]+)\);/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
  const tokenOf = (classes: string, prefix: 'fill' | 'stroke'): string | undefined => {
    const name = new RegExp(`(?:^|\\s)${prefix}-([a-z-]+)(?:\\s|$)`).exec(classes)?.[1];
    return name === undefined ? undefined : colorMap[name];
  };

  test.each(['light', 'dark'] as const)('%s : surface distincte de la carte et contour d’au moins 3:1 sur la carte', async (theme) => {
    const health = catalogHealth(countByStatus([apiSummary(), apiSummary({ id: UUID(2), slug: 'zz-2', status: 'enquete' })]));
    const html = await renderHtml(CatalogHealth, { health }, 'fr');
    const rect = /<rect[^>]*data-status="enquete"[^>]*>/.exec(html)?.[0] ?? '';
    expect(rect).not.toBe('');
    const classes = /class="([^"]*)"/.exec(rect)?.[1] ?? '';
    const variables = VARIABLES[theme];
    const card = resolveColor(variables, 'var(--card)');
    const fill = tokenOf(classes, 'fill');
    const stroke = tokenOf(classes, 'stroke');
    expect(fill, classes).toBeDefined();
    expect(stroke, classes).toBeDefined();
    expect(toHex(resolveColor(variables, `var(${fill})`))).not.toBe(toHex(card));
    expect(contrast(resolveColor(variables, `var(${stroke})`), card)).toBeGreaterThanOrEqual(3);
    // Le contour garde son épaisseur malgré la barre étirée (viewBox sans proportions).
    expect(rect).toContain('vector-effect="non-scaling-stroke"');
  });
});

describe('assert_catalog_status_colors_match_planche : barre de santé et badges aux couleurs de la planche Catalogue (D-60)', () => {
  // Planche maquette-ux/latest/project/Catalogue.dc.html : segments l. 47-50 (sain #1F8A70, warning #FFC727, réparation
  // #9B6BE0, action requise #3A33F0), badges « Saine » #D7F2EA / #0E5A46, « à surveiller » #FFF0BF / #6B4E00, « répare »
  // #EDE2FB / #4B2490. Le thème sombre n'a pas de planche : bleu jamais sur anthracite, contrastes AA.
  const mainCss = readText(new URL('../../assets/main.css', import.meta.url));
  const themeCss = readText(new URL('../../../../../packages/ui/src/theme.css', import.meta.url));
  const ROOT = cssVariables(themeCss, ':root');
  const VARIABLES = { light: ROOT, dark: { ...ROOT, ...cssVariables(themeCss, '.dark, .sym-on-ink') } };
  const colorMap = Object.fromEntries([...mainCss.matchAll(/--color-([\w-]+):\s*var\((--[\w-]+)\);/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
  const classToken = (classes: string, prefix: 'fill' | 'bg' | 'text'): string => {
    const name = new RegExp(`(?:^|\\s)${prefix}-([a-z-]+)(?:\\s|$)`).exec(classes)?.[1] ?? '';
    return colorMap[name] ?? `(aucun jeton pour ${prefix}-${name})`;
  };
  const hex = (theme: 'light' | 'dark', token: string): string => toHex(resolveColor(VARIABLES[theme], `var(${token})`)).toUpperCase();
  const BAR: Partial<Record<ApiStatus, string>> = { sain: '#1F8A70', warning: '#FFC727', reparation: '#9B6BE0', action_requise: '#3A33F0' };
  const BADGE: Partial<Record<ApiStatus, [string, string]>> = { sain: ['#D7F2EA', '#0E5A46'], warning: ['#FFF0BF', '#6B4E00'], reparation: ['#EDE2FB', '#4B2490'], action_requise: ['#3A33F0', '#FBF8F3'], bloquee: ['#24252D', '#FBF8F3'] };

  async function barClasses(): Promise<Record<string, string>> {
    const html = await renderHtml(CatalogHealth, { health: catalogHealth(countByStatus(oneApiPerStatus())) }, 'fr');
    return Object.fromEntries([...html.matchAll(/<rect[^>]*>/g)].map((m) => [/data-status="([a-z_]+)"/.exec(m[0])?.[1] ?? '', /class="([^"]*)"/.exec(m[0])?.[1] ?? '']));
  }

  test('clair : chaque segment de la barre a la couleur de la planche', async () => {
    const classes = await barClasses();
    for (const [status, expected] of Object.entries(BAR)) expect(hex('light', classToken(classes[status] ?? '', 'fill')), status).toBe(expected);
  });

  test.each(['light', 'dark'] as const)('%s : segments sain, réparation et action requise à 3:1 au moins sur la carte ; jamais de bleu en sombre', async (theme) => {
    const classes = await barClasses();
    const card = resolveColor(VARIABLES[theme], 'var(--card)');
    for (const status of ['sain', 'reparation', 'action_requise']) {
      const fill = classToken(classes[status] ?? '', 'fill');
      expect(contrast(resolveColor(VARIABLES[theme], `var(${fill})`), card), `${theme} ${status}`).toBeGreaterThanOrEqual(3);
      if (theme === 'dark') expect(hex('dark', fill), status).not.toBe('#3A33F0');
    }
  });

  test('clair : badges de statut aux surfaces et textes de la planche', async () => {
    const html = await renderHtml(ApiCatalogTable, { apis: oneApiPerStatus() }, 'fr');
    for (const [status, [surface, text]] of Object.entries(BADGE)) {
      const badge = new RegExp(`<span[^>]*class="([^"]*)"[^>]*data-testid="status-badge" data-status="${status}"`).exec(html)?.[1] ?? '';
      expect(badge, status).not.toBe('');
      expect(hex('light', classToken(badge, 'bg')), `${status} surface`).toBe(surface);
      expect(hex('light', classToken(badge, 'text')), `${status} texte`).toBe(text);
    }
  });

  test.each(['light', 'dark'] as const)('%s : texte des badges à 4,5:1 au moins sur leur surface', async (theme) => {
    const html = await renderHtml(ApiCatalogTable, { apis: oneApiPerStatus() }, 'fr');
    for (const status of API_STATUSES) {
      const badge = new RegExp(`<span[^>]*class="([^"]*)"[^>]*data-testid="status-badge" data-status="${status}"`).exec(html)?.[1] ?? '';
      const ratio = contrast(resolveColor(VARIABLES[theme], `var(${classToken(badge, 'text')})`), resolveColor(VARIABLES[theme], `var(${classToken(badge, 'bg')})`));
      expect(ratio, `${theme} ${status}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
