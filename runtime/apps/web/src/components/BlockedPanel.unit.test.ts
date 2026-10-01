// SPDX-License-Identifier: AGPL-3.0-only
// Panneau « Bloquée » (06 § 2, A7, INV6). `assert_blocked_panel_no_tunnel_link` : le panneau a ses trois parties et 0 bouton
// ou lien vers le tunnel, hors « Ré-enquêter », dans les deux langues, pour chaque cause d'arrêt, seul et dans l'écran
// d'enquête. Le tunnel reste un réglage neutre de la politique réseau, jamais proposé après un blocage.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import en from '@/i18n/locales/en.json';
import fr from '@/i18n/locales/fr.json';
import { emptyInvestigation, BLOCK_CAUSES, type AttemptView, type BlockCause } from '@/lib/investigation';
import { esc, view, type Locale } from '@/testing/console.testkit';
import BlockedPanel from './BlockedPanel.vue';
import InvestigationBoard from './investigation/InvestigationBoard.vue';

const attempt: AttemptView = { index: 2, execution: 'playwright', network: 'direct', state: 'done', result: 'blocked_by_protection', costUsd: 0.004, estCostUsd: null, ms: 900, prunedReason: null, why: null, error: null };
const messages = { en, fr } as const;

function props(cause: BlockCause, extra: Record<string, unknown> = {}) {
  return { cause, domain: 'exemple.test', at: '2026-10-01T10:05:00Z', attempt, costUsd: 0.004, ...extra };
}

/** Les éléments interactifs (liens et boutons) du rendu : balise ouvrante et texte visible. */
function controls(html: string): { tag: string; open: string; text: string }[] {
  return [...html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({ tag: m[1] ?? '', open: m[2] ?? '', text: (m[3] ?? '').replace(/<[^>]*>/g, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim() }));
}

/** Le panneau seul, extrait du rendu d'une page (il ne contient aucune section imbriquée). */
function panelOf(html: string): string {
  const start = html.indexOf('data-testid="blocked-panel"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

describe('assert_blocked_panel_no_tunnel_link', () => {
  for (const locale of ['en', 'fr'] as const satisfies readonly Locale[]) {
    for (const cause of BLOCK_CAUSES) {
      test(`${locale}, ${cause} : trois parties, aucun bouton ni lien vers le tunnel, un seul bouton de reprise (Ré-enquêter)`, async () => {
        const html = await view(BlockedPanel, props(cause, { officialApiUrl: 'https://api.exemple.test/doc' }), { locale });
        const text = messages[locale].blocked;

        // Trois parties, plus le titre.
        for (const heading of [text.what.heading, text.why.heading, text.todo.heading]) expect(html).toContain(`>${esc(heading)}</h3>`);
        expect(html).toContain(`>${esc(text.title.replace('{domain}', 'exemple.test'))}</h2>`);

        // Seuls contrôles : copier le modèle, Ré-enquêter, Voir les essais, Pourquoi cet arrêt ?, API officielle.
        const found = controls(html);
        expect(found.map((c) => c.text).sort()).toEqual([text.copyTemplate, text.reinvestigate, text.viewTrials, text.whyLink, text.officialApi].sort());
        for (const control of found) {
          expect(`${control.open} ${control.text}`, control.text).not.toMatch(/tunnel|extension|proxy|r[ée]seau|network|settings|r[ée]glages/i);
        }
        // Un seul bouton de reprise, et il est manuel.
        expect(found.filter((c) => c.text === text.reinvestigate)).toHaveLength(1);
        expect(found.filter((c) => /relanc|retry|rerun|run again|reprendre|resume/i.test(c.text))).toEqual([]);
        // Les liens vont vers la voie officielle et la page « Usage responsable », rien d'autre.
        expect(found.filter((c) => c.tag === 'a').map((c) => /href="([^"]*)"/.exec(c.open)?.[1])).toEqual(expect.arrayContaining(['https://api.exemple.test/doc', '/docs/responsible-use/']));
        expect(found.filter((c) => c.tag === 'a')).toHaveLength(2);
        // Le texte lui-même ne parle pas de tunnel.
        expect(html).not.toMatch(/tunnel/i);
      });
    }
  }

  test('aucune décision de reprise ni réglage réseau dans les sources du panneau (hors commentaires)', () => {
    const source = readFileSync(new URL('./BlockedPanel.vue', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/tunnel/i);
    expect(source).not.toMatch(/RouterLink|router-link|useRouter|\/settings|proxy/i);
    expect(source.match(/<Button\b/g)).toHaveLength(3); // copier le modèle, Ré-enquêter, Voir les essais
  });

  test('dans l’écran d’enquête, le panneau reste sans tunnel, et l’action requise d’un autre type n’y est pas mêlée', async () => {
    const state = emptyInvestigation();
    state.runId = 'r1';
    state.domain = 'exemple.test';
    state.status = 'bloquee';
    state.terminal = true;
    state.phase = 'done';
    state.attempts = [attempt];
    state.blocked = { cause: 'blocked_by_protection', domain: 'exemple.test', at: '2026-10-01T10:05:00Z', attempt, costUsd: 0.004 };
    for (const locale of ['en', 'fr'] as const) {
      const html = await view(InvestigationBoard, { state, elapsedS: 3, paused: false, cancelled: false, busy: null, failure: null }, { locale });
      const panel = panelOf(html);
      expect(panel).not.toMatch(/tunnel/i);
      expect(controls(panel).some((c) => /tunnel|extension|proxy/i.test(`${c.open} ${c.text}`))).toBe(false);
      expect(controls(panel).filter((c) => c.text === messages[locale].blocked.reinvestigate)).toHaveLength(1);
    }
  });
});

describe('panneau « Bloquée » : contenu', () => {
  test('une voie officielle qui n’est pas une URL http(s) n’est jamais posée dans un lien', async () => {
    for (const unsafe of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'pas une url', '//exemple.test']) {
      const html = await view(BlockedPanel, props('forbidden', { officialApiUrl: unsafe }));
      expect(html, unsafe).not.toMatch(/href="(javascript|data):/);
      expect(controls(html).filter((c) => c.tag === 'a')).toHaveLength(1);
    }
  });

  test('protection : l’essai déclencheur, la date, le coût et la décision du site, sans reproche', async () => {
    const html = await view(BlockedPanel, props('blocked_by_protection'));
    expect(html).toContain('Blocked: exemple.test refuses automated access');
    expect(html).toMatch(/On [^<]*2026[^<]*, trial 3 \(“Playwright only”, direct\), exemple\.test answered with a verification page\. No other trial was started\. Investigation cost: \$0\.004\./);
    expect(html).toContain('This is the decision of the site. Scrapyomama does not answer in place of a person and does not change IP address after a refusal.');
    expect(html).toContain('data-testid="blocked-reinvestigate"');
  });

  test('forbidden : « l’adresse IP ne change pas après un refus », vérifie tes droits ou contacte l’éditeur', async () => {
    const html = await view(BlockedPanel, props('forbidden'), { locale: 'fr' });
    expect(html).toContain('a répondu par un refus d&#39;accès');
    expect(html).toContain(esc(fr.blocked.why.forbidden));
    expect(html).toContain('L&#39;adresse IP ne change pas après un refus.');
  });

  test('robots_disallowed : règle respectée, API officielle et contact, aucune relance « plus tard »', async () => {
    const html = await view(BlockedPanel, props('robots_disallowed', { attempt: null }));
    expect(html).toContain('asks robots not to visit this page');
    expect(html).toContain('Scrapyomama respects this rule.');
    expect(html).toContain(en.blocked.todo.official);
    expect(html).toContain(en.blocked.todo.contact);
    expect(html).not.toContain(en.blocked.todo.later);
    expect(html).not.toContain(en.blocked.todo.other);
  });

  test('sans essai connu ni domaine : le panneau reste lisible', async () => {
    const html = await view(BlockedPanel, { cause: 'blocked_by_protection', domain: null });
    expect(html).toContain('Blocked: this site refuses automated access');
    expect(html).toContain('Investigation cost: not available.');
  });

  test('le modèle de demande d’accès est copiable, le lien « Pourquoi cet arrêt ? » mène à « Usage responsable »', async () => {
    const html = await view(BlockedPanel, props('blocked_by_protection'));
    expect(html).toContain('data-testid="blocked-copy-template"');
    expect(html).toMatch(/href="\/docs\/responsible-use\/"[^>]*data-testid="blocked-why-link"|data-testid="blocked-why-link"[^>]*href="\/docs\/responsible-use\/"|href="\/docs\/responsible-use\/"/);
  });
});
