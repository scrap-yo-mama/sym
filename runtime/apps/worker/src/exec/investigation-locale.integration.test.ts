// SPDX-License-Identifier: AGPL-3.0-only
// assert_ui_locale_not_in_target_requests, volet bout en bout (tâche 3.20, 21 § 6, 21b M8) : DEUX enquêtes réelles (worker, base
// réelle, faux fournisseur LLM, fixture locale), l'une lancée par un compte `fr` (fuseau Europe/Paris), l'autre par un compte `en`
// (fuseau Pacific/Chatham). `runs.locale` vaut `fr` puis `en` (posée par la base), atteint bien le LLM (bloc `Language:` du prompt
// d'enquête), mais JAMAIS le site : un relais d'enregistrement placé devant la fixture relève méthode, URL, en-têtes et corps de
// chaque requête ; les deux enquêtes envoient exactement les mêmes, sans langue d'interface ni fuseau (nom de ville compris).
// Sans navigateur (reconnaissance statique, E1) : les voies Chromium (E2/E3, E5/E6) sont couvertes par
// tests/browser/engine-accept-language.security.test.ts (en-têtes du moteur, trace CDP).
import { randomUUID } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { DomainPacer, generateMasterKey, MasterKey, Secret, type RunExecutor } from '@runtime/core';
import * as net from '@runtime/core/net';
import { keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, startInvestigation, withActor } from '@runtime/db';
import { createLlmClient, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { createInvestigationExecutor, dispatchByKind } from './investigation-executor.js';
import { createStrategyRuntime } from './strategy-executor.js';

const API_HOST = 'zz_test_api_json.localhost';
const MODEL = 'zz_investigate';
const ACCOUNTS = {
  fr: { id: randomUUID(), locale: 'fr', timezone: 'Europe/Paris', city: 'Paris' },
  en: { id: randomUUID(), locale: 'en', timezone: 'Pacific/Chatham', city: 'Chatham' },
} as const;

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let fake: FakeProvider;

// --- Relais d'enregistrement devant la fixture : ce que le site reçoit réellement ------------------------------------------------
type Received = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
let received: Received[] = [];
let relay: Server;
let relayPort: number;
const base = (): string => `http://${API_HOST}:${relayPort}`;

const CONTACTS_PROPOSAL = {
  fields: [
    { name: 'id', type: 'string', required: true, personal: false, description: 'Contact identifier' },
    { name: 'name', type: 'string', required: true, personal: true, description: 'Name' },
    { name: 'email', type: 'string', required: true, personal: true, description: 'E-mail address' },
    { name: 'city', type: 'string', required: false, personal: false, description: 'City' },
    { name: 'score', type: 'integer', required: true, personal: false, description: 'Score' },
  ],
  sources: [
    {
      candidate: 'c1',
      paths: [
        { field: 'id', path: '$.id', ops: [] },
        { field: 'name', path: '$.name', ops: ['trim'] },
        { field: 'email', path: '$.email', ops: ['lower'] },
        { field: 'city', path: '$.city', ops: [] },
        { field: 'score', path: '$.score', ops: [] },
      ],
      pagination: { type: 'page_param', param: 'url.query.page', start: 1, has_more_path: '$.has_more', next_path: null },
    },
  ],
};

function llmConfig(): LlmConfig {
  return {
    providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }],
    roles: { investigate: { provider: 'fake', model: MODEL } },
  };
}

beforeAll(async () => {
  client = await startClient();
  relay = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers }, body: body.toString('utf8') });
      const upstream = request({ host: '127.0.0.1', port: client.server.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      upstream.on('error', () => res.writeHead(502).end());
      upstream.end(body);
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  relayPort = (relay.address() as { port: number }).port;

  fake = await createFakeProvider();
  tdb = await createTestDatabase('investigation_locale');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  for (const a of Object.values(ACCOUNTS)) {
    await pool.query("INSERT INTO users (id, email, status, locale, timezone) VALUES ($1, $2, 'active', $3, $4)", [a.id, `zz_test_${a.locale}@example.test`, a.locale, a.timezone]);
  }
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(relayPort, [API_HOST], net);
  const pacer = new DomainPacer(new PgPacingStore(pool));
  const agent = {
    llmConfig: async () => llmConfig(),
    client: (config: LlmConfig) => createLlmClient(config),
    engineFor: () => () => null,
    agentBrowser: async (): Promise<never> => {
      throw new Error('zz_test : aucun navigateur');
    },
  };
  const strategy = createStrategyRuntime({ pool, guard, pacer, browsers: null, agent, instanceContact: async () => 'mailto:ops@zz-test.example', version: '9.9.9' });
  const investigation = createInvestigationExecutor({
    pool,
    guard,
    pacer,
    browsers: null,
    strategy,
    llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) },
    agentic: false,
    instanceContact: async () => 'mailto:ops@zz-test.example',
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
  await new Promise<void>((resolve) => (relay ? relay.close(() => resolve()) : resolve()));
  await client?.close();
});

type Investigated = { locale: string; state: string; requests: Received[]; systemPrompts: string[] };

/** Une enquête complète lancée par `account` sur la même fixture, remise à zéro : ce que le site et le LLM ont reçu. */
async function investigateAs(account: (typeof ACCOUNTS)[keyof typeof ACCOUNTS]): Promise<Investigated> {
  await client.reset();
  fake.reset();
  fake.setScenario(MODEL, [scripted.json(CONTACTS_PROPOSAL)]);
  received = [];
  const actor = { userId: account.id, role: 'member' as const };
  const apiId = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, network_policy, domain_pacing) VALUES ($1, $2, '{"allow": ["direct"]}', '{"min_delay_ms": 5, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [`zz_test_inv_locale_${account.locale}`, account.id],
    )
  ).rows[0]!.id;
  const { runId } = await withActor(pool, actor, (tx) =>
    startInvestigation(tx, queue, { apiId, ownerId: account.id, trigger: 'rest', request: { url: `${base()}/`, description: 'liste des contacts', auto_validate: true } }),
  );
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 45_000,
    interval: 100,
  });
  const run = (await withActor(pool, actor, (tx) => readRun(tx, runId)))!;
  const { locale } = (await pool.query<{ locale: string }>('SELECT locale FROM runs WHERE id = $1', [runId])).rows[0]!;
  const systemPrompts = fake.calls
    .map((c) => (c.body['messages'] as { role: string; content: string }[] | undefined)?.find((m) => m.role === 'system')?.content)
    .filter((p): p is string => typeof p === 'string');
  return { locale, state: run.state, requests: [...received], systemPrompts };
}

/** Requête comparable d'une enquête à l'autre : l'hôte porte le port du relais (identique), rien d'autre n'est retiré. */
const comparable = (r: Received): string => JSON.stringify({ method: r.method, url: r.url, headers: Object.entries(r.headers).sort(([a], [b]) => a.localeCompare(b)), body: r.body });

describe('M8 : enquêtes fr et en, mêmes requêtes vers le site', () => {
  test('assert_ui_locale_not_in_target_requests : runs.locale fr puis en atteint le LLM, jamais le site ; en-têtes, URL et corps identiques ; ni langue ni fuseau du compte', async () => {
    const fr = await investigateAs(ACCOUNTS.fr);
    const en = await investigateAs(ACCOUNTS.en);

    // runs.locale posée par la base depuis users.locale du demandeur, et bien transmise au LLM (prose seulement, 21 § 4.5).
    expect(fr).toMatchObject({ locale: 'fr', state: 'succeeded' });
    expect(en).toMatchObject({ locale: 'en', state: 'succeeded' });
    expect(fr.systemPrompts.length).toBeGreaterThan(0);
    expect(fr.systemPrompts.every((p) => p.includes('in French (fr)'))).toBe(true);
    expect(en.systemPrompts.every((p) => p.includes('in English (en)'))).toBe(true);

    // Le site a reçu de vraies requêtes (robots.txt, sonde, reconnaissance, essais)…
    expect(fr.requests.length).toBeGreaterThan(3);
    // … exactement les mêmes pour les deux enquêtes : méthode, URL (requête comprise), en-têtes, corps. Seule exception, sans lien
    // avec la langue : robots.txt est mis en cache par le worker (même origine), la 2e enquête peut ne pas le relire ; chaque lecture
    // de robots.txt porte alors exactement les mêmes en-têtes.
    const isRobots = (r: Received): boolean => r.url.split('?')[0] === '/robots.txt';
    expect(fr.requests.filter((r) => !isRobots(r)).map(comparable).sort()).toEqual(en.requests.filter((r) => !isRobots(r)).map(comparable).sort());
    const robots = [...fr.requests, ...en.requests].filter(isRobots);
    expect(fr.requests.some(isRobots)).toBe(true);
    expect(new Set(robots.map(comparable)).size).toBe(1);

    // Ni la langue de l'interface, ni le fuseau (nom de ville compris) n'apparaissent dans une requête vers le site.
    for (const { requests } of [fr, en]) {
      const all = JSON.stringify(requests);
      for (const a of Object.values(ACCOUNTS)) {
        expect(all).not.toContain(a.timezone);
        expect(all).not.toContain(a.city);
      }
      for (const r of requests) {
        // Langue du moteur seulement : un Chromium vierge n'en envoie aucune (ENGINE_ACCEPT_LANGUAGE null), E1 non plus.
        expect(r.headers['accept-language'], r.url).toBeUndefined();
        expect(r.url).not.toMatch(/[?&](lang|locale|hl|tz|timezone)=/i);
      }
    }
  }, 120_000);
});
