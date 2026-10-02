// SPDX-License-Identifier: AGPL-3.0-only
// Test de fumée : chaque site du registre répond sur /health (chaque hôte) et sur sa requête de fumée déclarée.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BENCH_HOSTS, BENCH_INJECTION_CANARY, INJECTION_CORPUS, STEP_MUTATIONS } from './sites/bench-sites.ts';
import { startClient, type Client } from './test-helpers.ts';

interface SiteInfo {
  id: string;
  lot: string;
  hosts: string[];
  smoke: { path: string; status: number };
}

// Inventaire attendu (15 §8) : 12 existantes + défi en 200, 5 ajouts Q1, 6 ajouts S5, 8 accès O8, 4 du spike 0.6a, 2 du banc 2.8
// (corpus d’injection, miroir local des mutations par étape) = 38 sites.
const EXPECTED: Record<string, string[]> = {
  base: ['api_json', 'ssr', 'spa', 'login', 'challenge', '429', 'geo', 'injection', 'dom', 'signed403', 'irregular', '503', 'challenge_200'],
  q1: ['ssrf', 'slow', 'volume', 'personal', 'scroll'],
  s5: ['next', 'nuxt', 'apollo', 'jsonld', 'cursor', 'linkheader'],
  o8: ['robots', 'robots_4xx', 'robots_5xx', 'robots_redirect', 'robots_big', 'robots_crawl_delay', 'content_signal', 'payment_402'],
  // Spike 0.6a (eval/spike-0.6a-decision.md §5) : E4, E5, E6 et injection.
  agent: ['agent_irregular_html', 'agent_mobile_next', 'agent_no_api_unstable_dom', 'agent_prompt_injection'],
  // Banc 2.8 (15 §11) : corpus d’injection (4 techniques) et miroir local des 10 mutations par étape.
  bench: ['bench_injection', 'bench_steps'],
};

let fx: Client;
let sites: SiteInfo[] = [];
beforeAll(async () => {
  fx = await startClient();
  sites = ((await fx.json('127.0.0.1', '/__sites')) as { sites: SiteInfo[] }).sites;
});
afterAll(async () => {
  await fx.close();
});
beforeEach(async () => {
  await fx.reset();
});

describe('fixtures : inventaire', () => {
  it('sert exactement les 38 sites attendus, par lot', () => {
    for (const [lot, ids] of Object.entries(EXPECTED)) {
      expect(sites.filter((s) => s.lot === lot).map((s) => s.id).sort(), lot).toEqual([...ids].sort());
    }
    expect(sites).toHaveLength(38);
  });
});

describe('fixture scroll : lot initial', () => {
  it('assert_scroll_fixture_initial_batch — 10 éléments au chargement, hauteur 600 px (aucun lot déclenché par l’observateur), 50 autres par /api/feed', async () => {
    const page = await fx.get('zz_test_scroll.localhost', '/');
    expect(page.status).toBe(200);
    const html = typeof page.body === 'string' ? page.body : String(page.body);
    expect(html.match(/<div class="feed-item"/g)).toHaveLength(10);
    expect(html).toContain('.feed-item{height:600px}');
    let total = 10;
    for (let offset = 10; offset < 60; offset += 10) {
      const batch = (await fx.json('zz_test_scroll.localhost', `/api/feed?offset=${offset}&limit=10`)) as { items: unknown[]; done: boolean };
      expect(batch.items).toHaveLength(10);
      total += batch.items.length;
      expect(batch.done).toBe(offset === 50);
    }
    expect(total).toBe(60);
  });
});

describe.each(Object.values(EXPECTED).flat())('fixture %s : fumée', (id) => {
  it('répond 200 sur /health de chaque hôte et sur sa requête de fumée', async () => {
    const site = sites.find((s) => s.id === id);
    expect(site, `site ${id} absent du registre`).toBeDefined();
    for (const host of site?.hosts ?? []) {
      const health = await fx.get(host, '/health');
      expect(health.status, `${host}/health`).toBe(200);
    }
    const first = site?.hosts[0] ?? '';
    const res = await fx.get(first, site?.smoke.path ?? '/');
    expect(res.status, `${first}${site?.smoke.path}`).toBe(site?.smoke.status);
    expect((await fx.stats()).hosts[first]?.paths[site?.smoke.path ?? '/']).toBe(1);
  });
});

describe('banc 2.8 : corpus d’injection et mutations par étape (fumée)', () => {
  it.each(INJECTION_CORPUS.map((entry) => [entry.id, entry.path] as const))('corpus %s : la page répond 200 et porte la charge hostile', async (_id, path) => {
    const res = await fx.get(BENCH_HOSTS.injection, path);
    expect(res.status).toBe(200);
    expect(res.body).toContain(BENCH_INJECTION_CANARY);
  });

  it.each([...STEP_MUTATIONS])('mutation par étape %s : acceptée par la commande, la première page répond 200', async (mutation) => {
    const set = await fx.control({ op: 'site', site: 'bench_steps', mutation });
    expect(set.status).toBe(200);
    expect((await fx.get(BENCH_HOSTS.steps, '/')).status).toBe(200);
  });
});
