// Test de fumée : chaque site du registre répond sur /health (chaque hôte) et sur sa requête de fumée déclarée.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startClient, type Client } from './test-helpers.ts';

interface SiteInfo {
  id: string;
  lot: string;
  hosts: string[];
  smoke: { path: string; status: number };
}

// Inventaire attendu (15 §8) : 12 existantes + défi en 200, 5 ajouts Q1, 6 ajouts S5, 8 accès O8, 4 du spike 0.6a = 36 sites.
const EXPECTED: Record<string, string[]> = {
  base: ['api_json', 'ssr', 'spa', 'login', 'challenge', '429', 'geo', 'injection', 'dom', 'signed403', 'irregular', '503', 'challenge_200'],
  q1: ['ssrf', 'slow', 'volume', 'personal', 'scroll'],
  s5: ['next', 'nuxt', 'apollo', 'jsonld', 'cursor', 'linkheader'],
  o8: ['robots', 'robots_4xx', 'robots_5xx', 'robots_redirect', 'robots_big', 'robots_crawl_delay', 'content_signal', 'payment_402'],
  // Spike 0.6a (eval/spike-0.6a-decision.md §5) : E4, E5, E6 et injection.
  agent: ['agent_irregular_html', 'agent_mobile_next', 'agent_no_api_unstable_dom', 'agent_prompt_injection'],
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
  it('sert exactement les 36 sites attendus, par lot', () => {
    for (const [lot, ids] of Object.entries(EXPECTED)) {
      expect(sites.filter((s) => s.lot === lot).map((s) => s.id).sort(), lot).toEqual([...ids].sort());
    }
    expect(sites).toHaveLength(36);
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
