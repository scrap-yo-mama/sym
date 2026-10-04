// SPDX-License-Identifier: AGPL-3.0-only
// Budget USD par utilisateur et par jour (08b § 3, `assert_budget_usd_daily`, PA-02 du pré-audit 4.3) sur un serveur réel :
// - dépense du jour (UTC) d'un utilisateur = coûts LLM + proxy de TOUS ses runs (runs, enquêtes, validations, reprises) ;
// - budget atteint : 429 `budget_exceeded`, aucun run créé, sur chaque route qui crée un run, REST comme console ; les
//   autres utilisateurs et la veille ne sont pas touchés ;
// - plafond d'instance : un membre ne dépasse pas `max_cost_usd` / `budget_daily_usd` d'instance en fixant les siens, ni par
//   PATCH, ni par l'import d'un fichier forgé ; le worker borne aussi ce qu'il lit en base (lignes antérieures) ;
// - réservation : le budget compte la dépense du jour ET l'enveloppe maximale des runs actifs ET celle du nouveau run (une
//   rafale ne dépasse plus le budget) ; un coût LLM inconnu compte l'enveloppe, jamais 0 ;
// - clé d'API (Bearer) et MCP : mêmes refus (`budget_exceeded`, `retryable: false`).
import { sealExport, type ApiExport, type ApiExportDraft } from '@runtime/core';
import { loadRunTarget } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { seedApi, seedRun } from '../../../tests/helpers/rest-seed.js';
import { createKey, createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';
import { reserveRunSlot } from './rest/shared.js';

const OUTPUT = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, price: { type: 'number' } } };
const INPUT = { type: 'object', additionalProperties: false, properties: { max_pages: { type: 'integer', minimum: 1, maximum: 50, description: 'Nombre maximal de pages lues par run.' } } };

type Party = { id: string; cookie: string; user: TestUser };

let srv: TestServer;
const parties: Record<string, Party> = {};

async function party(name: string): Promise<Party> {
  const user = await createUser(srv, `zz_test_budget_${name}@example.test`);
  parties[name] = { id: user.id, cookie: await signIn(srv, user), user };
  return parties[name]!;
}

const post = (p: Party, url: string, payload: unknown = {}) => srv.app.inject({ method: 'POST', url, headers: { cookie: p.cookie, origin: PUBLIC_URL }, payload: payload as Record<string, unknown> });
const patch = (p: Party, url: string, payload: unknown) => srv.app.inject({ method: 'PATCH', url, headers: { cookie: p.cookie, origin: PUBLIC_URL }, payload: payload as Record<string, unknown> });
const count = async (sql: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => Number(Object.values((await c.query<Record<string, string>>(sql, params)).rows[0]!)[0]));

/** Dépense `usd` dollars pour l'utilisateur (un run terminé, coût LLM), créé il y a `daysAgo` jours. */
async function spend(p: Party, apiId: string, usd: number, opts: { daysAgo?: number; kind?: 'run' | 'investigation' } = {}): Promise<void> {
  const { runId } = await seedRun(srv.db.url, { apiId, ownerId: p.id, state: 'succeeded', ...(opts.kind ? { kind: opts.kind } : {}) });
  await withClient(srv.db.url, (c) => c.query("UPDATE runs SET cost_llm_usd = $2, cost_proxy_usd = 0, created_at = now() - make_interval(days => $3) WHERE id = $1", [runId, usd, opts.daysAgo ?? 0]));
}

beforeAll(async () => {
  srv = await startTestServer('budget', { MAX_CONCURRENT_RUNS: '1000', MAX_ACTIVE_RUNS_PER_USER: '1000' });
  await runSetup(srv);
}, 180_000);
afterAll(async () => {
  await srv.close();
});

describe('assert_budget_usd_daily : budget USD par utilisateur et par jour (08b § 3)', () => {
  test('budget de 0,05 USD atteint : 429 budget_exceeded sur chaque création de run, aucun run créé ; les autres et la veille ne sont pas touchés', async () => {
    const rest = srv.started.ctx.rest;
    const saved = rest.userBudgetDailyUsd;
    rest.userBudgetDailyUsd = 0.05;
    try {
      const c = await party('c');
      const d = await party('d');
      const apiC = await seedApi(srv.db.url, c.id);
      const apiD = await seedApi(srv.db.url, d.id);
      // Enveloppes minuscules : la réservation (enveloppe maximale du run) tient dans le budget de 0,05 USD.
      await withClient(srv.db.url, (cl) => cl.query('UPDATE apis SET max_cost_usd = 0.01 WHERE id = ANY($1)', [[apiC.id, apiD.id]]));
      // Dépense de la veille : ne compte pas. 0,04 aujourd'hui : sous le budget.
      await spend(c, apiC.id, 0.2, { daysAgo: 2 });
      await spend(c, apiC.id, 0.04);
      expect((await post(c, `/api/apis/${apiC.slug}/runs`, { input: {} })).statusCode).toBe(202);
      // Une enquête compte aussi : 0,04 + 0,02 > 0,05.
      await spend(c, apiC.id, 0.02, { kind: 'investigation' });
      const before = await count('SELECT count(*) FROM runs WHERE owner_id = $1', [c.id]);
      const blocked = await post(c, `/api/apis/${apiC.slug}/runs`, { input: {} });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: { code: 'budget_exceeded' } });
      // Pas de Retry-After : retryable false jusqu'à la réinitialisation (minuit UTC).
      expect(blocked.headers['retry-after']).toBeUndefined();
      // Mêmes refus sur les autres routes qui créent un run (enquête lancée à la création d'API).
      const created = await post(c, '/api/apis', { description: 'Les livres zz test du budget, avec titre et prix', url: 'https://zz-test-budget.example/' });
      expect(created.statusCode).toBe(429);
      expect(created.json()).toMatchObject({ error: { code: 'budget_exceeded' } });
      expect(await count('SELECT count(*) FROM runs WHERE owner_id = $1', [c.id])).toBe(before);
      // Un autre utilisateur n'est pas touché.
      expect((await post(d, `/api/apis/${apiD.slug}/runs`, { input: {} })).statusCode).toBe(202);
      // Le budget revient avec le jour : plus rien de dépensé aujourd'hui.
      await withClient(srv.db.url, (cl) => cl.query("UPDATE runs SET created_at = created_at - interval '2 days' WHERE owner_id = $1", [c.id]));
      expect((await post(c, `/api/apis/${apiC.slug}/runs`, { input: {} })).statusCode).toBe(202);
    } finally {
      rest.userBudgetDailyUsd = saved;
    }
  });

  test('plafond d’instance : max_cost_usd et budget_daily_usd fixés par le membre ne dépassent pas celui de l’instance', async () => {
    const rest = srv.started.ctx.rest;
    const savedCost = rest.maxCostUsdPerRun;
    const savedDaily = rest.userBudgetDailyUsd;
    rest.maxCostUsdPerRun = 2;
    rest.userBudgetDailyUsd = 10;
    try {
      const e = await party('e');
      const apiE = await seedApi(srv.db.url, e.id);
      const url = `/api/apis/${apiE.slug}`;
      const over = await patch(e, url, { max_cost_usd: 1000 });
      expect(over.statusCode).toBe(400);
      expect(over.json()).toMatchObject({ error: { code: 'cost_cap_exceeded' } });
      const overDaily = await patch(e, url, { budget_daily_usd: 100000 });
      expect(overDaily.statusCode).toBe(400);
      expect(overDaily.json()).toMatchObject({ error: { code: 'cost_cap_exceeded' } });
      expect(await count('SELECT count(*) FROM apis WHERE id = $1 AND max_cost_usd > 2', [apiE.id])).toBe(0);
      const ok = await patch(e, url, { max_cost_usd: 2, budget_daily_usd: 10 });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ max_cost_usd: 2, budget_daily_usd: 10 });
    } finally {
      rest.maxCostUsdPerRun = savedCost;
      rest.userBudgetDailyUsd = savedDaily;
    }
  });
});

/** Fichier d'export d'une API du membre, rescellé avec ces champs d'`api` (un membre édite son fichier, puis le réimporte). */
async function forgedExport(p: Party, slug: string, fields: Record<string, unknown>): Promise<ApiExport> {
  // Une API issue d'une enquête porte sa demande (sans elle, l'export est refusé : 409).
  await withClient(srv.db.url, (c) => c.query("UPDATE apis SET investigation = $2::jsonb WHERE slug = $1 AND owner_id = $3", [slug, JSON.stringify({ request: { url: 'https://zz-test-budget.example/books', description: 'zz_test api', auto_validate: false, budget_usd: 1, timeout_s: 60 } }), p.id]));
  const exported = await srv.app.inject({ method: 'GET', url: `/api/apis/${slug}/export`, headers: { cookie: p.cookie } });
  expect(exported.statusCode).toBe(200);
  const doc = exported.json<ApiExportDraft & { api: Record<string, unknown> }>();
  return sealExport({ ...doc, api: { ...doc.api, source_url: 'https://zz-test-budget.example/books', output_schema: OUTPUT, input_schema: INPUT, output_columns: undefined, ...fields } } as ApiExportDraft);
}

async function withCaps<T>(caps: { daily?: number; perRun?: number }, fn: () => Promise<T>): Promise<T> {
  const rest = srv.started.ctx.rest;
  const saved = { daily: rest.userBudgetDailyUsd, perRun: rest.maxCostUsdPerRun };
  if (caps.daily !== undefined) rest.userBudgetDailyUsd = caps.daily;
  if (caps.perRun !== undefined) rest.maxCostUsdPerRun = caps.perRun;
  try {
    return await fn();
  } finally {
    rest.userBudgetDailyUsd = saved.daily;
    rest.maxCostUsdPerRun = saved.perRun;
  }
}

describe('plafonds d’instance : import d’un fichier forgé et lecture par le worker (PA-02)', () => {
  test('import avec max_cost_usd ou budget_daily_usd au-dessus des plafonds : 400 cost_cap_exceeded, aperçu comme confirmation, aucune API créée', async () => {
    await withCaps({ daily: 10, perRun: 2 }, async () => {
      const f = await party('f');
      const apiF = await seedApi(srv.db.url, f.id);
      const apisBefore = await count('SELECT count(*) FROM apis WHERE owner_id = $1', [f.id]);
      for (const fields of [{ max_cost_usd: 1000 }, { budget_daily_usd: 100000 }, { max_cost_usd: 1000, budget_daily_usd: 100000 }]) {
        const doc = await forgedExport(f, apiF.slug, fields);
        for (const url of ['/api/apis/import', '/api/apis/import?confirm=true']) {
          const res = await post(f, url, doc);
          expect(res.statusCode, `${url} ${JSON.stringify(fields)} ${res.body.slice(0, 200)}`).toBe(400);
          expect(res.json()).toMatchObject({ error: { code: 'cost_cap_exceeded' } });
        }
      }
      expect(await count('SELECT count(*) FROM apis WHERE owner_id = $1', [f.id])).toBe(apisBefore);
      // Aux plafonds exactement : accepté.
      const ok = await post(f, '/api/apis/import?confirm=true', await forgedExport(f, apiF.slug, { max_cost_usd: 2, budget_daily_usd: 10 }));
      expect(ok.statusCode, ok.body.slice(0, 200)).toBe(201);
    });
  });

  test('worker : une API déjà en base au-dessus du plafond d’instance est bornée à la lecture (max_cost_usd)', async () => {
    const g = await party('g');
    const apiG = await seedApi(srv.db.url, g.id);
    await withClient(srv.db.url, (c) => c.query('UPDATE apis SET max_cost_usd = 1000 WHERE id = $1', [apiG.id]));
    const pool = srv.started.ctx.pool;
    expect((await loadRunTarget(pool, { apiId: apiG.id, ownerId: g.id, version: null }))!.api.maxCostUsd).toBe(1000);
    const capped = await loadRunTarget(pool, { apiId: apiG.id, ownerId: g.id, version: null, caps: { maxCostUsdPerRun: 2 } });
    expect(capped!.api.maxCostUsd).toBe(2);
    // Valeur par défaut (0,5) au-dessus d'un plafond plus bas : bornée de même.
    await withClient(srv.db.url, (c) => c.query('UPDATE apis SET max_cost_usd = 0.5 WHERE id = $1', [apiG.id]));
    expect((await loadRunTarget(pool, { apiId: apiG.id, ownerId: g.id, version: null, caps: { maxCostUsdPerRun: 0.1 } }))!.api.maxCostUsd).toBe(0.1);
  });

  test('D-123 : API sans plafond (NULL par défaut) : borne effective = budget du jour restant, jamais illimitée', async () => {
    const n = await party('n');
    const apiN = await seedApi(srv.db.url, n.id);
    // Une API neuve n'a plus de plafond par run.
    expect(await count('SELECT count(*) FROM apis WHERE id = $1 AND max_cost_usd IS NULL', [apiN.id])).toBe(1);
    const pool = srv.started.ctx.pool;
    const fresh = (await loadRunTarget(pool, { apiId: apiN.id, ownerId: n.id, version: null, caps: { maxCostUsdPerRun: 2, userBudgetDailyUsd: 7 } }))!;
    expect(fresh.api.costCapUsd).toBeNull();
    expect(fresh.api.maxCostUsd).toBe(7);
    // La dépense du jour (et non celle de la veille) réduit la borne ; budget épuisé : 0, jamais négatif.
    await spend(n, apiN.id, 2.5);
    await spend(n, apiN.id, 3, { daysAgo: 1 });
    expect((await loadRunTarget(pool, { apiId: apiN.id, ownerId: n.id, version: null, caps: { maxCostUsdPerRun: 2, userBudgetDailyUsd: 7 } }))!.api.maxCostUsd).toBe(4.5);
    expect((await loadRunTarget(pool, { apiId: apiN.id, ownerId: n.id, version: null, caps: { maxCostUsdPerRun: 2, userBudgetDailyUsd: 2 } }))!.api.maxCostUsd).toBe(0);
    // Sans plafonds passés : le budget du jour par défaut de l'instance (50 $) tient lieu de borne finie.
    expect((await loadRunTarget(pool, { apiId: apiN.id, ownerId: n.id, version: null }))!.api.maxCostUsd).toBe(47.5);
    // Un plafond fixé par le membre reste la borne, bornée par MAX_COST_USD_PER_RUN.
    await withClient(srv.db.url, (c) => c.query('UPDATE apis SET max_cost_usd = 3 WHERE id = $1', [apiN.id]));
    const capped = (await loadRunTarget(pool, { apiId: apiN.id, ownerId: n.id, version: null, caps: { maxCostUsdPerRun: 2, userBudgetDailyUsd: 7 } }))!;
    expect(capped.api).toMatchObject({ costCapUsd: 2, maxCostUsd: 2 });
  });
});

describe('réservation de l’enveloppe maximale (08b § 3, PA-02)', () => {
  test('rafale : la dépense du jour, les enveloppes des runs actifs et celle du nouveau run tiennent dans le budget', async () => {
    await withCaps({ daily: 1, perRun: 10 }, async () => {
      const h = await party('h');
      const apiH = await seedApi(srv.db.url, h.id);
      await withClient(srv.db.url, (c) => c.query('UPDATE apis SET max_cost_usd = 0.4 WHERE id = $1', [apiH.id]));
      const run = () => post(h, `/api/apis/${apiH.slug}/runs`, { input: {} });
      expect((await run()).statusCode).toBe(202); // 0,4
      expect((await run()).statusCode).toBe(202); // 0,8
      const third = await run(); // 1,2 > 1
      expect(third.statusCode).toBe(429);
      expect(third.json()).toMatchObject({ error: { code: 'budget_exceeded' } });
      expect(third.headers['retry-after']).toBeUndefined();
      expect(await count("SELECT count(*) FROM runs WHERE owner_id = $1 AND state = 'queued'", [h.id])).toBe(2);
      // Une enquête (enveloppe par défaut 3 USD, bornée au budget du jour de 1 USD) ne passe pas non plus.
      const inv = await post(h, '/api/apis', { description: 'Les livres zz test de la rafale, avec titre et prix', url: 'https://zz-test-burst.example/' });
      expect(inv.statusCode).toBe(429);
      expect(inv.json()).toMatchObject({ error: { code: 'budget_exceeded' } });
      // Un run qui se termine libère son enveloppe (seule la dépense réelle reste).
      await withClient(srv.db.url, (c) => c.query("UPDATE runs SET state = 'succeeded', outcome = 'clean', finished_at = now(), duration_ms = 1 WHERE owner_id = $1", [h.id]));
      expect((await run()).statusCode).toBe(202);
    });
  });

  test('D-123 : run d’une API sans plafond admis tant qu’il reste du budget du jour (aucune enveloppe de MAX_COST_USD_PER_RUN réservée)', async () => {
    await withCaps({ daily: 1, perRun: 10 }, async () => {
      const o = await party('o');
      const apiO = await seedApi(srv.db.url, o.id);
      await spend(o, apiO.id, 0.7);
      const run = () => post(o, `/api/apis/${apiO.slug}/runs`, { input: {} });
      // 0,3 $ restants, moins que MAX_COST_USD_PER_RUN : admis (le worker le borne au budget restant).
      expect((await run()).statusCode).toBe(202);
      expect((await run()).statusCode).toBe(202);
      // Budget du jour atteint : refus clair (réinitialisation à minuit UTC, l'admin peut le relever).
      await spend(o, apiO.id, 0.3);
      const refused = await run();
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ error: { code: 'budget_exceeded' } });
      expect(refused.json<{ error: { message: string } }>().error.message).toMatch(/minuit UTC/);
      expect(refused.json<{ error: { message: string } }>().error.message).toMatch(/USER_BUDGET_DAILY_USD/);
    });
  });

  test('coût LLM inconnu (NULL) : compté pour l’enveloppe du run (jamais 0) et pour le coût proxy connu', async () => {
    await withCaps({ daily: 0.3, perRun: 10 }, async () => {
      const i = await party('i');
      const apiI = await seedApi(srv.db.url, i.id);
      await withClient(srv.db.url, (c) => c.query('UPDATE apis SET max_cost_usd = 0.05 WHERE id = $1', [apiI.id]));
      const { runId } = await seedRun(srv.db.url, { apiId: apiI.id, ownerId: i.id, state: 'succeeded' });
      await withClient(srv.db.url, (c) => c.query('UPDATE runs SET cost_llm_usd = NULL, cost_proxy_usd = 0.4 WHERE id = $1', [runId]));
      // Proxy 0,4 > budget 0,3 : refusé, bien que le coût LLM soit inconnu.
      const res = await post(i, `/api/apis/${apiI.slug}/runs`, { input: {} });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: { code: 'budget_exceeded' } });
      // Proxy 0,01 mais LLM inconnu : l'enveloppe du run (0,05) compte, 0,3 - 0,05 = 0,25 reste pour le suivant.
      await withClient(srv.db.url, (c) => c.query('UPDATE runs SET cost_proxy_usd = 0.01 WHERE id = $1', [runId]));
      await withClient(srv.db.url, (c) => c.query('UPDATE apis SET max_cost_usd = 0.29 WHERE id = $1', [apiI.id]));
      expect((await post(i, `/api/apis/${apiI.slug}/runs`, { input: {} })).statusCode).toBe(429); // 0,29 (enveloppe du NULL) + 0,29 > 0,3
    });
  });

  test('reserveRunSlot hors acteur : refus explicite (jamais de contrôle sauté)', async () => {
    await withClient(srv.db.url, async (c) => {
      await c.query('BEGIN');
      await expect(reserveRunSlot(c, srv.started.ctx, { kind: 'run' })).rejects.toThrow();
      await c.query('ROLLBACK');
    });
  });
});

describe('budget par clé d’API (Bearer) et par MCP', () => {
  test('budget atteint : 429 budget_exceeded par clé, et outil MCP run_api en erreur retryable false ; aucun run créé', async () => {
    await withCaps({ daily: 0.05, perRun: 10 }, async () => {
      const j = await party('j');
      const apiJ = await seedApi(srv.db.url, j.id);
      await spend(j, apiJ.id, 0.06);
      const before = await count('SELECT count(*) FROM runs WHERE owner_id = $1', [j.id]);
      const record = (await createKey(srv, j.cookie, j.user)).key;
      const viaKey = await srv.app.inject({ method: 'POST', url: `/api/apis/${apiJ.slug}/runs`, headers: { authorization: `Bearer ${record}` }, payload: { input: {} } });
      expect(viaKey.statusCode).toBe(429);
      expect(viaKey.json()).toMatchObject({ error: { code: 'budget_exceeded' } });
      expect(viaKey.headers['retry-after']).toBeUndefined();
      const mcp = await srv.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { host: 'localhost:3000', accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${record}` },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_api', arguments: { slug: apiJ.slug, input: {} } } }),
      });
      expect(mcp.statusCode).toBe(200);
      const data = mcp.body.includes('data:') ? mcp.body.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : mcp.body;
      const result = (JSON.parse(data) as { result: { isError?: boolean; content: { text: string }[] } }).result;
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: 'budget_exceeded', retryable: false });
      expect(await count('SELECT count(*) FROM runs WHERE owner_id = $1', [j.id])).toBe(before);
    });
  });
});
