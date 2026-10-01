// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.4 de bout en bout sur base réelle : run mis en file → worker (1.3) → `RunExecutor` de production avec les ports
// agentiques (Stagehand 3.7.3 par `stagehandEngineFor`, Chromium dédié par `launchAgentBrowser`) sur le faux fournisseur.
// E4 : dataset conforme, coût LLM et modèle tracés dans l'essai (INV4). E6 : dataset conforme, trace compilée en E5 et
// vérifiée, nouvelle version `hybrid` promue et journalisée ; le run suivant joue l'E5 SANS aucun appel LLM. E6 en tunnel :
// refusé avant tout réseau (0.6b).
// PostgreSQL : un conteneur propre à ce fichier (le job security n'a pas le globalSetup du projet integration).
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DomainPacer, generateMasterKey, MasterKey, Secret, validateOutput } from '@runtime/core';
import * as net from '@runtime/core/net';
import { createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRun, runQueueDefinition, withActor } from '@runtime/db';
import { createLlmClient, type CapabilityProfile, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { launchAgentBrowser } from '../browser/agent-browser.js';
import { BrowserPool, playwrightLauncher } from '../browser/pool.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { stagehandEngineFor } from './factory.js';
import { createStrategyExecutor } from './strategy-executor.js';
import { AGENT_HOSTS } from '../../../../fixtures/src/sites/agent-sites.ts';
import { agentReference, agentTasks, type AgentFixtureKey } from '../../../../fixtures/src/agent-tasks.ts';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { stagehandScript } from '../../../../tests/helpers/stagehand-script.ts';

const A = randomUUID();
/** Profil sondé du modèle du rôle agent (08 §1 : sans profil à appel d'outils, le rôle est refusé). */
const AGENT_PROFILE: CapabilityProfile = {
  model: 'zz-agent',
  tools: true,
  tool_choice: ['auto'],
  structured_modes: ['json_object'],
  structured: 'json_object',
  stream_tools: null,
  stream_usage: null,
  cache: false,
  reasoning_field: null,
  probed_at: '2026-10-01T00:00:00Z',
  probe_tokens: 0,
  notes: [],
};
const actorA = { userId: A, role: 'member' as const };

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let browsers: BrowserPool;
let launchProxy: net.EgressProxy;
let fake: FakeProvider;

const task = (key: AgentFixtureKey) => agentTasks().find((t) => t.key === key)!;
const itemSchema = (key: AgentFixtureKey): Record<string, unknown> => {
  const s = task(key).outputSchema as { properties: { items?: { items: Record<string, unknown> } } };
  return s.properties.items?.items ?? task(key).outputSchema;
};
const url = (host: string) => `http://${host}:${client.server.port}/`;

async function insertApi(slug: string, strategy: { execution: string; network: string; spec: unknown }, outputSchema: unknown): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, output_schema, network_policy, domain_pacing, max_cost_usd) VALUES ($1, $2, $3, $4, '{"min_delay_ms": 5, "max_requests_per_run": 50, "max_wait_ms": 60000}', 0.5) RETURNING id`,
      [slug, A, JSON.stringify(outputSchema), JSON.stringify({ allow: ['direct', 'tunnel'] })],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, $3, $4, $5, 0.01, 'user')", [
    id,
    A,
    strategy.execution,
    strategy.network,
    JSON.stringify(strategy.spec),
  ]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

const runOf = async (apiId: string) => {
  const { runId } = await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 120_000,
    interval: 200,
  });
  return { runId, run: (await withActor(pool, actorA, (tx) => readRun(tx, runId)))! };
};

const logsOf = async (runId: string) => (await pool.query<{ event: string; data: unknown }>('SELECT event, data FROM run_logs WHERE run_id = $1 ORDER BY ts', [runId])).rows;

beforeAll(async () => {
  container = await new PostgreSqlContainer(`postgres:${process.env.PG_VERSION ?? '16'}`).start();
  const dbUrl = container.getConnectionUri();
  await migrateUp({ connectionString: dbUrl });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: dbUrl, max: 6 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_agent_exec@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: dbUrl, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  client = await startClient();
  fake = await createFakeProvider();
  const guard = fixtureGuard(client.server.port, [AGENT_HOSTS.e4, AGENT_HOSTS.e6, AGENT_HOSTS.trap], net);
  launchProxy = await net.startEgressProxy({ guard, refuseAll: true });
  browsers = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100 });
  const config: LlmConfig = {
    providers: [
      {
        id: 'fake',
        baseUrl: fake.baseUrl,
        apiKey: new Secret('zz_test_fake_key'),
        models: [
          { id: 'zz-extract', price: { in: 1, out: 2 } },
          { id: 'zz-agent', price: { in: 1, out: 2 }, profile: AGENT_PROFILE },
        ],
      },
    ],
    roles: { extract: { provider: 'fake', model: 'zz-extract' }, agent: { provider: 'fake', model: 'zz-agent' } },
  };
  const executor = createStrategyExecutor({
    pool,
    guard,
    pacer: new DomainPacer(new PgPacingStore(pool)),
    browsers,
    logger: pino({ level: 'silent' }),
    agent: {
      llmConfig: async () => config,
      client: (c) => createLlmClient(c),
      // Chemin de production : Stagehand construit par la fabrique du worker (environnement sans clé Browserbase/Brave).
      engineFor: (c) => stagehandEngineFor(c, {}),
      agentBrowser: (options) => launchAgentBrowser({ ...options, env: process.env }),
    },
  });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: dbUrl, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '30', BROWSER_CONCURRENCY: '1' }),
    executor,
    logger: pino({ level: 'silent' }),
  });
}, 240_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await browsers?.close();
  await launchProxy?.close();
  await fake?.close();
  await pool?.end();
  await client?.close();
  await container?.stop();
}, 120_000);

beforeEach(() => fake.reset());

describe('exécuteurs agentiques branchés sur le worker (base réelle, Chromium réel)', () => {
  test('assert_e4_irregular_html — E4 : 8 items conformes, essai tracé avec coût LLM, modèle et version du prompt', async () => {
    fake.setScenario('zz-extract', [scripted.json(agentReference('F-E4'))]);
    const apiId = await insertApi(
      'zz_test_e4',
      { execution: 'agent_fetch', network: 'direct', spec: { schema_version: 1, kind: 'agent_fetch', request: { url: url(AGENT_HOSTS.e4), allowed_hosts: [AGENT_HOSTS.e4] }, instruction: task('F-E4').instruction } },
      itemSchema('F-E4'),
    );
    const { run } = await runOf(apiId);
    expect((await pool.query('SELECT failure_class, error_detail FROM runs WHERE api_id = $1', [apiId])).rows).toEqual([{ failure_class: null, error_detail: null }]);
    expect(run).toMatchObject({ state: 'succeeded', items: 8, strategy_version: 1 });
    expect(run.attempts).toEqual([expect.objectContaining({ execution: 'agent_fetch', result: 'ok', model_id: 'zz-extract', prompt_version: expect.stringMatching(/^extract-/) })]);
    expect(run.cost.llm_usd).toBeGreaterThan(0);
    expect(run.tokens.in).toBeGreaterThan(0);
    const items = await withActor(pool, actorA, (tx) => tx.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [run.dataset_id]));
    for (const r of items.rows) expect(validateOutput(itemSchema('F-E4'), r.item)).toEqual({ ok: true });
  }, 120_000);

  test('assert_e6_compiled_to_e5 / assert_e5_replay_without_llm — E6 réussi, version hybrid promue et journalisée, run suivant en E5 sans LLM', async () => {
    const ref = agentReference('F-E6') as { title: string };
    fake.setScenario('zz-agent', stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: `click the link "${ref.title}"` } }])], { items: [ref] }));
    const apiId = await insertApi(
      'zz_test_e6',
      {
        execution: 'agent',
        network: 'direct',
        spec: { schema_version: 1, kind: 'agent', start_url: url(AGENT_HOSTS.e6), allowed_hosts: [AGENT_HOSTS.e6], instruction: task('F-E6').instruction, limits: { max_steps: 10 } },
      },
      itemSchema('F-E6'),
    );
    const first = await runOf(apiId);
    expect(first.run).toMatchObject({ state: 'succeeded', items: 1, strategy_version: 1 });
    expect(first.run.attempts).toEqual([expect.objectContaining({ execution: 'agent', result: 'ok', model_id: 'zz-agent', engine: 'stagehand@3.7.3' })]);
    expect(first.run.cost.llm_usd).toBeGreaterThan(0);
    const compiled = (await logsOf(first.runId)).find((l) => l.event === 'strategy_compiled');
    expect(compiled?.data).toMatchObject({ from_version: 1, to_version: 2, promoted: true });
    const versions = await pool.query<{ version: number; execution: string; created_by: string; parent_version: number | null }>(
      'SELECT version, execution, created_by, parent_version FROM strategy_versions WHERE api_id = $1 ORDER BY version',
      [apiId],
    );
    expect(versions.rows).toEqual([
      { version: 1, execution: 'agent', created_by: 'user', parent_version: null },
      { version: 2, execution: 'hybrid', created_by: 'investigation', parent_version: 1 },
    ]);
    const llmCalls = fake.requests;
    const second = await runOf(apiId);
    expect((await pool.query('SELECT failure_class, error_detail FROM runs WHERE id = $1', [second.runId])).rows).toEqual([{ failure_class: null, error_detail: null }]);
    expect(second.run).toMatchObject({ state: 'succeeded', items: 1, strategy_version: 2 });
    expect(second.run.attempts).toEqual([expect.objectContaining({ execution: 'hybrid', result: 'ok', model_id: null, engine: null })]);
    expect(second.run.cost.llm_usd).toBe(0);
    expect(fake.requests).toBe(llmCalls);
    const item = await withActor(pool, actorA, (tx) => tx.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE dataset_id = $1', [second.run.dataset_id]));
    expect(item.rows.map((r) => r.item)).toEqual([ref]);
  }, 240_000);

  test('assert_e6_not_in_tunnel_mode — E6 en tunnel : refusé avant tout réseau (execution_server_only), 0 appel LLM', async () => {
    const apiId = await insertApi(
      'zz_test_e6_tunnel',
      { execution: 'agent', network: 'tunnel', spec: { schema_version: 1, kind: 'agent', start_url: url(AGENT_HOSTS.e6), allowed_hosts: [AGENT_HOSTS.e6], instruction: 'x' } },
      itemSchema('F-E6'),
    );
    const { run } = await runOf(apiId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'code_error' });
    expect(fake.requests).toBe(0);
    const row = await pool.query<{ error_detail: string }>('SELECT error_detail FROM runs WHERE api_id = $1', [apiId]);
    expect(row.rows[0]?.error_detail).toBe('execution_server_only');
  }, 60_000);
});
