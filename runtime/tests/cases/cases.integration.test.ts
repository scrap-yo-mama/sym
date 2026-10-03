// SPDX-License-Identifier: AGPL-3.0-only
// Gate M2 (09-planning) : « les cas en version fixtures passent au niveau du worker ». Une épreuve par cas de référence de
// 01-vision (D0, C1, C2, C3), déroulée de bout en bout sur fixtures locales, sans Chromium (DISABLE_BROWSER) ni site réel :
// enquête mise en file (`startInvestigation`) → worker → exécuteur d'enquête → étape 0 → reconnaissance → schéma proposé par
// le rôle `investigate` (faux fournisseur) → essais par coût croissant → stratégie v1 → REJEU par un run ordinaire (`createRun`).
// Le tunnel est le vrai : passerelle du serveur (WSS) → exécuteur RÉEL de l'extension, avec un navigateur simulé qui porte la
// session du propriétaire (cookie posé par la connexion au site, jamais transmis à l'instance).
// - D0 : catalogue rendu serveur paginé par lien rel=next (données embarquées par page) → E1 sur N1, toutes les pages rejouées ;
// - C1 : recherche paginée dont la page 2 sert un défi → `bloquee`, aucun essai proxy ni tunnel (X3, INV6, A7) ;
// - C2 : API à session obligatoire (likes et commentaires d'un post) → tunnel forcé, enquête et rejeu par l'extension du
//   propriétaire seulement (INV5) ;
// - C3 : page « mes contacts » : publique → E1 sur N1 sans proxy ; derrière une connexion non connectée → `action_requise`
//   sans escalade ; site connecté dans l'extension → E1 en tunnel (usage par défaut des cookies, 07 §2), sans proxy.
// La suite est reprise par 4.2 (MCP, console) : les noms `assert_case_*_fixture` sont inscrits dans tests/invariants.json.
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createLogger, DomainPacer, generateExtensionToken, Secret, validateOutput, type RunExecutor } from '@runtime/core';
import type { CommandFrame } from '@runtime/core/tunnel';
import * as net from '@runtime/core/net';
import { createRun, listInvestigationEvents, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, startInvestigation, withActor } from '@runtime/db';
import { createLlmClient, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BrowserApi, TabInfo } from '../../apps/extension/src/core/browser-api.ts';
import { TunnelExecutor } from '../../apps/extension/src/core/tunnel-executor.ts';
import { loadWorkerConfig } from '../../apps/worker/src/config.js';
import { createInvestigationExecutor, dispatchByKind } from '../../apps/worker/src/exec/investigation-executor.js';
import { createStrategyRuntime } from '../../apps/worker/src/exec/strategy-executor.js';
import { TunnelJobClient } from '../../apps/worker/src/tunnel/client.js';
import { startWorker, type Worker } from '../../apps/worker/src/worker.js';
import { startClient, type Client } from '../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../helpers/fixture-net.js';
import { closeTestPool, createTestPool } from '../helpers/pg.js';
import { createUser, runSetup, startTestServer, type TestServer, type TestUser } from '../helpers/server.js';
import { SimExtension } from '../helpers/tunnel-sim.js';

const BOOKS = 'zz_test_books.localhost';
const SEARCH = 'zz_test_search_guarded.localhost';
const LOGIN = 'zz_test_login.localhost';
const CONTACTS = 'zz_test_api_json.localhost';
/** Site à compte tel que l'extension le connaît : un nom public (le tunnel refuse `*.localhost`, 07 §2), servi par la
 * fixture `login` à travers le navigateur simulé ; jamais résolu hors du test. */
const ACCOUNT = 'zz-test-login.example';
const MODEL = 'zz_investigate';
const silent = createLogger({ name: 'zz_test', level: 'fatal' });

let srv: TestServer;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let worker: Worker;
let tunnel: TunnelJobClient;
let client: Client;
let fake: FakeProvider;
let owner: TestUser;
let other: TestUser;
let ownerExt: SimExtension;
let otherExt: SimExtension;
let browser: ReturnType<typeof ownerBrowser>;
let base: (host: string) => string;

function llmConfig(): LlmConfig {
  return {
    providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }],
    roles: { investigate: { provider: 'fake', model: MODEL } },
  };
}

/**
 * Navigateur du propriétaire, simulé sous Node pour l'exécuteur RÉEL de l'extension : `zz-test-login.example` est servi par
 * la fixture `login` (hôte virtuel), et chaque requête part avec le cookie de session que le propriétaire a obtenu en se
 * connectant au site dans SON navigateur (le navigateur attache ses cookies lui-même, 07 §2 « Tunnel »). Les redirections ne
 * sont jamais suivies, comme l'extension.
 */
function ownerBrowser(fx: Client): { api: BrowserApi; calls: { url: string; cookie: boolean }[]; login: () => Promise<string>; logout: () => void } {
  const calls: { url: string; cookie: boolean }[] = [];
  const tabs = new Map<number, TabInfo>();
  let next = 1;
  let cookie: string | null = null;
  const send = async (url: string, init: { method: string; headers: Record<string, string>; body?: string | null } = { method: 'GET', headers: {} }) => {
    const u = new URL(url);
    if (u.hostname !== ACCOUNT) throw new Error(`zz_test : hôte non simulé ${u.hostname}`);
    calls.push({ url: `${u.pathname}${u.search}`, cookie: cookie !== null });
    const headers: Record<string, string> = { ...init.headers, ...(cookie === null ? {} : { cookie }) };
    const res = await fx.call(LOGIN, init.method, `${u.pathname}${u.search}`, { headers, ...(init.body ? { body: init.body } : {}) });
    const flat = Object.entries(res.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : String(v)] as [string, string]]));
    return { status: res.status, headers: flat, body: res.body };
  };
  const api: BrowserApi = {
    tabs: {
      create: async (url) => {
        const tab: TabInfo = { id: next++, url, status: 'complete', active: false, autoDiscardable: true };
        tabs.set(tab.id, tab);
        return tab;
      },
      get: async (id) => tabs.get(id) ?? null,
      keep: async (id) => void (tabs.get(id)!.autoDiscardable = false),
      reload: async () => undefined,
      remove: async (id) => void tabs.delete(id),
      waitComplete: async () => true,
      group: async () => undefined,
    },
    scripting: {
      pageFetch: async (_tabId, request) => {
        const res = await send(request.url, request);
        if (res.status >= 300 && res.status < 400) return { kind: 'redirect' };
        if (Buffer.byteLength(res.body) > request.maxBytes) return { kind: 'too_large' };
        return { kind: 'ok', status: res.status, headers: JSON.stringify(Object.fromEntries(res.headers)), body: res.body, url: request.url };
      },
      inspect: async (tabId) => {
        const url = tabs.get(tabId)?.url ?? '';
        if (!/^https?:/.test(url)) return null;
        const res = await send(url);
        return { title: /<title>([^<]*)<\/title>/i.exec(res.body)?.[1] ?? '', url, text: res.body };
      },
    },
    debugger: {
      attach: async () => undefined,
      detach: async () => undefined,
      send: async () => {
        throw new Error('page_script non simulé');
      },
      onEvent: () => () => undefined,
    },
    permissions: { contains: async () => true },
    fetch: async (url, init) => {
      const res = await send(url, init);
      if (res.status >= 300 && res.status < 400) return { status: 0, url, redirected: true, headers: [], text: async () => '' };
      return { status: res.status, url, redirected: false, headers: res.headers, text: async (max) => (Buffer.byteLength(res.body) > max ? null : res.body) };
    },
  };
  return {
    api,
    calls,
    // Le propriétaire se connecte au site dans son navigateur (identifiants de la fixture) : le cookie reste dans le navigateur.
    login: async () => {
      const res = await fx.call(LOGIN, 'POST', '/login', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=zz_test_user&password=zz_test_pass' });
      cookie = String(res.headers['set-cookie']).split(';')[0] ?? null;
      return cookie!;
    },
    logout: () => {
      cookie = null;
    },
  };
}

async function insertApi(slug: string, opts: { networkPolicy?: unknown; requiresSession?: boolean } = {}): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, network_policy, requires_session, domain_pacing) VALUES ($1, $2, $3, $4, '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, owner.id, JSON.stringify(opts.networkPolicy ?? { allow: ['direct'] }), opts.requiresSession ?? false],
    )
  ).rows[0]!.id;
}

const actor = () => ({ userId: owner.id, role: 'member' as const });

async function settled(runId: string) {
  await vi.waitFor(async () => expect(['succeeded', 'failed', 'skipped_tunnel_offline']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 60_000,
    interval: 100,
  });
  return (await withActor(pool, actor(), (tx) => readRun(tx, runId)))!;
}

async function investigate(apiId: string, request: { url: string; description: string }) {
  const { runId } = await withActor(pool, actor(), (tx) => startInvestigation(tx, queue, { apiId, ownerId: owner.id, trigger: 'rest', request: { ...request, auto_validate: true } }));
  return settled(runId);
}

async function replay(apiId: string) {
  const { runId } = await withActor(pool, actor(), (tx) => createRun(tx, queue, { apiId, ownerId: owner.id, trigger: 'rest' }));
  return settled(runId);
}

const apiRow = async (apiId: string) =>
  (
    await pool.query<{ status: string; status_reason: string | null; current_strategy_version: number | null; output_schema: unknown }>(
      'SELECT status, status_reason, current_strategy_version, output_schema FROM apis WHERE id = $1',
      [apiId],
    )
  ).rows[0]!;
const apiSettled = (apiId: string, expected: Record<string, unknown>) => vi.waitFor(async () => expect(await apiRow(apiId)).toMatchObject(expected), { timeout: 10_000, interval: 50 });
const attemptsOf = async (runId: string) =>
  (await pool.query<{ execution: string; network: string; result_class: string }>('SELECT execution, network, result_class FROM run_attempts WHERE run_id = $1 ORDER BY seq', [runId])).rows;
const strategyOf = async (apiId: string) =>
  (await pool.query<{ execution: string; network: string; spec: { sources: { from: string; locator?: { kind: string } }[]; pagination?: { type: string } } }>('SELECT execution, network, spec FROM strategy_versions WHERE api_id = $1 ORDER BY version DESC LIMIT 1', [apiId])).rows[0]!;
const eventsOf = (runId: string) => listInvestigationEvents(pool, { runId, ownerId: owner.id });
const planOf = async (runId: string) => {
  const testing = (await eventsOf(runId)).find((e) => e.kind === 'phase.started' && (e.payload as { phase?: string }).phase === 'testing');
  return ((testing?.payload as { plan?: { execution: string; network: string }[] } | undefined)?.plan ?? []).map((p) => `${p.execution}/${p.network}`);
};
const itemsOf = async (datasetId: string | null) =>
  datasetId === null ? [] : (await withActor(pool, actor(), (tx) => tx.query<{ item: Record<string, unknown> }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [datasetId]))).rows.map((r) => r.item);
const hitsOf = async (host: string) => (await client.stats()).hosts[host]?.paths ?? {};
const tunnelJobs = async (runId: string) => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM tunnel_jobs WHERE run_id = $1', [runId])).rows[0]!.n;

/** Squelette scripté du rôle `investigate` : champs, puis chemin de chaque champ dans le gisement `c1`. */
const proposal = (fields: { name: string; type: string; personal?: boolean; path: string; ops?: string[] }[], pagination: Record<string, unknown>) => ({
  fields: fields.map((f) => ({ name: f.name, type: f.type, required: true, personal: f.personal ?? false, description: `Champ ${f.name}` })),
  sources: [{ candidate: 'c1', paths: fields.map((f) => ({ field: f.name, path: f.path, ops: f.ops ?? [] })), pagination: { param: null, start: null, has_more_path: null, next_path: null, ...pagination } }],
});
const pageParam = { type: 'page_param', param: 'url.query.page', start: 1, has_more_path: '$.has_more' };

beforeAll(async () => {
  client = await startClient();
  base = (host) => `http://${host}:${client.server.port}`;
  fake = await createFakeProvider();
  srv = await startTestServer('cases', { GATEWAY_INSTANCE: 'zz_test_gw_cases' });
  await srv.started.app.listen({ port: 0, host: '127.0.0.1' });
  const serverUrl = `http://127.0.0.1:${(srv.started.app.server.address() as AddressInfo).port}`;
  pool = createTestPool(srv.db.url, 8);
  await runSetup(srv);
  owner = await createUser(srv, 'zz_test_cases_owner@example.test');
  other = await createUser(srv, 'zz_test_cases_other@example.test');
  // Proxys de l'admin (centre de données et résidentiel) : ils servent à chiffrer les couples, aucun ne doit être essayé.
  await pool.query("INSERT INTO settings (key, value) VALUES ('proxies', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
    JSON.stringify([
      { id: 'zz_test_dc', type: 'dc', url: 'http://127.0.0.1:9', price: { per_gb_usd: 10 } },
      { id: 'zz_test_res', type: 'res', url: 'http://127.0.0.1:9', price: { per_gb_usd: 15 } },
    ]),
  ]);
  queue = new PgBossJobQueue({ connectionString: srv.db.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  tunnel = new TunnelJobClient({ pool, sessionUrl: srv.db.url, logger: silent, pollMs: 100, offlineGraceMs: 2500 });
  await tunnel.start();
  const guard = fixtureGuard(client.server.port, [BOOKS, SEARCH, LOGIN, CONTACTS, ACCOUNT], net);
  const pacer = new DomainPacer(new PgPacingStore(pool));
  const agent = {
    llmConfig: async () => llmConfig(),
    client: (config: LlmConfig) => createLlmClient(config),
    engineFor: () => () => null,
    agentBrowser: async (): Promise<never> => {
      throw new Error('zz_test : aucun navigateur');
    },
  };
  const instanceContact = async () => 'mailto:ops@zz-test.example';
  const strategy = createStrategyRuntime({ pool, guard, pacer, browsers: null, agent, tunnel, instanceContact, version: '9.9.9' });
  const investigation = createInvestigationExecutor({
    pool,
    guard,
    pacer,
    browsers: null,
    strategy,
    tunnel,
    llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) },
    agentic: true,
    instanceContact,
    version: '9.9.9',
  });
  const executor: RunExecutor = dispatchByKind({ run: strategy.executor, investigation });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: srv.db.url, MASTER_KEY: srv.masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '30', DISABLE_BROWSER: 'true' }),
    executor,
    logger: silent,
  });
  // Extensions appairées : celle du propriétaire (son navigateur, connecté au site) et celle d'un autre membre, connecté au
  // même site dans SON navigateur. Aucune commande ne doit jamais atteindre la seconde (INV5).
  browser = ownerBrowser(client);
  const pair = async (user: TestUser, handler: (frame: CommandFrame) => Promise<never> | ReturnType<TunnelExecutor['run']>) => {
    const { token, hash } = generateExtensionToken();
    await pool.query(`INSERT INTO tunnels (owner_id, device_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '90 days')`, [user.id, `zz_test_${randomUUID().slice(0, 8)}`, hash]);
    await pool.query('INSERT INTO site_sessions (owner_id, domain) VALUES ($1, $2)', [user.id, ACCOUNT]);
    const ext = new SimExtension(serverUrl, token, { handler });
    expect(await ext.welcome).toBe(true);
    return ext;
  };
  const ownerExecutor = new TunnelExecutor({ browser: browser.api, connectedDomains: async () => new Set([ACCOUNT]) });
  ownerExt = await pair(owner, (frame) => ownerExecutor.run(frame));
  otherExt = await pair(other, async () => {
    throw new Error('zz_test : commande routée vers l’extension d’un autre membre');
  });
}, 180_000);

afterAll(async () => {
  await ownerExt?.close();
  await otherExt?.close();
  await worker?.stop();
  await tunnel?.close();
  await queue?.stop({ timeoutMs: 1000 });
  await closeTestPool(pool);
  await srv?.close();
  await fake?.close();
  await client?.close();
});

beforeEach(async () => {
  fake.reset();
  await client.reset();
  browser.logout();
  browser.calls.length = 0;
});

describe('cas de référence en version fixtures, au niveau du worker (gate M2)', () => {
  test('assert_case_d0_fixture — D0 : catalogue rendu serveur paginé par rel=next → E1 sur N1 (données embarquées, next_link), rejeu de toutes les pages sans LLM ni proxy', async () => {
    fake.setScenario(MODEL, [
      scripted.json(
        proposal(
          [
            { name: 'sku', type: 'string', path: '$.sku' },
            { name: 'title', type: 'string', path: '$.title', ops: ['collapse_spaces'] },
            { name: 'price', type: 'number', path: '$.price' },
          ],
          { type: 'next_link' },
        ),
      ),
    ]);
    const apiId = await insertApi('zz_test_case_d0', { networkPolicy: { allow: ['direct', 'dc_proxy'] } });
    const run = await investigate(apiId, { url: `${base(BOOKS)}/`, description: 'Récupère les livres du catalogue, avec la pagination' });
    expect(run).toMatchObject({ state: 'succeeded', strategy_version: 1 });
    expect(await apiRow(apiId)).toMatchObject({ status: 'sain', current_strategy_version: 1 });
    // E1 (fetch) sur N1 (direct), gisement embarqué (__NEXT_DATA__), pagination par lien suivant ; le proxy n'a jamais servi.
    const sv = await strategyOf(apiId);
    expect(sv).toMatchObject({ execution: 'fetch', network: 'direct' });
    expect(sv.spec.sources[0]).toMatchObject({ from: 'embedded', locator: { kind: 'next_data' } });
    expect(sv.spec.pagination).toMatchObject({ type: 'next_link' });
    expect(await attemptsOf(run.id)).toEqual([{ execution: 'fetch', network: 'direct', result_class: 'ok' }]);
    expect(run.cost.proxy_usd).toBe(0);
    const finished = (await eventsOf(run.id)).filter((e) => e.kind === 'attempt.finished').map((e) => e.payload as { pagination?: { verified: boolean; stop: string | null; pages: number } });
    expect(finished[0]!.pagination).toEqual({ verified: true, stop: 'no_next', pages: 3 });

    // Rejeu : un run ordinaire parcourt les 3 pages et livre les 60 livres, conformes au schéma validé, sans appel LLM.
    await client.reset();
    const llmCalls = fake.requests;
    const again = await replay(apiId);
    expect(again).toMatchObject({ state: 'succeeded', items: 60, outcome: 'clean' });
    expect(again.attempts).toEqual([expect.objectContaining({ execution: 'fetch', network: 'direct', result: 'ok' })]);
    expect(fake.requests).toBe(llmCalls);
    const paths = await hitsOf(BOOKS);
    expect(paths['/']).toBe(1);
    expect(paths['/catalogue/page-2.html']).toBe(1);
    expect(paths['/catalogue/page-3.html']).toBe(1);
    const items = await itemsOf(again.dataset_id);
    expect(items).toHaveLength(60);
    const schema = (await apiRow(apiId)).output_schema;
    for (const item of items) expect(validateOutput(schema, item)).toEqual({ ok: true });
    expect(new Set(items.map((i) => i['sku'])).size).toBe(60);
  });

  test('assert_case_c1_fixture — C1 : recherche paginée dont la page 2 sert un défi → bloquee, arrêt de toute escalade : 0 essai proxy ni tunnel, rien après la détection', async () => {
    fake.setScenario(MODEL, [
      scripted.json(
        proposal(
          [
            { name: 'id', type: 'string', path: '$.id' },
            { name: 'titre', type: 'string', path: '$.title' },
            { name: 'prix', type: 'integer', path: '$.price_cents' },
            { name: 'ville', type: 'string', path: '$.city' },
          ],
          pageParam,
        ),
      ),
    ]);
    // Politique la plus large : direct, proxys de l'admin et tunnel (choix explicite de l'utilisateur, jamais proposé après un blocage).
    const apiId = await insertApi('zz_test_case_c1', { networkPolicy: { allow: ['direct', 'dc_proxy', 'res_proxy', 'tunnel'] } });
    const commandsBefore = ownerExt.received.length;
    const run = await investigate(apiId, { url: `${base(SEARCH)}/recherche?q=lampe`, description: 'Annonces depuis une URL de recherche, avec la pagination' });
    expect(run).toMatchObject({ state: 'failed', failure_class: 'blocked_by_protection', retryable: false });
    await apiSettled(apiId, { status: 'bloquee', status_reason: 'blocked_by_protection', current_strategy_version: null });
    // Le plan contenait les proxys et le tunnel ; seul le couple le moins cher a été essayé, puis tout a été élagué.
    const plan = await planOf(run.id);
    expect(plan[0]).toBe('fetch/direct');
    expect(plan.some((p) => p.endsWith('/res_proxy'))).toBe(true);
    expect(plan.some((p) => p.endsWith('/tunnel'))).toBe(true);
    expect(await attemptsOf(run.id)).toEqual([{ execution: 'fetch', network: 'direct', result_class: 'blocked_by_protection' }]);
    expect(run.cost.proxy_usd).toBe(0);
    expect(await tunnelJobs(run.id)).toBe(0);
    expect(ownerExt.received.length).toBe(commandsBefore);
    // Une seule requête sur la page du défi, aucune page au-delà ; aucun appel LLM après le schéma (ni réparation ni agent).
    const pages = JSON.parse((await client.control({ op: 'site', site: 'search_guarded', action: 'page_hits' })).body) as { result: Record<string, number> };
    expect(pages.result['2']).toBe(1);
    expect(Object.keys(pages.result).filter((p) => Number(p) > 2)).toEqual([]);
    expect(fake.requests).toBe(1);
    expect((await eventsOf(run.id)).map((e) => e.kind).at(-1)).toBe('investigation.finished');
  });

  test('assert_case_c2_fixture — C2 : API à session obligatoire → tunnel forcé : enquête et rejeu par l’extension du propriétaire seulement, avec SA session, jamais par le serveur', async () => {
    const session = await browser.login();
    fake.setScenario(MODEL, [
      scripted.json(
        proposal(
          [
            { name: 'id', type: 'string', path: '$.id' },
            { name: 'auteur', type: 'string', personal: true, path: '$.author' },
            { name: 'profil_url', type: 'string', personal: true, path: '$.profile_url' },
            { name: 'texte', type: 'string', path: '$.text' },
          ],
          pageParam,
        ),
      ),
    ]);
    // Politique par défaut (direct seul) : l'identité requise suffit à forcer le tunnel (04 §3.2), sans réglage de l'utilisateur.
    const apiId = await insertApi('zz_test_case_c2', { requiresSession: true });
    const otherBefore = otherExt.received.length;
    const run = await investigate(apiId, { url: `${base(ACCOUNT)}/post/zz_test_post_0001`, description: 'Tous les commentaires de ce post' });
    expect(run).toMatchObject({ state: 'succeeded', strategy_version: 1 });
    expect(await planOf(run.id)).not.toHaveLength(0);
    expect((await planOf(run.id)).every((p) => p.endsWith('/tunnel'))).toBe(true);
    expect((await attemptsOf(run.id)).every((a) => a.network === 'tunnel')).toBe(true);
    expect(await strategyOf(apiId)).toMatchObject({ execution: 'fetch', network: 'tunnel' });
    const schema = (await apiRow(apiId)).output_schema as { properties: Record<string, { 'x-personal'?: boolean }> };
    expect(schema.properties['auteur']?.['x-personal']).toBe(true);

    const replayed = await replay(apiId);
    expect(replayed).toMatchObject({ state: 'succeeded', items: 25 });
    expect(replayed.attempts).toEqual([expect.objectContaining({ execution: 'fetch', network: 'tunnel', result: 'ok', cost_usd: 0 })]);
    // Commandes routées vers l'extension du propriétaire, jamais vers celle de l'autre membre connecté au même site.
    const jobs = await pool.query<{ owner_id: string }>('SELECT DISTINCT owner_id FROM tunnel_jobs WHERE run_id = ANY($1)', [[run.id, replayed.id]]);
    expect(jobs.rows).toEqual([{ owner_id: owner.id }]);
    expect(otherExt.received.length).toBe(otherBefore);
    // Toutes les requêtes vers le site sont passées par le navigateur du propriétaire, avec sa session ; aucune par le serveur.
    expect(browser.calls.length).toBeGreaterThan(0);
    expect(browser.calls.every((c) => c.cookie)).toBe(true);
    expect((await client.stats()).hosts[ACCOUNT]).toBeUndefined();
    expect((await hitsOf(LOGIN))['/api/posts/zz_test_post_0001/comments']).toBeGreaterThanOrEqual(3);
    // Le cookie reste dans le navigateur (usage tunnel, 07 §2) : rien en base, ni chiffré ni en clair.
    expect((await pool.query('SELECT count(*)::int AS n FROM site_sessions WHERE ciphertext IS NOT NULL')).rows[0]).toEqual({ n: 0 });
    const token = session.split('=')[1]!;
    for (const [table, column] of [['investigation_events', 'payload'], ['run_logs', 'data'], ['dataset_items', 'item']] as const) {
      const exists = (await pool.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table])).rows[0]!.ok;
      if (!exists) continue;
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}::text LIKE $1`, [`%${token}%`])).rows[0], table).toEqual({ n: 0 });
    }
  });

  test('assert_case_c3_fixture — C3 : « mes contacts » : publique → E1 sur N1 sans proxy ; derrière une connexion non connectée → action_requise sans escalade ; site connecté → E1 en tunnel, sans proxy', async () => {
    const contactFields = [
      { name: 'id', type: 'string', path: '$.id' },
      { name: 'nom', type: 'string', personal: true, path: '$.name', ops: ['trim'] },
      { name: 'email', type: 'string', personal: true, path: '$.email', ops: ['lower'] },
    ];
    const everyNetwork = { allow: ['direct', 'dc_proxy', 'res_proxy'] };

    // 1. Page publique : E1 sur N1, les proxys autorisés ne servent jamais.
    fake.setScenario(MODEL, [scripted.json(proposal(contactFields, pageParam))]);
    const publicApi = await insertApi('zz_test_case_c3_public', { networkPolicy: everyNetwork });
    const pub = await investigate(publicApi, { url: `${base(CONTACTS)}/`, description: 'Scrape entièrement la page mes contacts' });
    expect(pub).toMatchObject({ state: 'succeeded', strategy_version: 1 });
    expect(await strategyOf(publicApi)).toMatchObject({ execution: 'fetch', network: 'direct' });
    expect((await attemptsOf(pub.id)).every((a) => a.network === 'direct')).toBe(true);
    expect(pub.cost.proxy_usd).toBe(0);
    const pubReplay = await replay(publicApi);
    expect(pubReplay).toMatchObject({ state: 'succeeded', items: 500 });
    expect(pubReplay.attempts).toEqual([expect.objectContaining({ execution: 'fetch', network: 'direct', result: 'ok' })]);
    expect(pubReplay.cost.proxy_usd).toBe(0);

    // 2. Derrière une connexion, site non connecté : la main revient à l'utilisateur (auth_required), aucun proxy ni tunnel.
    fake.reset();
    fake.setScenario(MODEL, [scripted.json(proposal(contactFields, pageParam))]);
    const lockedApi = await insertApi('zz_test_case_c3_locked', { networkPolicy: everyNetwork });
    const locked = await investigate(lockedApi, { url: `${base(LOGIN)}/contacts`, description: 'Scrape entièrement la page mes contacts' });
    expect(locked).toMatchObject({ state: 'failed', failure_class: 'auth_required', retryable: false });
    await apiSettled(lockedApi, { status: 'action_requise', status_reason: 'auth_required' });
    expect((await attemptsOf(locked.id)).filter((a) => a.network !== 'direct')).toEqual([]);
    expect(locked.cost.proxy_usd).toBe(0);
    expect(await tunnelJobs(locked.id)).toBe(0);

    // 3. Site connecté dans l'extension (usage par défaut : les cookies restent dans le navigateur) : E1 en tunnel, sans proxy.
    await browser.login();
    fake.reset();
    fake.setScenario(MODEL, [scripted.json(proposal(contactFields, pageParam))]);
    const connectedApi = await insertApi('zz_test_case_c3_connected', { requiresSession: true, networkPolicy: everyNetwork });
    const connected = await investigate(connectedApi, { url: `${base(ACCOUNT)}/contacts`, description: 'Scrape entièrement la page mes contacts' });
    expect(connected).toMatchObject({ state: 'succeeded', strategy_version: 1 });
    expect(await strategyOf(connectedApi)).toMatchObject({ execution: 'fetch', network: 'tunnel' });
    expect((await attemptsOf(connected.id)).every((a) => a.network === 'tunnel')).toBe(true);
    const again = await replay(connectedApi);
    expect(again).toMatchObject({ state: 'succeeded', items: 30 });
    expect(again.cost.proxy_usd).toBe(0);
    const items = await itemsOf(again.dataset_id);
    expect(items.every((i) => typeof i['email'] === 'string' && i['email'] === String(i['email']).toLowerCase())).toBe(true);
    expect(browser.calls.every((c) => c.cookie)).toBe(true);
  });
});
