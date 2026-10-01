// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment vue-client
// Fiche d'une API montée côté client (memory-mount.ts) : les onglets lisent leurs listes au montage (versions, runs,
// transitions, planifications) par un serveur factice. Le rendu serveur d'api-detail.unit.test.ts ne voit que des
// squelettes vides pour ces onglets ; ici, chaque commande qui dépend d'une liste chargée est réellement rendue.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import ApiDetailPage from '@/components/api/ApiDetailPage.vue';
import ApiStrategyTab from '@/components/api/tabs/ApiStrategyTab.vue';
import type { components } from '@runtime/client';
import { setApi } from '@/lib/api';
import { API_TABS } from '@/lib/api-tabs';
import fr from '@/i18n/locales/fr.json';
import { apiDetail, controls, installApi, json, TUNNEL_WORDING, UUID } from '@/testing/console-fixtures';
import { mountHtml, type MountedHtml } from '@/testing/memory-mount';

type Schemas = components['schemas'];

const SLUG = 'zz-blocked';
const mounted: MountedHtml[] = [];

beforeEach(() => {
  // Le replay de l'onglet Enquêtes ouvre son propre flux SSE par `fetch` : aucun événement ici.
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
});

afterEach(() => {
  for (const page of mounted.splice(0)) page.unmount();
  vi.unstubAllGlobals();
  setApi(undefined);
});

async function mount(...args: Parameters<typeof mountHtml>): Promise<string> {
  const page = await mountHtml(...args);
  mounted.push(page);
  return page.html();
}

const version = (n: number, overrides: Partial<Schemas['StrategyVersionSummary']> = {}): Schemas['StrategyVersionSummary'] => ({
  version: n,
  execution: 'fetch',
  network: 'direct',
  est_cost_usd: 0.001,
  created_by: n === 1 ? 'investigation' : 'repair',
  parent_version: n > 1 ? n - 1 : null,
  created_at: `2026-09-2${n}T10:00:00.000Z`,
  validated_samples: 5,
  run_id: UUID(100 + n),
  ...overrides,
});

const run = (n: number, overrides: Partial<Schemas['RunSummary']> = {}): Schemas['RunSummary'] => ({
  id: UUID(200 + n),
  api_id: UUID(1),
  api_slug: SLUG,
  owner_id: UUID(2),
  strategy_version: 3,
  trigger: 'ui',
  state: 'succeeded',
  outcome: 'clean',
  degraded_reasons: [],
  failure_class: null,
  created_at: '2026-09-30T09:00:00.000Z',
  started_at: '2026-09-30T09:00:01.000Z',
  finished_at: '2026-09-30T09:00:03.000Z',
  duration_ms: 2000,
  cost: { llm_usd: 0, proxy_usd: 0, total_usd: 0.002, estimated: false },
  items: 20,
  dataset_id: UUID(300 + n),
  retention_until: '2026-10-30T09:00:00.000Z',
  ...overrides,
});

const schedule = (n: number, overrides: Partial<Schemas['Schedule']> = {}): Schemas['Schedule'] => ({
  id: UUID(400 + n),
  api_slug: SLUG,
  cron: '0 8 * * *',
  timezone: 'Europe/Paris',
  input: {},
  overlap: 'skip',
  missed: 'once',
  rules: {},
  enabled: true,
  paused_reason: null,
  next_runs: ['2026-10-02T06:00:00.000Z'],
  created_at: '2026-09-01T10:00:00.000Z',
  ...overrides,
});

/** Serveur factice d'une API : trois versions (courante v3), deux runs (dont un échec), une transition, deux planifications (dont une en pause). */
function installLoadedApi(slug: string): string[] {
  return installApi({
    [`GET /api/apis/${slug}/versions`]: () => json(200, { versions: [version(3), version(2), version(1)], next_cursor: null }),
    [`GET /api/apis/${slug}/versions/3`]: () => json(200, { ...version(3), spec: { url: 'https://monsite.example/livres', items: '.book' }, script_ref: null }),
    'GET /api/runs': () => json(200, { runs: [run(1), run(2, { state: 'failed', outcome: 'failed', failure_class: 'blocked_by_protection', dataset_id: null, items: null })], next_cursor: null }),
    [`GET /api/apis/${slug}/status-events`]: () =>
      json(200, { events: [{ id: UUID(500), at: '2026-09-30T10:00:00.000Z', from_status: 'sain', to_status: 'bloquee', transition: 15, reason: { code: 'blocked_by_protection', params: {} }, run_id: UUID(202) }], next_cursor: null }),
    [`GET /api/apis/${slug}/schedules`]: () => json(200, { schedules: [schedule(1), schedule(2, { enabled: false, paused_reason: 'skipped_status' })] }),
  });
}

const blockedDetail = () =>
  apiDetail({
    slug: SLUG,
    status: 'bloquee',
    status_reason: { code: 'blocked_by_protection', params: { domain: 'monsite.example', at: '2026-09-30T10:00:00.000Z', attempt: 3, execution: 'fetch_in_page', network: 'direct', kind: 'challenge', cost_usd: 0.04, run_id: UUID(9) } },
    requires: { session_domain: null, tunnel: false },
  });

/** Une commande dont le texte commence par l'un des libellés interdits. */
const startsWith = (labels: string[]) => new RegExp(`^(?:${labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

describe('fiche d’une API bloquée, listes chargées', () => {
  test('assert_blocked_panel_no_tunnel_link : sur chaque onglet chargé, aucun Lancer, Relancer, retour de version ni reprise de planification ; Ré-enquêter seul', async () => {
    const forbidden = startsWith([fr.actions.launch, fr.actions.relaunch, fr.strategy.revert, fr.schedules.resume]);
    const loaded: Record<string, string> = { strategy: 'data-testid="versions-table"', runs: 'data-testid="runs-table"', status: 'data-testid="status-timeline"', schedules: 'data-testid="schedules-list"' };
    for (const tab of API_TABS) {
      installLoadedApi(SLUG);
      const html = await mount(ApiDetailPage, { detail: blockedDetail(), slug: SLUG, tab, resuming: false });
      expect(html, tab).toContain('data-testid="blocked-panel"');
      // L'onglet a bien lu ses listes : ses commandes sont rendues, pas un squelette vide.
      if (loaded[tab]) expect(html, tab).toContain(loaded[tab]);
      for (const control of controls(html)) {
        expect(`${control.attrs} ${control.text}`, `${tab} : ${control.text}`).not.toMatch(TUNNEL_WORDING);
        expect(control.text, `${tab} : ${control.text}`).not.toMatch(forbidden);
      }
      expect(html, tab).not.toContain('data-testid="launch-form"');
      expect(html, tab).not.toContain('header-reinvestigate');
      expect(html, tab).not.toContain('id="revert-confirm"');
      // La seule reprise est Ré-enquêter, dans le panneau.
      const resumes = controls(html).filter((control) => control.tag === 'button' && control.text === fr.actions.reinvestigate);
      expect(resumes, tab).toHaveLength(1);
    }
    // Les planifications restent visibles et peuvent être mises en pause ou supprimées ; seule la reprise disparaît.
    installLoadedApi(SLUG);
    const schedules = controls(await mount(ApiDetailPage, { detail: blockedDetail(), slug: SLUG, tab: 'schedules', resuming: false })).map((control) => control.text);
    expect(schedules).toContain(fr.schedules.pause);
    expect(schedules).toContain(fr.schedules.delete);
    expect(schedules).not.toContain(fr.schedules.resume);
  });

  test('témoin : sur une API saine, les mêmes listes chargées donnent Relancer, le retour de version et la reprise de planification', async () => {
    const detail = apiDetail({ slug: SLUG });
    const texts = async (tab: string) => {
      installLoadedApi(SLUG);
      return controls(await mount(ApiDetailPage, { detail, slug: SLUG, tab, resuming: false })).map((control) => control.text);
    };
    expect(await texts('runs')).toContain(fr.actions.relaunch);
    expect(await texts('strategy')).toContain(fr.strategy.revert);
    expect(await texts('schedules')).toContain(fr.schedules.resume);
  });
});

describe('« Revenir à cette version » (transitions 7 et 8)', () => {
  test('assert_revert_shows_preview : le retour n’est proposé que depuis sain ou warning ; jamais sur bloquee ni les autres statuts', async () => {
    const statuses: Schemas['ApiStatus'][] = ['enquete', 'sain', 'warning', 'reparation', 'erreur', 'action_requise', 'bloquee'];
    for (const status of statuses) {
      installLoadedApi(SLUG);
      const html = await mount(ApiStrategyTab, { detail: apiDetail({ slug: SLUG, status }), slug: SLUG });
      expect(html, status).toContain('data-testid="versions-table"');
      const reverts = controls(html).filter((control) => control.text === fr.strategy.revert);
      // v1 et v2 sont des versions antérieures à la courante (v3).
      expect(reverts, status).toHaveLength(status === 'sain' || status === 'warning' ? 2 : 0);
    }
  });
});
