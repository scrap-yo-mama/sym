// SPDX-License-Identifier: AGPL-3.0-only
// Fiche d'une API (06 § 2, critères de 06 § 4.3) : panneau « Bloquée » sans lien vers le tunnel, aucun réglage pour ignorer
// robots.txt, coût estimé avant le bouton Lancer, diff à trois niveaux. Rendu côté serveur sous Node.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import ApiDetailPage from '@/components/api/ApiDetailPage.vue';
import ApiAccessTab from '@/components/api/tabs/ApiAccessTab.vue';
import BlockedPanel from '@/components/api/BlockedPanel.vue';
import LaunchForm from '@/components/api/LaunchForm.vue';
import RevertConfirm from '@/components/api/RevertConfirm.vue';
import StrategyDiffView from '@/components/api/StrategyDiffView.vue';
import { setApi } from '@/lib/api';
import { API_TABS } from '@/lib/api-tabs';
import en from '@/i18n/locales/en.json';
import fr from '@/i18n/locales/fr.json';
import { apiDetail, renderHtml, textOf, UUID } from '@/testing/console-fixtures';

afterEach(() => setApi(undefined));

const blockedDetail = (overrides: Parameters<typeof apiDetail>[0] = {}) =>
  apiDetail({
    status: 'bloquee',
    status_reason: { code: 'blocked_by_protection', params: { domain: 'monsite.example', at: '2026-09-30T10:00:00.000Z', attempt: 3, execution: 'fetch_in_page', network: 'direct', kind: 'challenge', cost_usd: 0.04, run_id: UUID(9) } },
    ...overrides,
  });

/** Boutons et liens d'un fragment HTML : attributs et texte. */
type Control = { tag: 'a' | 'button'; attrs: string; text: string };
function controls(html: string): Control[] {
  return [...html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((match) => ({ tag: match[1] as 'a' | 'button', attrs: match[2] ?? '', text: textOf(match[3] ?? '') }));
}

/** Formulations du tunnel, neutres comprises (_exclusions A7) : jamais dans un bouton ou un lien d'une API bloquée. */
const TUNNEL_WORDING = /tunnel|extension|proxy|settings|navigateur|browser|ma session|mon IP|my session|my IP|network=/i;

/** Fragment HTML du panneau « Bloquée » d'une page. */
function blockedPanelOf(html: string): string {
  const start = html.indexOf('data-testid="blocked-panel"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

/**
 * Liste blanche des commandes du panneau « Bloquée » (06 § 2, A7) : Ré-enquêter, Voir les essais (/runs/:id), Copier le
 * modèle de demande, le lien vers l'API officielle et « Pourquoi cet arrêt ? » (/responsible-use). Toute autre commande,
 * même formulée sans le mot « tunnel », fait échouer le test.
 */
function expectOnlyAllowedBlockedControls(panel: string, messages: typeof fr): void {
  const allowed = [
    (c: Control) => c.tag === 'button' && c.text === messages.actions.reinvestigate && /data-testid="reinvestigate"/.test(c.attrs),
    (c: Control) => c.tag === 'button' && c.text === messages.blockedPanel.request.copy && /data-testid="copy-request"/.test(c.attrs),
    (c: Control) => c.tag === 'a' && c.text === messages.blockedPanel.seeAttempts && /\shref="\/runs\/[0-9a-f-]+"/.test(c.attrs),
    (c: Control) => c.tag === 'a' && c.text === messages.blockedPanel.todo.officialLink && /data-testid="official-api-link"/.test(c.attrs) && /\shref="https:\/\/api\.monsite\.example\/docs"/.test(c.attrs),
    (c: Control) => c.tag === 'a' && c.text === messages.blockedPanel.whyStop && /\shref="\/responsible-use"/.test(c.attrs),
  ];
  for (const control of controls(panel)) {
    expect(allowed.some((rule) => rule(control)), `commande hors liste blanche : <${control.tag}${control.attrs}>${control.text}`).toBe(true);
    expect(`${control.attrs} ${control.text}`, control.text).not.toMatch(TUNNEL_WORDING);
  }
  // Aucune autre forme de commande : ni champ, ni élément rendu cliquable par un rôle.
  expect(panel).not.toMatch(/<select|<input|<textarea|role="(?:button|link|menuitem)"|onclick/);
}

describe('panneau « Bloquée »', () => {
  for (const locale of ['fr', 'en'] as const) {
    test(`assert_blocked_panel_no_tunnel_link : trois parties, essai déclencheur, coût, 0 bouton ou lien vers le tunnel (${locale})`, async () => {
      const messages = locale === 'fr' ? fr : en;
      const report = { id: UUID(5), checked_at: '2026-09-30T10:00:00.000Z', signal: 'review' as const, robots: { status: 'allowed' as const }, official_api_url: 'https://api.monsite.example/docs' };
      const html = await renderHtml(BlockedPanel, { detail: blockedDetail({ access_report: report }) }, locale);
      for (const part of ['blocked-what', 'blocked-why', 'blocked-todo']) expect(html).toContain(`data-testid="${part}"`);
      const text = textOf(html);
      expect(text).toContain('monsite.example');
      expect(text).toContain(messages.blockedPanel.what.title);
      expect(text).toContain(messages.blockedPanel.why.title);
      expect(text).toContain(messages.blockedPanel.todo.title);
      expect(text).toContain(messages.execution.fetch_in_page);
      expect(text).toContain(messages.blockedPanel.answer.challenge);
      expect(html).toContain('data-testid="blocked-cost"');
      // Les quatre pistes de « Ce que tu peux faire » : API officielle, autre source, contact éditeur, ré-enquête plus tard.
      expect(html.match(/<li>/g)).toHaveLength(4);
      // Liste blanche : toute commande qui n'est pas l'une des cinq prévues échoue, quelle que soit sa formulation.
      expectOnlyAllowedBlockedControls(html, messages);
      expect(html).toContain('data-testid="official-api-link"');
      // Seuls boutons : Ré-enquêter et la copie du modèle de demande. Aucun bouton de relance, aucun réglage réseau.
      const buttons = controls(html).filter((control) => control.tag === 'button').map((control) => control.text);
      expect(buttons).toEqual([messages.actions.reinvestigate, messages.blockedPanel.request.copy]);
      expect(html).not.toMatch(/<select|<input|<textarea/);
    });
  }

  test('assert_blocked_panel_no_tunnel_link : « Pourquoi cet arrêt ? » n’existe que si la page « Usage responsable » existe dans la console', async () => {
    // Sans la route (tâche 4.8 pas encore fusionnée), aucun lien vers une page 404.
    const without = await renderHtml(BlockedPanel, { detail: blockedDetail() });
    expect(without).not.toContain('/responsible-use');
    expect(textOf(without)).not.toContain(fr.blockedPanel.whyStop);
    const withRoute = await renderHtml(BlockedPanel, { detail: blockedDetail() }, 'fr', { routes: [{ path: '/responsible-use', name: 'responsible-use', component: { render: () => null } }] });
    expect(withRoute).toContain('href="/responsible-use"');
    expectOnlyAllowedBlockedControls(withRoute, fr);
  });

  test('variantes robots_disallowed et forbidden : textes du CDC, l’API officielle est un lien sûr', async () => {
    const robots = await renderHtml(BlockedPanel, { detail: blockedDetail({ status_reason: { code: 'robots_disallowed', params: { domain: 'monsite.example' } }, access_report: { id: UUID(5), checked_at: '2026-09-30T10:00:00.000Z', signal: 'disallowed', robots: { status: 'disallowed' }, official_api_url: 'https://api.monsite.example/docs' } }) });
    expect(textOf(robots)).toContain(fr.blockedPanel.what.robots);
    expect(robots).toContain('href="https://api.monsite.example/docs"');
    const forbidden = await renderHtml(BlockedPanel, { detail: blockedDetail({ status_reason: { code: 'forbidden', params: {} } }) });
    expect(textOf(forbidden)).toContain(fr.blockedPanel.what.forbidden);
    // Une valeur du serveur qui n'est pas un lien http(s) ne devient jamais un lien (javascript:, data:).
    const hostile = await renderHtml(BlockedPanel, { detail: blockedDetail({ access_report: { id: UUID(5), checked_at: '2026-09-30T10:00:00.000Z', signal: 'review', robots: { status: 'allowed' }, official_api_url: 'javascript:alert(1)' } }) });
    expect(hostile).not.toContain('javascript:');
  });

  test('toute la fiche d’une API bloquée : aucun bouton Lancer ni Relancer, aucun lien vers le tunnel, sur chaque onglet', async () => {
    setApi(undefined);
    for (const tab of API_TABS) {
      const html = await renderHtml(ApiDetailPage, { detail: blockedDetail({ requires: { session_domain: null, tunnel: false } }), slug: 'zz-blocked', tab, resuming: false });
      expect(html, tab).toContain('data-testid="blocked-panel"');
      expectOnlyAllowedBlockedControls(blockedPanelOf(html), fr);
      for (const control of controls(html)) {
        expect(`${control.attrs} ${control.text}`, `${tab} : ${control.text}`).not.toMatch(TUNNEL_WORDING);
        expect(control.text, tab).not.toMatch(new RegExp(`^(?:${fr.actions.launch}|${fr.actions.relaunch})\\b`, 'i'));
      }
      expect(html, tab).not.toContain('data-testid="launch-form"');
      expect(html, tab).not.toContain('header-reinvestigate');
    }
  });
});

describe('onglet Accès', () => {
  const report = { id: UUID(5), checked_at: '2026-09-30T10:00:00.000Z', signal: 'disallowed' as const, robots: { status: 'disallowed' as const, fetched_at: '2026-09-30T09:59:00.000Z', rule: 'Disallow: /private/' }, usage_signals: [{ kind: 'Content-Signal', value: 'ai-train=no' }], llms_txt: true, payment_offer: null, official_api_url: 'https://api.monsite.example/docs' };

  test('assert_no_robots_override_ui : lecture seule, aucun champ ni bouton, robots.txt toujours respecté', async () => {
    const html = await renderHtml(ApiAccessTab, { detail: blockedDetail({ access_report: report }) });
    expect(html).not.toMatch(/<input|<select|<textarea|<button|type="checkbox"|role="switch"|role="checkbox"/);
    const text = textOf(html);
    expect(text).toContain('Disallow: /private/');
    expect(text).toContain('Content-Signal');
    expect(text).toContain(fr.accessTab.robotsAlways);
    expect(html).toContain('data-testid="access-policy-robots">respect<');
    // « Utiliser l'API officielle » est un lien, pas une action ; il n'existe que si l'API officielle existe.
    expect(html).toContain('data-testid="use-official-api"');
    const none = await renderHtml(ApiAccessTab, { detail: blockedDetail({ access_report: { ...report, official_api_url: null } }) });
    expect(none).not.toContain('use-official-api');
    expect(textOf(await renderHtml(ApiAccessTab, { detail: apiDetail({ access_report: null }) }))).toContain(fr.accessTab.noReport);
  });

  test('assert_no_robots_override_ui : aucune option pour ignorer robots.txt dans le code de la console (fiche, réglages, requêtes)', () => {
    const webSrc = new URL('../../', import.meta.url).pathname;
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return files(full);
        return /\.(vue|ts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
      });
    const forbidden = /ignore[_ -]?robots|robots[_ -]?(?:override|ignore|bypass|off|disabled?|opt[_ -]?out)|skip[_ -]?robots|(?:override|bypass|disable|ignore)[_ -]?robots|obey[_ -]?robots/i;
    for (const file of files(webSrc)) {
      // Les fichiers de langue peuvent dire que robots.txt est « toujours respecté, aucun réglage ne permet de l'ignorer » : ce sont des textes, pas des options.
      if (file.endsWith('.json')) continue;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(forbidden);
    }
    // Aucune requête de la console n'envoie access_policy (INV11 : non modifiable).
    for (const file of files(webSrc)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/access_policy\s*:/);
  });
});

describe('formulaire Lancer', () => {
  const schema = { type: 'object', required: ['max_pages'], properties: { max_pages: { type: 'integer' }, category: { type: 'string', enum: ['all', 'fiction'] }, tags: { type: 'array', items: { type: 'string' } }, dry: { type: 'boolean' } } };

  test('assert_cost_estimate_before_run : le coût estimé, préfixé de « ~ », précède le bouton Lancer (fr et en)', async () => {
    for (const locale of ['fr', 'en'] as const) {
      const html = await renderHtml(LaunchForm, { schema, estimate: { median_usd: 0.002, sample_size: 10 } }, locale);
      const estimate = html.indexOf('data-testid="cost-estimate"');
      const button = html.indexOf('data-testid="launch-submit"');
      expect(estimate).toBeGreaterThan(-1);
      expect(button).toBeGreaterThan(estimate);
      const text = textOf(html.slice(estimate, button));
      expect(text).toContain(locale === 'fr' ? '~0,002 $' : '~0.002 $');
      expect(text).toContain(locale === 'fr' ? 'médiane de 10 runs' : 'median of 10 runs');
    }
  });

  test('sans historique, le coût est « non estimé » et précède toujours le bouton', async () => {
    const html = await renderHtml(ApiDetailPage, { detail: apiDetail({ cost_estimate: { median_usd: null, sample_size: 0 } }), slug: 'zz-books', tab: 'overview', resuming: false });
    const estimate = html.indexOf('data-testid="cost-estimate"');
    expect(textOf(html.slice(estimate, html.indexOf('data-testid="launch-submit"')))).toContain(fr.launch.estimate.unknown);
    const single = await renderHtml(LaunchForm, { schema, estimate: { median_usd: 0.5, sample_size: 1 } });
    expect(textOf(single)).toContain('médiane de 1 run');
    expect(textOf(single)).not.toContain('médiane de 1 runs');
  });

  test('un champ par type du schéma : entier, énumération, tableau, booléen ; la saisie JSON seulement pour les autres types', async () => {
    const html = await renderHtml(LaunchForm, { schema, estimate: undefined });
    expect(html).toContain('type="number"');
    expect(html).toContain('<select');
    expect(html).toContain('value="fiction"');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('launch-json');
    const json = await renderHtml(LaunchForm, { schema: { type: 'object', properties: { filter: { type: 'object' } } }, estimate: undefined });
    expect(json).toContain('id="launch-json"');
  });

  test('mode Relancer : champs pré-remplis, choix de la version, avertissement sur les effets de bord', async () => {
    const html = await renderHtml(LaunchForm, { schema, estimate: undefined, initialInput: { max_pages: 4, category: 'fiction' }, versions: [{ version: 3, current: true }, { version: 2, current: false }] });
    expect(html).toContain('value="4"');
    expect(html).toContain('data-testid="side-effects-warning"');
    expect(html).toContain('id="launch-version"');
    expect(textOf(html)).toContain(fr.launch.versionOther.replace('{v}', '2'));
  });
});

describe('diff à trois niveaux', () => {
  const diff = {
    from: 3,
    to: 2,
    summary: { code: 'selector_changed', params: { field: 'price' } },
    fields: [
      { path: 'extract.price.selector', change: 'changed' as const, before: '.price', after: '.price-box > span' },
      { path: 'extract.rating', change: 'added' as const, after: '.stars' },
    ],
    raw: { before: { extract: { price: { selector: '.price' } } }, after: { extract: { price: { selector: '.price-box > span' }, rating: '.stars' } } },
  };

  test('assert_diff_three_levels : phrase, tableau des champs modifiés et diff brut côte à côte', async () => {
    const html = await renderHtml(StrategyDiffView, { diff });
    const summary = textOf(/data-testid="diff-summary"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '');
    expect(summary).toContain('Le sélecteur de price a changé.');
    const fields = /data-testid="diff-fields"[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    expect(fields).toContain('extract.price.selector');
    expect(fields).toContain('extract.rating');
    expect(textOf(fields)).toContain(fr.diff.change.added);
    const raw = /data-testid="diff-raw"[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    expect(raw).toContain('data-kind="changed"');
    expect(raw).toContain('data-kind="added"');
    expect(textOf(raw)).toContain('.price-box');
    // Deux colonnes (version de départ et d'arrivée), un changement jamais porté par la couleur seule : glyphe + texte pour lecteur d'écran.
    expect(raw.match(/<th scope="col"/g)).toHaveLength(2);
    expect(raw).toContain('−');
    expect(raw).toContain('+');
    expect(raw).toContain('sr-only');
  });

  test('assert_revert_shows_preview : « Revenir à cette version » montre l’aperçu (diff à trois niveaux) et la conséquence avant confirmation', async () => {
    const html = await renderHtml(RevertConfirm, { version: 2, current: 3, diff, diffLoading: false, diffError: null, pending: false });
    const text = textOf(html);
    expect(text).toContain(fr.strategy.revertConfirm.title.replace('{v}', '2'));
    expect(text).toContain(fr.strategy.revertConfirm.consequence.replace(/\{v\}/g, '2'));
    expect(text).toContain(fr.strategy.revertConfirm.preview.replace('{from}', '3').replace('{to}', '2'));
    // L'aperçu précède le bouton de confirmation : on voit ce qui change avant de confirmer.
    const preview = html.indexOf('data-testid="diff-summary"');
    expect(preview).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="diff-fields"')).toBeGreaterThan(preview);
    expect(html.indexOf('data-testid="diff-raw"')).toBeGreaterThan(preview);
    expect(html.indexOf('data-testid="confirm-yes"')).toBeGreaterThan(html.indexOf('data-testid="diff-raw"'));
    // Titres imbriqués sous celui du panneau (h4) : le diff de l'aperçu commence au niveau 5.
    expect(html).not.toMatch(/<h[1-3][\s>]/);
    expect(html).toMatch(/<h5[\s>]/);
    // Chargement, erreur et absence de version courante : la conséquence reste lisible.
    expect(await renderHtml(RevertConfirm, { version: 2, current: 3, diff: null, diffLoading: true, diffError: null, pending: false })).toContain('data-testid="revert-preview-loading"');
    const failed = await renderHtml(RevertConfirm, { version: 2, current: 3, diff: null, diffLoading: false, diffError: { status: 500, code: null, message: 'x' }, pending: false });
    expect(textOf(failed)).toContain(fr.strategy.revertConfirm.previewUnavailable);
    expect(textOf(failed)).toContain(fr.strategy.revertConfirm.consequence.replace(/\{v\}/g, '2'));
    expect(await renderHtml(RevertConfirm, { version: 2, current: null, diff: null, diffLoading: false, diffError: null, pending: false })).not.toContain('diff-summary');
  });

  test('un code de phrase inconnu retombe sur la phrase générique avec le nombre de champs, jamais sur le code brut', async () => {
    const html = await renderHtml(StrategyDiffView, { diff: { ...diff, summary: { code: 'nouveau_code', params: {} } } });
    expect(textOf(html)).toContain(fr.diffSummary.generic.replace('{n}', '2'));
    expect(html).not.toContain('nouveau_code');
  });

  test('les phrases d’exécution et de réseau traduisent les codes (de fetch vers agent)', async () => {
    const html = await renderHtml(StrategyDiffView, { diff: { ...diff, summary: { code: 'execution_changed', params: { from: 'fetch', to: 'agent' } } } });
    expect(textOf(html)).toContain(`${fr.execution.fetch} vers ${fr.execution.agent}`);
  });
});
