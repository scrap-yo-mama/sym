// SPDX-License-Identifier: AGPL-3.0-only
// Lot A du CDC UX (parcours MCP « du premier coup », 03-specs-mcp) sur la pile réelle : serveur (MCP + REST), vrai worker,
// vrai exécuteur d'enquête, faux fournisseur LLM et sites de fixtures. Un client MCP officiel ne suit que `next_action`.
// - assert_first_try_mcp : liste paginée de 52 pages (519 biens) → 519 éléments en 3 appels d'outil au plus, aucun validate_schema ;
// - assert_schema_question_only_if_ambiguous : 0 question sur les cas de fixtures non ambigus, exactement 1 question fermée
//   sur chacune des 3 fixtures ambiguës (listes multiples, champ demandé absent, exemple en désaccord) ;
// - assert_cost_announced_before_spend : au-delà de CONFIRM_ABOVE_USD, la confirmation précède tout essai facturé.
import type { AddressInfo } from 'node:net';
import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLogger, DomainPacer, Secret, type RunExecutor } from '@runtime/core';
import { analyzeCapture, type DataCandidate } from '@runtime/core/investigation';
import * as net from '@runtime/core/net';
import { PgBossJobQueue, PgPacingStore, runQueueDefinition } from '@runtime/db';
import { createLlmClient, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadWorkerConfig } from '../../worker/src/config.js';
import { createInvestigationExecutor, dispatchByKind } from '../../worker/src/exec/investigation-executor.js';
import { createStrategyRuntime } from '../../worker/src/exec/strategy-executor.js';
import { TunnelJobClient } from '../../worker/src/tunnel/client.js';
import { startWorker, type Worker } from '../../worker/src/worker.js';
import { startClient, type Client } from '../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../tests/helpers/fixture-net.js';
import { closeTestPool, createTestPool, withClient } from '../../../tests/helpers/pg.js';
import { createKey, createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';

const HTML_LIST = 'zz_test_html_list.localhost';
const TWO_LISTS = 'zz_test_two_lists.localhost';
const BOOKS = 'zz_test_books.localhost';
const CATALOGUE = 'zz_test_catalogue_pages.localhost';
const MODEL = 'zz_investigate';
const silent = createLogger({ name: 'zz_test', level: 'fatal' });
const SCOPES = ['apis:read', 'apis:run', 'apis:write', 'runs:read', 'datasets:read'];

type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

let srv: TestServer;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let worker: Worker;
let tunnel: TunnelJobClient;
let client: Client;
let fake: FakeProvider;
let owner: TestUser;
let ownerCookie: string;
let key: string;
let mcpBase: string;
let mcp: McpClient;
/** Seuil `CONFIRM_ABOVE_USD` du worker de ce test : absent (aucune porte de coût) sauf dans le test qui l'exige. */
const confirmAbove: { value: number | undefined } = { value: undefined };
/** Seuil `CONFIRM_ABOVE_USD` du serveur (porte de coût du premier run complet), rétabli avant chaque test. */
const DEFAULT_CONFIRM_ABOVE = 0.1;
const base = (host: string) => `http://${host}:${client.server.port}`;

const llmConfig = (): LlmConfig => ({
  providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }],
  roles: { investigate: { provider: 'fake', model: MODEL } },
});

/** Gisement `dom` de la page servie, tel que le voit la reconnaissance statique du worker (DISABLE_BROWSER). */
async function domOf(host: string, path: string): Promise<{ url: string; dom: DataCandidate }> {
  const url = `${base(host)}${path}`;
  const html = (await client.get(host, path)).body;
  const candidates = analyzeCapture({ mode: 'static', pageUrl: url, document: { url, status: 200, html, renderedHtml: null, bytes: html.length }, exchanges: [], totalBytes: html.length }, [host]);
  return { url, dom: candidates.find((c) => c.from === 'dom')! };
}

/** Tous les gisements d'une page, tels que les voit la reconnaissance statique du worker (un par tableau de données embarqué). */
async function candidatesOf(host: string, path: string): Promise<{ url: string; candidates: DataCandidate[] }> {
  const url = `${base(host)}${path}`;
  const html = (await client.get(host, path)).body;
  return { url, candidates: analyzeCapture({ mode: 'static', pageUrl: url, document: { url, status: 200, html, renderedHtml: null, bytes: html.length }, exchanges: [], totalBytes: html.length }, [host]) };
}

const slotIn = (dom: DataCandidate, pred: (description: string) => boolean): string => {
  const hit = Object.entries(dom.skeleton).find(([, d]) => pred(d));
  if (hit === undefined) throw new Error(`zz_test : aucun emplacement dans ${JSON.stringify(dom.skeleton)}`);
  return hit[0];
};

/** Proposition scriptée de la liste de biens (constat Janssens) : le faux LLM relie les champs aux emplacements. */
function bienProposal(dom: DataCandidate, extra: Record<string, unknown> = {}) {
  const field = (name: string, type: string, path: string) => ({ name, type, required: true, personal: false, description: `Field ${name}`, path });
  const fields = [
    field('url', 'string', slotIn(dom, (d) => d.startsWith('link'))),
    field('reference', 'string', slotIn(dom, (d) => d.startsWith('attribute data-ref'))),
    field('title', 'string', '$.h3'),
    field('postal_code', 'string', slotIn(dom, (d) => d.includes('paren_code'))),
    field('surface_m2', 'number', slotIn(dom, (d) => d.includes('shape=area'))),
    field('bedrooms', 'integer', slotIn(dom, (d) => d.includes('number_with_unit'))),
    field('price_eur', 'number', slotIn(dom, (d) => d.includes('money'))),
  ];
  return {
    names: fields.map((f) => f.name),
    proposal: {
      fields: fields.map(({ path: _path, ...f }) => f),
      sources: [{ candidate: dom.id, paths: fields.map((f) => ({ field: f.name, path: f.path, ops: [] })), pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null } }],
      ...extra,
    },
  };
}

/** Appels d'outils du client, dans l'ordre : le critère « 3 appels au plus » les compte. */
const calls: string[] = [];
async function tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  calls.push(name);
  return (await mcp.callTool({ name, arguments: args })) as ToolResult;
}
const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');

/** Le client ne suit que `next_action` tant que SYM travaille (`get_run`, attente tenue côté serveur). */
async function followToEnd(first: ToolResult, maxCalls = 12): Promise<ToolResult> {
  let result = first;
  for (let i = 0; i < maxCalls; i += 1) {
    const sc = result.structuredContent ?? {};
    const next = sc['next_action'] as { tool: string; args: Record<string, unknown> } | null | undefined;
    const state = sc['state'];
    if (result.isError === true || state === 'succeeded' || state === 'failed' || state === 'awaiting_decision' || state === 'blocked' || state === 'action_required') return result;
    if (next === null || next === undefined || next.tool !== 'get_run') return result;
    result = await tool(next.tool, { ...next.args, wait_seconds: 50 });
  }
  return result;
}

beforeAll(async () => {
  client = await startClient();
  fake = await createFakeProvider();
  srv = await startTestServer(
    'first_try',
    { GATEWAY_INSTANCE: 'zz_test_gw_first', MAX_WAIT_SECONDS: '50', MAX_CONCURRENT_RUNS: '1000', MAX_ACTIVE_RUNS_PER_USER: '1000', MAX_RUNS_PER_KEY_PER_MINUTE: '1000', MCP_ALLOWED_HOSTS: '127.0.0.1' },
    { rest: { pollMs: 50 } },
  );
  // Sites de fixtures sur la boucle locale : pas d'attente de politesse de 1,5 s entre deux pages (52 pages).
  await withClient(srv.db.url, (c) => c.query(`ALTER TABLE apis ALTER COLUMN domain_pacing SET DEFAULT '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}'`));
  mcpBase = await srv.started.app.listen({ port: 0, host: '127.0.0.1' });
  const serverUrl = `http://127.0.0.1:${(srv.started.app.server.address() as AddressInfo).port}`;
  pool = createTestPool(srv.db.url, 8);
  const setup = await runSetup(srv);
  ownerCookie = await signIn(srv, setup);
  await srv.app.inject({ method: 'PUT', url: '/api/settings/identity', headers: { cookie: ownerCookie, origin: PUBLIC_URL }, payload: { instance_contact: 'ops@zz-test.example' } });
  owner = await createUser(srv, 'zz_test_first_try@example.test');
  const cookie = await signIn(srv, owner);
  key = (await createKey(srv, cookie, owner, SCOPES)).key;
  await pool.query("INSERT INTO responsible_use_acks (user_id, version) VALUES ($1, '2026-10-01') ON CONFLICT DO NOTHING", [owner.id]);
  queue = new PgBossJobQueue({ connectionString: srv.db.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  tunnel = new TunnelJobClient({ pool, sessionUrl: srv.db.url, logger: silent, pollMs: 100, offlineGraceMs: 2500 });
  await tunnel.start();
  const guard = fixtureGuard(client.server.port, [HTML_LIST, TWO_LISTS, BOOKS, CATALOGUE], net);
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
    get confirmAboveUsd() {
      return confirmAbove.value;
    },
  });
  const executor: RunExecutor = dispatchByKind({ run: strategy.executor, investigation });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: srv.db.url, MASTER_KEY: srv.masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '30', DISABLE_BROWSER: 'true' }),
    executor,
    logger: silent,
  });
  void serverUrl;
  mcp = new McpClient({ name: 'zz-test-client', version: '1.0.0' }, {});
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), { authProvider: { token: async () => key } }));
}, 180_000);

afterAll(async () => {
  await mcp?.close().catch(() => undefined);
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
  calls.length = 0;
  confirmAbove.value = undefined;
  srv.started.ctx.confirmAboveUsd = DEFAULT_CONFIRM_ABOVE;
});

describe('parcours MCP du premier coup (lot A, 03-specs-mcp)', () => {
  test('assert_first_try_mcp — liste paginée de 52 pages et faux LLM : create_api puis next_action donnent 519 éléments en 3 appels au plus, sans validate_schema', async () => {
    const { url, dom } = await domOf(HTML_LIST, '/nos-maisons/');
    const { names, proposal } = bienProposal(dom);
    fake.setScenario(MODEL, [scripted.json(proposal), scripted.json({ fields: names.map((name) => ({ name, verdict: 'ok' })) })]);
    const first = await tool('create_api', { description: 'Liste des biens de cette page, toutes les pages, sans ouvrir les fiches', url });
    expect(first.isError, text(first)).not.toBe(true);
    const done = await followToEnd(first);
    expect(done.isError, text(done)).not.toBe(true);
    expect(done.structuredContent).toMatchObject({ state: 'succeeded', items_total: 519, existing: false });
    expect((done.structuredContent!['items_preview'] as unknown[]).length).toBe(10);
    // Le premier run complet (les 52 pages) est celui de SYM, lancé après l'enquête : ses éléments sont ceux rendus.
    expect(typeof done.structuredContent!['first_run_id']).toBe('string');
    expect(typeof done.structuredContent!['items_cursor']).toBe('string');
    expect(String(done.structuredContent!['console_url'])).toContain(`/apis/${String(done.structuredContent!['slug'])}`);
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(calls).not.toContain('validate_schema');
    // Le texte seul suffit : un client qui n'affiche que `content` montre le total et un tableau d'aperçu.
    expect(text(done)).toContain('519');
    expect(text(done)).toMatch(/\|.*\|/);
  }, 120_000);

  /** Faux LLM d'une page de biens : la proposition (avec ses ajouts), puis le juge de fidélité du contrôle déterministe. */
  const scriptHtmlList = async (extra: Record<string, unknown> = {}) => {
    const { url, dom } = await domOf(HTML_LIST, '/nos-maisons/');
    const { names, proposal } = bienProposal(dom, extra);
    fake.setScenario(MODEL, [scripted.json(proposal), scripted.json({ fields: names.map((name) => ({ name, verdict: 'ok' })) })]);
    return url;
  };
  const DESCRIPTION = 'Liste des biens de cette page, toutes les pages, sans ouvrir les fiches';
  const questionOf = (r: ToolResult) => r.structuredContent?.['question'] as { reason: string; text: string; options: { id: string; label: string }[] } | undefined;
  const runsOf = async () => Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM runs WHERE owner_id = $1 AND kind = 'investigation'", [owner.id])).rows[0]!.n);

  test('assert_schema_question_only_if_ambiguous — 0 question sur les cas non ambigus ; exactement 1 question fermée sur chacune des 3 fixtures ambiguës, et « continuer » livre les éléments', async () => {
    // Cas non ambigus : aucune question, les éléments arrivent sans validate_schema.
    const url = await scriptHtmlList();
    const plain = await followToEnd(await tool('create_api', { description: DESCRIPTION, url, force_new: true }));
    expect(plain.structuredContent).toMatchObject({ state: 'succeeded', items_total: 519 });
    expect(plain.structuredContent).not.toHaveProperty('question');
    // Le modèle affirme une seconde liste inexistante : le code ne trouve rien à vérifier, aucune question (l'affirmation seule ne suffit pas).
    fake.reset();
    const bogus = await scriptHtmlList({ other_lists: ['c1'], unmatched_fields: ['title'] });
    const refused = await followToEnd(await tool('create_api', { description: `${DESCRIPTION} bis`, url: bogus, force_new: true }));
    expect(refused.structuredContent).toMatchObject({ state: 'succeeded', items_total: 519 });
    expect(refused.structuredContent).not.toHaveProperty('question');

    // 1. champ demandé absent.
    fake.reset();
    const missingUrl = await scriptHtmlList({ unmatched_fields: ['agency'] });
    const before = await runsOf();
    const missing = await tool('create_api', { description: `${DESCRIPTION} avec agence`, url: missingUrl, force_new: true });
    expect(missing.isError, text(missing)).not.toBe(true);
    expect(missing.structuredContent).toMatchObject({ state: 'awaiting_decision', question: { reason: 'requested_field_missing' }, next_action: { tool: 'validate_schema' } });
    expect(questionOf(missing)!.options.map((o) => o.id)).toEqual(['continue', 'look_details']);
    expect(text(missing)).toContain('agency');
    expect(await runsOf()).toBe(before + 1);
    // « continuer sans » : les essais partent, les éléments arrivent.
    const apiId = String(missing.structuredContent!['api_id']);
    const carried = await followToEnd(await tool('validate_schema', { api_id: apiId, choice: 'continue' }));
    expect(carried.structuredContent).toMatchObject({ state: 'succeeded', items_total: 519 });

    // 2. exemple en désaccord.
    fake.reset();
    const exampleUrl = await scriptHtmlList();
    const mismatch = await tool('create_api', { description: `${DESCRIPTION} avec exemple`, url: exampleUrl, example_output: { title: 'x', agency: 'y' }, force_new: true });
    expect(mismatch.structuredContent).toMatchObject({ state: 'awaiting_decision', question: { reason: 'example_mismatch' } });
    expect(questionOf(mismatch)!.options.map((o) => o.id)).toEqual(['continue', 'other']);
    expect(text(mismatch)).toContain('agency');

    // 3. deux listes comparables (à vendre, vendus) dans les données de la page : une question, les deux listes chiffrées.
    fake.reset();
    const { url: twoUrl, candidates: found } = await candidatesOf(TWO_LISTS, '/biens/');
    const lists2 = found.filter((c) => c.from === 'embedded');
    expect(lists2.map((c) => c.count).sort()).toEqual([10, 12]);
    const sale = lists2.find((c) => c.count === 12)!;
    const sold = lists2.find((c) => c.count === 10)!;
    const field = (name: string, type: string, path: string) => ({ name, type, required: true, personal: false, description: `Field ${name}`, path });
    const fields = [field('reference', 'string', '$.reference'), field('title', 'string', '$.title'), field('price_eur', 'number', '$.price'), field('surface_m2', 'number', '$.surface')];
    fake.setScenario(MODEL, [
      scripted.json({
        fields: fields.map(({ path: _path, ...f }) => f),
        sources: [{ candidate: sale.id, paths: fields.map((f) => ({ field: f.name, path: f.path, ops: [] })), pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null } }],
        other_lists: [sold.id],
      }),
      scripted.json({ fields: fields.map((f) => ({ name: f.name, verdict: 'ok' })) }),
    ]);
    const lists = await tool('create_api', { description: 'Les biens de cette page', url: twoUrl, force_new: true });
    expect(lists.structuredContent).toMatchObject({ state: 'awaiting_decision', question: { reason: 'multiple_lists' } });
    expect(questionOf(lists)!.options).toMatchObject([{ id: 'continue', expected_items: 12 }, { id: 'other_list', expected_items: 10 }]);
    // Une réponse hors de la liste d'options est refusée, rien n'est lancé.
    const countBefore = await runsOf();
    const wrong = await tool('validate_schema', { api_id: String(lists.structuredContent!['api_id']), choice: 'nimporte' });
    expect(wrong.isError).toBe(true);
    expect(await runsOf()).toBe(countBefore);
    const chosen = await followToEnd(await tool('validate_schema', { api_id: String(lists.structuredContent!['api_id']), choice: 'continue' }));
    expect(chosen.structuredContent).toMatchObject({ state: 'succeeded', items_total: 12 });
  }, 240_000);

  test('assert_cost_announced_before_spend — au-delà de CONFIRM_ABOVE_USD, la confirmation précède tout essai : aucun essai ni appel au modèle de plus avant la réponse', async () => {
    const url = await scriptHtmlList();
    confirmAbove.value = 1e-9;
    const asked = await tool('create_api', { description: `${DESCRIPTION} (coût)`, url, force_new: true });
    expect(asked.isError, text(asked)).not.toBe(true);
    expect(asked.structuredContent).toMatchObject({ state: 'awaiting_decision', question: { reason: 'cost_above_cap' }, next_action: { tool: 'validate_schema' } });
    expect(questionOf(asked)!.options.map((o) => o.id)).toEqual(['continue', 'cancel']);
    const apiId = String(asked.structuredContent!['api_id']);
    // Avant la confirmation : l'appel `investigate` seul, ni essai ni exécution de stratégie, rien de facturé au-delà de la reconnaissance.
    expect(fake.requests).toBe(1);
    expect((await pool.query<{ n: string }>('SELECT count(*) AS n FROM run_attempts WHERE run_id IN (SELECT id FROM runs WHERE api_id = $1)', [apiId])).rows[0]!.n).toBe('0');
    // « Ne rien lancer » : aucun run de plus.
    const runs = await runsOf();
    const declined = await tool('validate_schema', { api_id: apiId, choice: 'cancel' });
    expect(declined.isError, text(declined)).not.toBe(true);
    expect(await runsOf()).toBe(runs);
    expect(fake.requests).toBe(1);
    // Sans `choice`, jamais de « continue » par défaut : la question reste posée, aucun essai ne part (UXI9).
    const attemptsBefore = (await pool.query<{ n: string }>('SELECT count(*) AS n FROM run_attempts WHERE run_id IN (SELECT id FROM runs WHERE api_id = $1)', [apiId])).rows[0]!.n;
    const noChoice = await tool('validate_schema', { api_id: apiId });
    expect(noChoice.isError, text(noChoice)).toBe(true);
    expect(await runsOf()).toBe(runs);
    expect((await pool.query<{ n: string }>('SELECT count(*) AS n FROM run_attempts WHERE run_id IN (SELECT id FROM runs WHERE api_id = $1)', [apiId])).rows[0]!.n).toBe(attemptsBefore);
    expect(fake.requests).toBe(1);
    // « Lancer » : les essais partent, les 519 éléments arrivent.
    const confirmed = await followToEnd(await tool('validate_schema', { api_id: apiId, choice: 'continue' }));
    expect(confirmed.structuredContent).toMatchObject({ state: 'succeeded', items_total: 519 });
  }, 120_000);
  const ordinaryRuns = async (apiId: string) => Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM runs WHERE api_id = $1 AND kind = 'run'", [apiId])).rows[0]!.n);

  test('assert_get_run_read_only — get_run (et get_run avec wait_seconds) d’une enquête réussie ne lance jamais de run complet, même dans les 15 minutes de sa fin', async () => {
    const url = await scriptHtmlList();
    // Enquête créée en REST (sans le drapeau de l'outil d'écriture) : le premier run complet n'a pas été demandé.
    const created = await srv.app.inject({ method: 'POST', url: '/api/apis?wait=0', headers: { authorization: `Bearer ${key}` }, payload: { description: `${DESCRIPTION} (lecture)`, url } });
    expect(created.statusCode, created.body).toBe(201);
    const { api_id: apiId, run_id: runId } = created.json<{ api_id: string; run_id: string }>();
    for (let i = 0; i < 200; i += 1) {
      const state = (await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state;
      if (state === 'succeeded') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const read = await tool('get_run', { run_id: runId });
    expect(read.isError, text(read)).not.toBe(true);
    const held = await tool('get_run', { run_id: runId, wait_seconds: 2 });
    expect(held.isError, text(held)).not.toBe(true);
    expect(await ordinaryRuns(apiId)).toBe(0);
    expect(held.structuredContent).not.toHaveProperty('first_run_id');
  }, 120_000);

  test('assert_cost_announced_before_spend — le premier run complet au-delà de CONFIRM_ABOVE_USD attend une confirmation explicite : sans choice rien ne part, cancel ne lance rien, continue lance', async () => {
    srv.started.ctx.confirmAboveUsd = 1e-9;
    const url = await scriptHtmlList();
    const asked = await tool('create_api', { description: `${DESCRIPTION} (premier run coûteux)`, url, force_new: true });
    expect(asked.isError, text(asked)).not.toBe(true);
    expect(asked.structuredContent).toMatchObject({ state: 'awaiting_decision', question: { reason: 'cost_above_cap' }, next_action: { tool: 'validate_schema' } });
    expect(asked.structuredContent!['next_action']).not.toHaveProperty('args.choice');
    expect(questionOf(asked)!.options.map((o) => o.id)).toEqual(['continue', 'cancel']);
    const apiId = String(asked.structuredContent!['api_id']);
    expect(await ordinaryRuns(apiId)).toBe(0);
    // Un client qui suit next_action à la lettre (sans choice) n'engage aucune dépense.
    const noChoice = await tool('validate_schema', { api_id: apiId });
    expect(noChoice.isError, text(noChoice)).toBe(true);
    expect(await ordinaryRuns(apiId)).toBe(0);
    // get_run reste une lecture : la question demeure, rien ne part.
    const read = await tool('get_run', { run_id: String(asked.structuredContent!['run_id']), wait_seconds: 1 });
    expect(read.structuredContent).toMatchObject({ state: 'awaiting_decision', question: { reason: 'cost_above_cap' } });
    expect(await ordinaryRuns(apiId)).toBe(0);
    // Confirmée : le premier run complet livre les 519 éléments.
    const confirmed = await followToEnd(await tool('validate_schema', { api_id: apiId, choice: 'continue' }));
    expect(confirmed.structuredContent).toMatchObject({ state: 'succeeded', items_total: 519 });
    expect(await ordinaryRuns(apiId)).toBe(1);
  }, 180_000);

  test('assert_cost_announced_before_spend — « ne rien lancer » sur la porte de coût du premier run complet ne lance aucun run, et la demande reste levée', async () => {
    srv.started.ctx.confirmAboveUsd = 1e-9;
    const url = await scriptHtmlList();
    const asked = await tool('create_api', { description: `${DESCRIPTION} (refus)`, url, force_new: true });
    const apiId = String(asked.structuredContent!['api_id']);
    expect(asked.structuredContent).toMatchObject({ state: 'awaiting_decision', question: { reason: 'cost_above_cap' } });
    const declined = await tool('validate_schema', { api_id: apiId, choice: 'cancel' });
    expect(declined.isError, text(declined)).not.toBe(true);
    expect(await ordinaryRuns(apiId)).toBe(0);
    srv.started.ctx.confirmAboveUsd = DEFAULT_CONFIRM_ABOVE;
    const read = await tool('get_run', { run_id: String(asked.structuredContent!['run_id']), wait_seconds: 1 });
    expect(read.isError, text(read)).not.toBe(true);
    expect(await ordinaryRuns(apiId)).toBe(0);
  }, 120_000);
});
