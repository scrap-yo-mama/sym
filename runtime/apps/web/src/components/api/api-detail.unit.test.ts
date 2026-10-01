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
function controls(html: string): { tag: 'a' | 'button'; attrs: string; text: string }[] {
  return [...html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((match) => ({ tag: match[1] as 'a' | 'button', attrs: match[2] ?? '', text: textOf(match[3] ?? '') }));
}

describe('panneau « Bloquée »', () => {
  for (const locale of ['fr', 'en'] as const) {
    test(`assert_blocked_panel_no_tunnel_link : trois parties, essai déclencheur, coût, 0 bouton ou lien vers le tunnel (${locale})`, async () => {
      const messages = locale === 'fr' ? fr : en;
      const html = await renderHtml(BlockedPanel, { detail: blockedDetail() }, locale);
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
      for (const control of controls(html)) {
        expect(`${control.attrs} ${control.text}`, control.text).not.toMatch(/tunnel|extension|proxy|settings/i);
      }
      // Seuls boutons : Ré-enquêter et la copie du modèle de demande. Aucun bouton de relance, aucun réglage réseau.
      const buttons = controls(html).filter((control) => control.tag === 'button').map((control) => control.text);
      expect(buttons).toEqual([messages.actions.reinvestigate, messages.blockedPanel.request.copy]);
      expect(html).not.toMatch(/<select|<input|<textarea/);
    });
  }

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
      for (const control of controls(html)) {
        expect(`${control.attrs} ${control.text}`, `${tab} : ${control.text}`).not.toMatch(/tunnel|settings\/extension|settings\/proxies/i);
        expect(control.text, tab).not.toBe(fr.actions.launch);
        expect(control.text, tab).not.toBe(fr.actions.relaunch);
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
