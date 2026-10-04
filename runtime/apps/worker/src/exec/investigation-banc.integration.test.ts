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
  `<article class="zz-card"><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg><h2 class="zz-title" style="color:red" onclick="x()">Bien Zztest ${i}</h2><span class="zz-price" data-tracking="${'t'.repeat(40)}">${1000 + i}</span> <span class="zz-cur">EUR</span><p class="zz-desc">Description Zztest du bien numéro ${i} : maison de village avec jardin, garage, terrasse exposée au sud et vue dégagée sur les collines.</p></article>`;
const bigList = (n = CARDS) =>
  `<html><head><style>.zz-card{color:blue}</style><script>window.zz=1</script></head><body><h1>Biens</h1><main>${Array.from({ length: n }, (_, i) => card(i + 1)).join('\n')}</main></body></html>`;

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
        if (req.path === '/petite/') return { body: bigList(5) };
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
    const evs = await eventsOf(run.id);
    expect(evs.find((e) => e.kind === 'investigation.started')!.payload).toMatchObject({ domain: OLD });
    // Étape 0 : la redirection permanente est dite dans le récit, le rapport porte sur l'URL finale.
    expect(evs.find((e) => e.kind === 'access_report')!.payload).toMatchObject({ domain: NEW, url: site.url(NEW, '/paris'), redirected_from: site.url(OLD, '/paris'), verdict: { proceed: true } });
    // L'ancien hôte n'est lu que par l'étape 0 et la sonde de la redirection ; tout le reste part vers le nouveau.
    expect(site.hits.filter((h) => h.host === OLD).length).toBeLessThanOrEqual(2);
  }, 90_000);

  test('assert_permanent_redirect_private_refused — 301 vers une adresse réservée (métadonnées cloud) : jamais adoptée, aucune connexion', async () => {
    fake.setScenario(MODEL, [scripted.json(EVENTS_PROPOSAL)]);
    const apiId = await insertApi('zz_test_banc_redirect_trap');
    const run = await investigate(apiId, { url: site.url(TRAP, '/paris'), description: 'événements à venir', auto_validate: true });
    expect(run.state).toBe('failed');
    const evs = await eventsOf(run.id);
    expect(evs.find((e) => e.kind === 'investigation.started')!.payload).toMatchObject({ domain: TRAP });
    const access = evs.find((e) => e.kind === 'access_report')!.payload as Record<string, unknown>;
    expect(access).toMatchObject({ verdict: { proceed: false, failure: { detail: 'domain_not_allowed' } } });
    expect(access).not.toHaveProperty('redirected_from');
    expect(fake.calls.filter((c) => c.role === MODEL)).toHaveLength(0);
  }, 90_000);
});

describe('coût des essais IA (R06, R08) : échantillon de la page 1, compilé puis vérifié sans LLM', () => {
  const op = (name: string) => ({ op: name, pattern: null, group: null, decimal: null, format: null });
  const userText = (body: Record<string, unknown>) => ((body['messages'] as { role: string; content: string }[]).find((m) => m.role === 'user')?.content ?? '');

  test('assert_ai_trial_sampled_and_bounded — liste de 300 cartes : 1 seul appel E4 (20 éléments au plus, entrée et sortie bornées), compilation sur HTML échantillonné, 300 éléments sans LLM', async () => {
    withExtract = true;
    fake.setScenario(MODEL, [
      scripted.json({
        fields: [
          { name: 'title', type: 'string', required: true, personal: false, description: 'Titre' },
          { name: 'price', type: 'integer', required: true, personal: false, description: 'Prix' },
        ],
        sources: [],
      }),
      scripted.json({ records: 'article.zz-card', fields: [{ field: 'title', css: 'h2.zz-title', attr: null, ops: [op('trim')] }, { field: 'price', css: 'span.zz-price', attr: null, ops: [op('to_integer')] }] }),
    ]);
    const sample = Array.from({ length: 10 }, (_, i) => ({ title: `Bien Zztest ${i + 1}`, price: 1001 + i }));
    fake.setScenario(EXTRACT_MODEL, [scripted.json({ items: sample }), scripted.json({ items: sample }), scripted.json({ items: sample })]);
    const apiId = await insertApi('zz_test_banc_big_list');
    const run = await investigate(apiId, { url: site.url(LIST, '/biens/'), description: 'tous les biens de la liste', auto_validate: true });
    expect(run).toMatchObject({ state: 'succeeded', items: CARDS });
    // Un seul appel E4 : l'essai compilé et vérifié sans LLM tient lieu des deux autres exécutions.
    expect(fake.byRole[EXTRACT_MODEL]).toBe(1);
    expect(fake.byRole[MODEL]).toBe(2);
    const extract = fake.calls.find((c) => c.role === EXTRACT_MODEL)!;
    expect(extract.body['max_tokens']).toBe(4_096);
    const extractText = userText(extract.body);
    expect(extractText).toContain('SAMPLE: return only the first 20 matching records');
    expect(extractText.length).toBeLessThan(26_000);
    expect(extractText).not.toContain(`Bien Zztest ${CARDS}`);
    const compile = fake.calls.filter((c) => c.role === MODEL)[1]!;
    const compileText = userText(compile.body);
    expect(compileText.match(/<article class="zz-card">/g)?.length ?? 0).toBeLessThanOrEqual(15);
    expect(compileText).toContain('the RECORDS are the first 10 records of the page');
    expect(compileText).toMatch(/NOTE: [0-9]+ repeated elements were removed/);
    expect(compileText).not.toContain('<svg');
    expect(compileText).not.toContain('onclick');
    const finished = (await eventsOf(run.id)).find((e) => e.kind === 'attempt.finished')!.payload as { attempt: { execution: string; result: string }; executions: unknown[] };
    expect(finished.attempt).toMatchObject({ execution: 'agent_fetch', result: 'ok' });
    expect(finished.executions).toHaveLength(1);
    const versions = (await pool.query<{ version: number; execution: string; spec: { limits?: Record<string, unknown> } }>('SELECT version, execution, spec FROM strategy_versions WHERE api_id = $1 ORDER BY version', [apiId])).rows;
    expect(versions.map((v) => v.execution)).toEqual(['agent_fetch', 'fetch']);
    // La version E4 de repli extrait toute la page à chaque run : l'échantillon de l'essai n'y est pas.
    expect(versions[0]!.spec.limits ?? {}).not.toHaveProperty('sample_items');
  }, 90_000);

  test('assert_ai_trial_ceiling_before_call — plafond de l’essai sous la borne haute de l’appel (entrée réelle + sortie permise) : aucun appel E4 envoyé', async () => {
    withExtract = true;
    fake.setScenario(MODEL, [scripted.json({ fields: [{ name: 'title', type: 'string', required: true, personal: false, description: 'Titre' }], sources: [] })]);
    fake.setScenario(EXTRACT_MODEL, [scripted.json({ items: [{ title: 'Bien Zztest 1' }] })]);
    const apiId = await insertApi('zz_test_banc_big_list_cap');
    // Prix factice 1 $ / Mjeton, page de 5 cartes : l'entrée (~0,0005 $) passe la borne basse d'avant ; la sortie permise
    // (4 096 jetons, 0,004 $) non : l'appel aurait pu franchir le plafond, il n'est jamais envoyé.
    await pool.query('UPDATE apis SET max_cost_usd = 0.002 WHERE id = $1', [apiId]);
    const run = await investigate(apiId, { url: site.url(LIST, '/petite/'), description: 'tous les biens de la liste', auto_validate: true });
    expect(run.state).toBe('failed');
    expect(fake.byRole[EXTRACT_MODEL] ?? 0).toBe(0);
    const attempt = (await eventsOf(run.id)).find((e) => e.kind === 'attempt.finished')!.payload as { attempt: { result: string; cost_usd: number } };
    expect(attempt.attempt.result).toBe('run_budget_exceeded');
    expect(attempt.attempt.cost_usd).toBeLessThanOrEqual(0.002);
  }, 90_000);
});
