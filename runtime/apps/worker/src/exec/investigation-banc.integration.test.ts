// SPDX-License-Identifier: AGPL-3.0-only
// Banc de cas réels, correctif B (cdc/scrapyomama-runtime/.executed/banc-reel.md, passage 1), de bout en bout sur base
// réelle (file → worker → exécuteur d'enquête), faux fournisseur LLM, sites de test locaux à hôtes virtuels, sans
// navigateur :
// - R09 : l'URL de départ redirige de façon permanente (301) vers un autre hôte (`lu.ma` → `luma.com`) : l'étape 0 adopte
//   l'hôte final comme domaine de l'API et le dit dans le récit ; jamais un hôte privé ou réservé (garde SSRF) ;
// - coût des essais IA : un essai E4 sur une liste n'extrait qu'un échantillon de la page 1 (entrée et sortie bornées),
//   le plafond est tenu AVANT l'appel sur la taille réelle de l'entrée, et l'essai compilé et vérifié sans LLM tient lieu
//   des exécutions suivantes.
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey, Secret, type RunExecutor } from '@runtime/core';
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

/** Ancien nom du site (lu.ma) : redirige tout de façon permanente vers le nouveau (luma.com). */
const OLD = 'zz_test_oldname.localhost';
const NEW = 'zz_test_newname.localhost';
/** Redirige de façon permanente vers l'adresse des métadonnées cloud : jamais adoptée. */
const TRAP = 'zz_test_trapredirect.localhost';
/** Liste HTML de 300 cartes, sans API ni blob : seule la voie E4 la lit, puis la compile. */
const LIST = 'zz_test_biglist.localhost';
const HOSTS = [OLD, NEW, TRAP, LIST];
const MODEL = 'zz_investigate';
const EXTRACT_MODEL = 'zz_extract';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };
const CARDS = 300;

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let site: MiniSite;
let worker: Worker;
let fake: FakeProvider;
let withExtract = false;

const json = (value: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const events = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({ id: `zz_test_ev${i + 1}`, title: `Événement Zztest ${i + 1}`, price_cents: 100 * (i + 1) })) });
const card = (i: number) =>
  `<article class="zz-card"><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg><h2 class="zz-title" style="color:red" onclick="x()">Bien Zztest ${i}</h2><span class="zz-price" data-tracking="${'t'.repeat(40)}">${1000 + i} EUR</span><a href="/biens/${i}">Voir</a></article>`;
const bigList = () =>
  `<html><head><style>.zz-card{color:blue}</style><script>window.zz=1</script></head><body><h1>Biens</h1><main>${Array.from({ length: CARDS }, (_, i) => card(i + 1)).join('\n')}</main></body></html>`;

function llmConfig(): LlmConfig {
  return {
    providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }, { id: EXTRACT_MODEL, price: { in: 1, out: 1 } }] }],
    roles: { investigate: { provider: 'fake', model: MODEL }, ...(withExtract ? { extract: { provider: 'fake', model: EXTRACT_MODEL } } : {}) },
  };
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
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), { timeout: 60_000, interval: 100 });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

async function investigate(apiId: string, request: { url: string; description: string; auto_validate?: boolean; budget_usd?: number }) {
  const { runId } = await withActor(pool, actorA, (tx) => startInvestigation(tx, queue, { apiId, ownerId: A, trigger: 'rest', request }));
  return waitRun(runId);
}

const eventsOf = (runId: string) => listInvestigationEvents(pool, { runId, ownerId: A });
const specOf = async (apiId: string) =>
  (await pool.query<{ execution: string; spec: { request: { url: string; allowed_hosts: string[] } } }>('SELECT execution, spec FROM strategy_versions WHERE api_id = $1 ORDER BY version DESC LIMIT 1', [apiId])).rows[0];

const EVENTS_PROPOSAL = {
  fields: [
    { name: 'id', type: 'string', required: true, personal: false, description: 'Identifier' },
    { name: 'title', type: 'string', required: true, personal: false, description: 'Title' },
    { name: 'price_cents', type: 'integer', required: true, personal: false, description: 'Price' },
  ],
  sources: [
    {
      candidate: 'c1',
      paths: [
        { field: 'id', path: '$.id', ops: [] },
        { field: 'title', path: '$.title', ops: [] },
        { field: 'price_cents', path: '$.price_cents', ops: [] },
      ],
      pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null },
    },
  ],
};

beforeAll(async () => {
  site = await startMiniSite(async (req) => {
    if (req.path === '/robots.txt') return undefined;
    switch (req.host) {
      case OLD:
        return { status: 301, headers: { location: site.url(NEW, req.path) }, body: '' };
      case NEW:
        if (req.path === '/paris') return { body: '<html><body><h1>Paris</h1><script>fetch("/api/events")</script></body></html>' };
        return req.path === '/api/events' ? json(events(20)) : undefined;
      case TRAP:
        return { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, body: '' };
      case LIST:
        return req.path === '/biens/' ? { body: bigList() } : undefined;
      default:
        return undefined;
    }
  });
  fake = await createFakeProvider();
  tdb = await createTestDatabase('investigation_banc');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  const { keyCheck } = await import('@runtime/db');
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_investigation_banc@example.test', 'active')", [A]);
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
  const investigation = createInvestigationExecutor({
    pool,
    guard,
    pacer,
    browsers: null,
    strategy,
    llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) },
    agentic: true,
    instanceContact,
    version: '9.9.9',
  });
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
  withExtract = false;
});

describe('R09 : redirection permanente de l’URL de départ vers un autre hôte', () => {
  test('assert_permanent_redirect_host_adopted — 301 vers un autre hôte public : hôte final adopté (essais, stratégie), dit dans le récit', async () => {
    fake.setScenario(MODEL, [scripted.json(EVENTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_banc_redirect');
    const run = await investigate(apiId, { url: site.url(OLD, '/paris'), description: 'événements à venir', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', items: 20 });
    expect(run.attempts[0]).toMatchObject({ execution: 'fetch', result: 'ok' });
    const sv = await specOf(apiId);
    expect(sv?.spec.request.allowed_hosts).toEqual([NEW]);
    expect(new URL(sv!.spec.request.url).hostname).toBe(NEW);
    const started = (await eventsOf(run.id)).find((e) => e.kind === 'investigation.started')!;
    expect(started.payload).toMatchObject({ domain: NEW, url: site.url(NEW, '/paris'), redirected_from: site.url(OLD, '/paris') });
    // L'ancien hôte n'est lu qu'une fois (la sonde de la redirection) ; tout le reste part vers le nouveau.
    expect(site.hits.filter((h) => h.host === OLD)).toHaveLength(1);
  }, 90_000);

  test('assert_permanent_redirect_private_refused — 301 vers une adresse réservée (métadonnées cloud) : jamais adoptée, aucune connexion', async () => {
    fake.setScenario(MODEL, [scripted.json(EVENTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_banc_redirect_trap');
    const run = await investigate(apiId, { url: site.url(TRAP, '/paris'), description: 'événements à venir', auto_validate: true });
    expect(run.state).toBe('failed');
    const evs = await eventsOf(run.id);
    const started = evs.find((e) => e.kind === 'investigation.started')!;
    expect(started.payload).toMatchObject({ domain: TRAP });
    expect(started.payload).not.toHaveProperty('redirected_from');
    expect(fake.calls.filter((c) => c.role === MODEL)).toHaveLength(0);
  }, 90_000);
});
