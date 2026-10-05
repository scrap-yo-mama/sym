// SPDX-License-Identifier: AGPL-3.0-only
// Banc de cas réels, correctif C (cdc/scrapyomama-runtime/.executed/banc-reel.md, passage 2), de bout en bout sur base réelle
// (file → worker → exécuteur d'enquête), faux fournisseur LLM, sites de test locaux, sans navigateur :
// - R01 : la règle d'arrêt d'une liste de 53 pages se vérifie sur un échantillon de pages (1, 2, milieu, dernière annoncée et
//   suivante), pas sur les 53 pages au rythme du domaine (278 s) ;
// - R09 : un champ refusé par le contrôle de fidélité (la date reçoit l'organisateur) est corrigé par le code, sans LLM et
//   sans escalade vers les voies agentiques, avant tout appel qui coûte.
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey, Secret, type RunExecutor } from '@runtime/core';
import * as net from '@runtime/core/net';
import { analyzeCapture, type DataCandidate } from '@runtime/core/investigation';
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

/** Liste HTML de 53 pages (`/biens/page/N/`), 6 cartes par page, la page 54 répond 200 sans carte (comme Janssens). */
const LIST = 'zz_test_longlist.localhost';
/** API d'événements : la date de début est `event.start_at` ; l'organisateur est `calendar.name`. */
const EVENTS = 'zz_test_events.localhost';
const HOSTS = [LIST, EVENTS];
const MODEL = 'zz_investigate';
const PAGES = 53;
const PER_PAGE = 6;
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let site: MiniSite;
let worker: Worker;
let fake: FakeProvider;

const json = (value: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const card = (i: number) => `<article class="item-bien"><h2>Maison Zztest ${i}</h2><a href="/propriete/zz-${i}/">Voir la fiche</a><span class="prix">${100_000 + i} €</span></article>`;
const pager = (n: number) => {
  const link = (p: number) => (p === n ? `<li class="current">${p}</li>` : `<li><a href="/biens/page/${p}/">${p}</a></li>`);
  return `<ul class="pagination">${[1, 2, 3, PAGES - 1, PAGES].map(link).join('')}${n < PAGES ? `<li><a rel="next" class="next" href="/biens/page/${n + 1}/">›</a></li>` : ''}</ul>`;
};
const listPage = (n: number) => {
  const cards = n > PAGES ? [] : Array.from({ length: n === PAGES ? 3 : PER_PAGE }, (_, k) => card((n - 1) * PER_PAGE + k + 1));
  return `<html><body><h1>Maisons à vendre</h1><main>${cards.join('\n')}</main>${n > PAGES ? '' : pager(n)}</body></html>`;
};

const events = Array.from({ length: 12 }, (_, i) => ({
  api_id: `evt-zz${i}`,
  calendar: { name: `Organisateur Zztest ${i % 3}` },
  event: { name: `Événement Zztest ${i}`, start_at: `2026-10-0${(i % 9) + 1}T0${i % 10}:30:00.000Z`, end_at: `2026-10-0${(i % 9) + 1}T1${i % 10}:30:00.000Z`, url: `https://${EVENTS}/zz-evt-${i}` },
}));

function llmConfig(): LlmConfig {
  return { providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }], roles: { investigate: { provider: 'fake', model: MODEL } } };
}

async function insertApi(slug: string): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, network_policy, domain_pacing) VALUES ($1, $2, '{"allow":["direct"]}', '{"min_delay_ms": 5, "max_requests_per_run": 400, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A],
    )
  ).rows[0]!.id;
}

const waitRun = async (runId: string) => {
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), { timeout: 90_000, interval: 100 });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

async function investigate(apiId: string, request: { url: string; description: string; auto_validate?: boolean }) {
  const { runId } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request }));
  return waitRun(runId);
}

const eventsOf = (runId: string) => listInvestigationEvents(pool, { runId, ownerId: A });
const NONE = { type: 'none', param: null, start: null, has_more_path: null, next_path: null };

beforeAll(async () => {
  site = await startMiniSite(async (req) => {
    if (req.path === '/robots.txt') return undefined;
    if (req.host === LIST) {
      if (req.path === '/biens/') return { body: listPage(1) };
      const m = /^\/biens\/page\/(\d+)\/$/.exec(req.path);
      return m === null ? undefined : { body: listPage(Number(m[1])) };
    }
    if (req.host === EVENTS) {
      if (req.path === '/paris') return { body: '<html><body><h1>Paris</h1><script>fetch("/api/events")</script></body></html>' };
      if (req.path === '/api/events') return json({ entries: events, has_more: false });
    }
    return undefined;
  });
  fake = await createFakeProvider();
  tdb = await createTestDatabase('investigation_banc_c');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  const { keyCheck } = await import('@runtime/db');
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_investigation_banc_c@example.test', 'active')", [A]);
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
  const investigation = createInvestigationExecutor({ pool, guard, pacer, browsers: null, strategy, llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) }, agentic: true, instanceContact, version: '9.9.9' });
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

describe('R01 : la règle d’arrêt d’une longue liste se vérifie sur un échantillon de pages', () => {
  test('assert_pagination_stop_sampled — 53 pages : l’enquête lit 1, 2, le milieu, la dernière annoncée et la suivante, pas les 53 ; règle constatée', async () => {
    // Le gisement DOM et ses emplacements sont ceux que la reconnaissance trouvera sur la page 1 : la proposition les cite.
    const html = listPage(1);
    const candidates: readonly DataCandidate[] = analyzeCapture({ mode: 'static', pageUrl: site.url(LIST, '/biens/'), document: { url: site.url(LIST, '/biens/'), status: 200, html, renderedHtml: null, bytes: html.length }, exchanges: [], totalBytes: html.length }, [LIST]);
    const dom = candidates.find((c) => c.from === 'dom')!;
    const slot = (pred: (key: string, description: string) => boolean) => Object.entries(dom.skeleton).find(([k, d]) => pred(k, d))![0];
    fake.setScenario(MODEL, [
      scripted.json({
        fields: [
          { name: 'title', type: 'string', required: true, personal: false, description: 'Title' },
          { name: 'url', type: 'string', required: true, personal: false, description: 'Link' },
          { name: 'price', type: 'integer', required: false, personal: false, description: 'Price' },
        ],
        sources: [{ candidate: dom.id, paths: [{ field: 'title', path: slot((k) => k.startsWith('$.h2')), ops: [] }, { field: 'url', path: slot((_k, d) => d.startsWith('link')), ops: [] }, { field: 'price', path: slot((_k, d) => d.includes('shape=money')), ops: [] }], pagination: NONE }],
      }),
      scripted.json({ fields: [{ name: 'title', verdict: 'ok' }, { name: 'url', verdict: 'ok' }, { name: 'price', verdict: 'ok' }] }),
    ]);
    const apiId = await insertApi('zz_test_banc_c_long_list');
    const run = await investigate(apiId, { url: site.url(LIST, '/biens/'), description: 'toutes les maisons de la liste', auto_validate: true });
    expect(run.state).toBe('succeeded');
    const pages = site.hits.filter((h) => h.host === LIST && h.path.startsWith('/biens/')).length;
    // 3 exécutions d'échantillon de 2 pages, la vérification de 5 pages, les sondes de la page 1 : bien moins que les 53 pages.
    expect(pages).toBeLessThanOrEqual(25);
    const finished = (await eventsOf(run.id)).filter((e) => e.kind === 'attempt.finished').map((e) => e.payload as { attempt: { execution: string; result: string }; pagination?: { verified: boolean; stop: string; pages: number } });
    const retained = finished.find((f) => f.attempt.result === 'ok')!;
    expect(retained.attempt.execution).toBe('fetch');
    expect(retained.pagination).toMatchObject({ verified: true, pages: 5 });
    // La stratégie retenue lira toute la liste au run : sa règle d'arrêt (page vide) reste celle de la spécification.
    const spec = (await pool.query<{ spec: { pagination: { type: string; stop: { when: string }[] } } }>('SELECT spec FROM strategy_versions WHERE api_id = $1 ORDER BY version DESC LIMIT 1', [apiId])).rows[0]!.spec;
    expect(spec.pagination).toMatchObject({ type: 'page_param', stop: [{ when: 'records_empty' }] });
  }, 120_000);
});

describe('R09 : nouvelle tentative bon marché avant toute escalade vers une voie à LLM', () => {
  test('assert_fidelity_cheap_fix_before_llm_escalation — la date reçoit l’organisateur : le code relit le champ ISO de début, un seul appel LLM (la proposition), aucune voie agentique', async () => {
    fake.setScenario(MODEL, [
      scripted.json({
        fields: [
          { name: 'name', type: 'string', required: true, personal: false, description: 'Name' },
          { name: 'start_date', type: 'string', required: true, personal: false, description: 'Start date and time' },
          { name: 'url', type: 'string', required: true, personal: false, description: 'Link' },
        ],
        sources: [{ candidate: 'c1', paths: [{ field: 'name', path: '$.event.name', ops: [] }, { field: 'start_date', path: '$.calendar.name', ops: [] }, { field: 'url', path: '$.event.url', ops: [] }], pagination: NONE }],
      }),
    ]);
    const apiId = await insertApi('zz_test_banc_c_cheap_fix');
    const run = await investigate(apiId, { url: site.url(EVENTS, '/paris'), description: 'événements à venir : nom, date de début et lien', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded' });
    expect(run.attempts.map((a) => a.execution)).toEqual(['fetch']);
    expect(fake.byRole[MODEL]).toBe(1);
    const sv = (await pool.query<{ execution: string; spec: { fields: Record<string, { path: string }> } }>('SELECT execution, spec FROM strategy_versions WHERE api_id = $1 ORDER BY version DESC LIMIT 1', [apiId])).rows[0]!;
    expect(sv.execution).toBe('fetch');
    expect(sv.spec.fields['start_date']!.path).toBe('$.event.start_at');
  }, 120_000);
});
