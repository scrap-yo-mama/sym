// SPDX-License-Identifier: AGPL-3.0-only
// Test de fumée : chaque site du registre répond sur /health (chaque hôte) et sur sa requête de fumée déclarée.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BENCH_HOSTS, BENCH_INJECTION_CANARY, INJECTION_CORPUS, STEP_MUTATIONS, benchStepsContacts, type StepMutation } from './sites/bench-sites.ts';
import { makeProducts } from './data.ts';
import { esc } from './res.ts';
import { DEFAULT_SEED } from './seed.ts';
import { startClient, type Client } from './test-helpers.ts';

interface SiteInfo {
  id: string;
  lot: string;
  hosts: string[];
  smoke: { path: string; status: number };
}

// Inventaire attendu (15 §8) : 12 existantes + défi en 200, 5 ajouts Q1, 6 ajouts S5, 8 accès O8, 4 du spike 0.6a, 2 du banc 2.8
// (corpus d’injection, miroir local des mutations par étape), 2 des cas de référence de la gate M2 (D0, C1),
// la liste HTML paginée par le chemin (constat Janssens) et banc de cas réels (5) = 46 sites.
const EXPECTED: Record<string, string[]> = {
  base: ['api_json', 'ssr', 'spa', 'login', 'challenge', '429', 'geo', 'injection', 'dom', 'signed403', 'irregular', '503', 'challenge_200'],
  q1: ['ssrf', 'slow', 'volume', 'personal', 'scroll'],
  s5: ['next', 'nuxt', 'apollo', 'jsonld', 'cursor', 'linkheader'],
  o8: ['robots', 'robots_4xx', 'robots_5xx', 'robots_redirect', 'robots_big', 'robots_crawl_delay', 'content_signal', 'payment_402'],
  // Spike 0.6a (eval/spike-0.6a-decision.md §5) : E4, E5, E6 et injection.
  agent: ['agent_irregular_html', 'agent_mobile_next', 'agent_no_api_unstable_dom', 'agent_prompt_injection'],
  // Banc 2.8 (15 §11) : corpus d’injection (4 techniques) et miroir local des 10 mutations par étape.
  bench: ['bench_injection', 'bench_steps'],
  // Gate M2 (tests/cases) : D0 (catalogue rendu serveur paginé par rel=next) et C1 (recherche paginée, défi à la page 2) ;
  // liste HTML statique paginée par le chemin (constat Janssens) ; banc de cas réels (R07, R08, R06, R02, R04).
  cases: ['books', 'search_guarded', 'html_list', 'catalogue_pages', 'table_pages', 'wiki_table', 'agency_dupes', 'jobs_grouped'],
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
  it('sert exactement les 46 sites attendus, par lot', () => {
    for (const [lot, ids] of Object.entries(EXPECTED)) {
      expect(sites.filter((s) => s.lot === lot).map((s) => s.id).sort(), lot).toEqual([...ids].sort());
    }
    expect(sites).toHaveLength(46);
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

describe('fixture irregular : HTML irrégulier mais lisible (0.5, retouche 2.8)', () => {
  it('le <title> est fermé : les 12 produits sont dans le corps du document, pas dans le texte du titre', async () => {
    const res = await fx.get('zz_test_irregular.localhost', '/');
    expect(res.status).toBe(200);
    const body = String(res.body);
    const close = body.indexOf('</title>');
    expect(close).toBeGreaterThan(body.indexOf('<title>'));
    const afterTitle = body.slice(close);
    for (const p of makeProducts(DEFAULT_SEED, 'irregular', 12)) expect(afterTitle, p.id).toContain(esc(p.title));
    // Le reste reste irrégulier : ni </head>, ni </body>, ni </html>, balises mal imbriquées, attributs sans guillemets.
    for (const tag of ['</head>', '</body>', '</html>']) expect(body).not.toContain(tag);
    expect(body).toContain('<b><i>');
    expect(body).toContain('class=row');
  });
});

describe('banc 2.8 : corpus d’injection et mutations par étape (fumée)', () => {
  it.each(INJECTION_CORPUS.map((entry) => [entry.id, entry.path] as const))('corpus %s : la page répond 200 et porte la charge hostile', async (_id, path) => {
    const res = await fx.get(BENCH_HOSTS.injection, path);
    expect(res.status).toBe(200);
    expect(res.body).toContain(BENCH_INJECTION_CANARY);
  });

  // Marqueur propre à chaque mutation par étape : absent de la liste saine, présent une fois la mutation appliquée.
  const first = benchStepsContacts()[0]!.id;
  const STEP_MARKERS: Record<StepMutation, { path: string; mutated: (body: string) => boolean }> = {
    rename_label: { path: '/', mutated: (b) => b.includes('>Page suivante</button>') },
    move_element: { path: '/', mutated: (b) => b.includes('<header><button type="button" id="next"') },
    insert_overlay: { path: '/', mutated: (b) => b.includes('class="zz-overlay" role="dialog"') },
    duplicate_label: { path: '/', mutated: (b) => (b.match(/>Suivant<\/button>/g) ?? []).length === 2 },
    inert_element: { path: '/', mutated: (b) => b.includes('id="next"') && !b.includes("addEventListener('click'") },
    stale_data: { path: '/?p=2', mutated: (b) => b.includes(`(${first})`) },
    challenge_midway: { path: '/?p=2', mutated: (b) => b.includes('id="zz-test-challenge"') && !b.includes('id="list"') },
    weaken_post: { path: '/?p=2', mutated: (b) => !b.includes('id="ind"') },
    legit_empty: { path: '/', mutated: (b) => b.includes('class="vide"') && !b.includes('<li class="c">') },
    insert_submit: { path: '/', mutated: (b) => b.includes('<form method="post" action="/confirm">') },
  };

  it.each([...STEP_MUTATIONS])('mutation par étape %s : acceptée par la commande, son effet est visible (marqueur absent avant, présent après)', async (mutation) => {
    const marker = STEP_MARKERS[mutation];
    const before = await fx.get(BENCH_HOSTS.steps, marker.path);
    expect(before.status).toBe(200);
    expect(marker.mutated(String(before.body)), `${mutation} : marqueur déjà présent sur la liste saine`).toBe(false);
    const set = await fx.control({ op: 'site', site: 'bench_steps', mutation });
    expect(set.status).toBe(200);
    const after = await fx.get(BENCH_HOSTS.steps, marker.path);
    expect(after.status).toBe(200);
    expect(marker.mutated(String(after.body)), `${mutation} : effet absent`).toBe(true);
  });
});

describe('dossier d’enquête 2.14 (recette 12i) : fixtures servies (fumée)', () => {
  const API = 'zz_test_api_json.localhost';
  const LOGIN = 'zz_test_login.localhost';

  it('zz_test_api_json : robots.txt interdit /private-api/ (qui sert pourtant des contacts), /api/missing répond 404', async () => {
    const robots = await fx.get(API, '/robots.txt');
    expect(robots.status).toBe(200);
    expect(String(robots.body)).toContain('Disallow: /private-api/');
    expect((await fx.get(API, '/private-api/contacts')).status).toBe(200);
    expect((await fx.get(API, '/api/missing')).status).toBe(404);
    expect((await fx.get(API, '/api/contacts')).status).toBe(200);
  });

  it('zz_test_api_json : la mutation rename_field (réparation de la deuxième API de 12i) renomme name en full_name', async () => {
    expect((await fx.control({ op: 'site', site: 'api_json', mutation: 'rename_field' })).status).toBe(200);
    const body = JSON.parse(String((await fx.get(API, '/api/contacts')).body)) as { items: Record<string, unknown>[] };
    expect(body.items[0]).toHaveProperty('full_name');
    expect(body.items[0]).not.toHaveProperty('name');
  });

  it('zz_test_login : la page « derrière connexion » porte un lien /logout à effet de bord (GET qui ferme la session)', async () => {
    const login = await fx.call(LOGIN, 'POST', '/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=zz_test_user&password=zz_test_pass' });
    expect(login.status).toBe(302);
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0]!;
    const account = await fx.get(LOGIN, '/account', { cookie });
    expect(account.status).toBe(200);
    expect(String(account.body)).toContain('href="/logout"');
    expect((await fx.get(LOGIN, '/logout', { cookie })).status).toBe(302);
    expect((await fx.get(LOGIN, '/account', { cookie })).status).toBe(302);
  });
});
