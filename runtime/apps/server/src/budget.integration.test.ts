// SPDX-License-Identifier: AGPL-3.0-only
// Budget USD par utilisateur et par jour (08b § 3, `assert_budget_usd_daily`, PA-02 du pré-audit 4.3) sur un serveur réel :
// - dépense du jour (UTC) d'un utilisateur = coûts LLM + proxy de TOUS ses runs (runs, enquêtes, validations, reprises) ;
// - budget atteint : 429 `budget_exceeded`, aucun run créé, sur chaque route qui crée un run, REST comme console ; les
//   autres utilisateurs et la veille ne sont pas touchés ;
// - plafond d'instance : un membre ne dépasse pas `max_cost_usd` / `budget_daily_usd` d'instance en fixant les siens.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { seedApi, seedRun } from '../../../tests/helpers/rest-seed.js';
import { createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer } from '../../../tests/helpers/server.js';

type Party = { id: string; cookie: string };

let srv: TestServer;
const parties: Record<string, Party> = {};

async function party(name: string): Promise<Party> {
  const user = await createUser(srv, `zz_test_budget_${name}@example.test`);
  parties[name] = { id: user.id, cookie: await signIn(srv, user) };
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
