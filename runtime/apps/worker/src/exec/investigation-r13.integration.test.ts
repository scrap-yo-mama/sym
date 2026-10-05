// SPDX-License-Identifier: AGPL-3.0-only
// Banc de cas réels, R13 (Barnes, constat du 2026-10-05), de bout en bout sur base réelle (file → worker → exécuteur
// d'enquête), faux fournisseur LLM, sites de test locaux à hôtes virtuels, sans navigateur :
// - complétude : la page affiche « 100 annonces » mais n'en sert que 24 (la suite est derrière un bouton « charger plus »
//   en XHR, invisible sans navigateur) ; l'essai `fetch` qui livre 24 éléments n'est PAS conforme (`incomplete_vs_counter`,
//   compteur et livrés dans le motif), jamais « sain » ;
// - liste paginée dont le compteur concorde : conforme, complétude dite dans le récit, plafond de requêtes d'un run relevé
//   au nombre de pages annoncé (jamais abaissé) ;
// - D-124 : l'événement de reconnaissance porte, par source, son identifiant, son type, son compteur et un aperçu.
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey, Secret, type RunExecutor } from '@runtime/core';
import { analyzeCapture } from '@runtime/core/investigation';
import * as net from '@runtime/core/net';
import { listInvestigationEvents, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, startInvestigation, withActor } from '@runtime/db';
import { createLlmClient, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { loadWorkerConfig } from '../config.js';
import { startMiniSite, type MiniSite } from '../testing/mini-site.testkit.js';
import { startWorker, type Worker } from '../worker.js';
import { createInvestigationExecutor, dispatchByKind } from './investigation-executor.js';
import { createStrategyRuntime } from './strategy-executor.js';

/** Liste de 24 cartes, compteur « 100 annonces », suite derrière un bouton « charger plus » (XHR). */
const LOADMORE = 'zz_test_loadmore.localhost';
/** Liste paginée `?page=N` de 3 pages de 10 cartes, compteur « 30 annonces ». */
const PAGED = 'zz_test_pagedcount.localhost';
const HOSTS = [LOADMORE, PAGED];
const MODEL = 'zz_investigate';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let site: MiniSite;
let worker: Worker;
let fake: FakeProvider;

const card = (i: number) => `<article class="zz-bien"><h2 class="zz-titre"><a href="/biens/zz-${i}.html">Maison Zztest numéro ${i}</a></h2><p class="zz-ville">Zzville ${i % 5}</p><p class="zz-prix">${(300000 + i * 1000).toLocaleString('fr-FR').replace(/\u202f/g, ' ')} €</p></article>`;
const loadMorePage = () =>
  `<!doctype html><html><body><main><p class="zz-compteur">100 annonces</p><section id="zz-resultats">${Array.from({ length: 24 }, (_, k) => card(k + 1)).join('\n')}</section><a href="javascript:suite()" id="zz-suite">Annonces suivantes</a></main></body></html>`;
const pagedPage = (n: number) =>
  `<!doctype html><html><body><main><p class="zz-compteur">30 annonces</p><section id="zz-resultats">${Array.from({ length: 10 }, (_, k) => card((n - 1) * 10 + k + 1)).join('\n')}</section><nav class="zz-pages"></nav><ul class="pagination">${[1, 2, 3].map((p) => `<li><a href="/annonces/?page=${p}">${p}</a></li>`).join('')}${n < 3 ? `<li><a href="/annonces/?page=${n + 1}" rel="next">Suivant</a></li>` : ''}</ul></main></body></html>`;

function llmConfig(): LlmConfig {
  return { providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }], roles: { investigate: { provider: 'fake', model: MODEL } } };
}

/** Proposition du faux LLM : les emplacements du bloc tels que la reconnaissance les nomme (lien, titre, prix). */
function proposalFor(html: string, url: string) {
  const host = new URL(url).hostname;
  const dom = analyzeCapture({ mode: 'static', pageUrl: url, document: { url, status: 200, html, renderedHtml: null, bytes: html.length }, exchanges: [], totalBytes: html.length }, [host]).find((c) => c.from === 'dom')!;
  const slot = (pred: (s: (typeof dom.dom & object)['slots'][number]) => boolean) => `$.${dom.dom!.slots.find(pred)!.name}`;
  return {
    fields: [
      { name: 'url', type: 'string', required: true, personal: false, description: 'Listing URL' },
      { name: 'title', type: 'string', required: true, personal: false, description: 'Title' },
      { name: 'price_eur', type: 'number', required: false, personal: false, description: 'Price in euros' },
    ],
    sources: [
      {
        candidate: 'c1',
        paths: [
          { field: 'url', path: slot((s) => s.attr === 'href'), ops: [] },
          { field: 'title', path: slot((s) => s.attr === 'text' && s.tag === 'a'), ops: [] },
          { field: 'price_eur', path: slot((s) => s.shape.startsWith('money')), ops: [] },
        ],
        pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null },
      },
    ],
  };
}

async function insertApi(slug: string, maxRequests: number): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, network_policy, domain_pacing) VALUES ($1, $2, '{"allow":["direct"]}', jsonb_build_object('min_delay_ms', 5, 'max_requests_per_run', $3::int, 'max_wait_ms', 60000)) RETURNING id`,
      [slug, A, maxRequests],
    )
  ).rows[0]!.id;
}

const waitRun = async (runId: string) => {
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), { timeout: 60_000, interval: 100 });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

async function investigate(apiId: string, request: { url: string; description: string; auto_validate?: boolean }) {
  const { runId } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request }));
  return waitRun(runId);
}

const eventsOf = (runId: string) => listInvestigationEvents(pool, { runId, ownerId: A });

beforeAll(async () => {
  site = await startMiniSite(async (req) => {
    if (req.path === '/robots.txt') return undefined;
    if (req.host === LOADMORE && req.path === '/liste.html') return { body: loadMorePage() };
    if (req.host === PAGED && req.path === '/annonces/') {
      const n = Number(req.query.get('page') ?? '1');
      return n >= 1 && n <= 3 ? { body: pagedPage(n) } : { status: 404, body: 'not found' };
    }
    return undefined;
  });
  fake = await createFakeProvider();
  tdb = await createTestDatabase('investigation_r13');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  const { keyCheck } = await import('@runtime/db');
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_investigation_r13@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(site.port, HOSTS, net);
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
  const strategy = createStrategyRuntime({ pool, guard, pacer, browsers: null, agent, instanceContact, version: '9.9.9' });
  const investigation = createInvestigationExecutor({ pool, guard, pacer, browsers: null, strategy, llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) }, agentic: false, instanceContact, version: '9.9.9' });
  const executor: RunExecutor = dispatchByKind({ run: strategy.executor, investigation });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: tdb.url, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '10', BROWSER_CONCURRENCY: '1' }),
    executor,
    logger: pino({ level: 'silent' }),
  });
}, 180_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
  await fake?.close();
  await site?.close();
});

beforeEach(() => {
  fake.reset();
  site.reset();
});

describe('R13 : complétude contre le compteur affiché, plafond de requêtes, sources candidates', () => {
  test('assert_incomplete_vs_counter_not_sain — « 100 annonces », 24 livrées : l’essai fetch n’est pas conforme, jamais « sain »', async () => {
    const url = site.url(LOADMORE, '/liste.html');
    fake.setScenario(MODEL, [scripted.json(proposalFor(loadMorePage(), url))]);
    const apiId = await insertApi('zz_test_r13_incomplete', 200);
    const run = await investigate(apiId, { url, description: 'toutes les maisons, toutes les pages', auto_validate: true });
    expect(run.state).toBe('failed');
    const status = (await pool.query<{ status: string }>('SELECT status FROM apis WHERE id = $1', [apiId])).rows[0]!.status;
    expect(status).not.toBe('sain');
    const evs = await eventsOf(run.id);
    const attempt = evs.find((e) => e.kind === 'attempt.finished')!.payload as { attempt: { execution: string }; why?: { code: string; params: Record<string, unknown> } };
    expect(attempt).toMatchObject({ attempt: { execution: 'fetch' }, why: { code: 'incomplete_vs_counter', params: { counter: 100, delivered: 24 } } });
    // D-124 : la source porte son identifiant, son type, son compteur et un aperçu de 3 éléments.
    const recon = evs.find((e) => e.kind === 'reconnaissance.finished')!.payload as { candidates: { source_id: string; type: string; counter: number | null; preview: unknown[]; count: number }[] };
    expect(recon.candidates[0]).toMatchObject({ source_id: 'c1', type: 'dom', count: 24, counter: 100 });
    expect(recon.candidates[0]!.preview).toHaveLength(3);
  }, 90_000);

  test('assert_requests_per_run_follows_counter — « 30 annonces » sur 3 pages : conforme, complétude dite, plafond de requêtes relevé', async () => {
    const url = site.url(PAGED, '/annonces/');
    fake.setScenario(MODEL, [scripted.json(proposalFor(pagedPage(1), url))]);
    const apiId = await insertApi('zz_test_r13_paged', 50);
    const run = await investigate(apiId, { url, description: 'toutes les annonces', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded' });
    const evs = await eventsOf(run.id);
    const finished = evs.find((e) => e.kind === 'investigation.finished')!.payload as { completeness?: { counter: number; read: number; verified: boolean | null; requests_per_run?: number } };
    expect(finished.completeness).toMatchObject({ counter: 30, read: 30, verified: true, requests_per_run: 202 });
    const pacing = (await pool.query<{ domain_pacing: { max_requests_per_run: number; min_delay_ms: number } }>('SELECT domain_pacing FROM apis WHERE id = $1', [apiId])).rows[0]!.domain_pacing;
    expect(pacing).toMatchObject({ max_requests_per_run: 202, min_delay_ms: 5 });
  }, 90_000);
});
