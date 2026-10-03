// SPDX-License-Identifier: AGPL-3.0-only
// UX-04 à UX-07 de la démonstration : sans contact d'instance (17 § 5), l'enquête ne peut pas partir.
// - `create_api` (MCP) et POST /api/apis (REST) refusent AVANT de créer quoi que ce soit : 409 `instance_contact_missing`,
//   message lisible, `what_to_do` et `retryable` (UX-04) ; le contact posé, la création passe ;
// - un run arrêté pour cette cause la porte (`error`) dans le RunResult MCP et REST et dans le détail du run, avec le statut
//   `action_requise` et la raison `instance_contact_missing`, jamais « budget épuisé » (UX-05) ;
// - la réponse de `create_api` dit l'état réel du run : en cours, ou échec avec sa cause, jamais « done » + « running » (UX-07).
// Le worker est simulé en base ; le serveur ne refuse que si un worker a publié son moteur (son environnement est alors connu).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { publishRobotEngine } from '@runtime/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { seedApi, seedRun } from '../../../tests/helpers/rest-seed.js';
import { createKey, createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';

type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const CONTACT_MISSING = { message: 'Renseigne le contact du robot dans Réglages > Identité du robot, ou la variable INSTANCE_CONTACT.' };

let srv: TestServer;
let base: string;
let owner: TestUser;
let ownerCookie: string;
let key: string;
let client: Client;

const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => (await c.query<T>(text, params)).rows);
const count = async (table: 'apis' | 'runs') => Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0]!.n);
const rest = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
  srv.app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload === undefined ? {} : { payload }) });
const setContact = async (contact: string | null) =>
  void (await srv.app.inject({ method: 'PUT', url: '/api/settings/identity', headers: { cookie: ownerCookie, origin: PUBLIC_URL }, payload: { instance_contact: contact } }));
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;
const textOf = (result: ToolResult) => result.content.map((c) => c.text ?? '').join('\n');

beforeAll(async () => {
  srv = await startTestServer('instance-contact', { MAX_WAIT_SECONDS: '3', MAX_CONCURRENT_RUNS: '1000', MAX_ACTIVE_RUNS_PER_USER: '1000', MAX_RUNS_PER_KEY_PER_MINUTE: '1000', MCP_ALLOWED_HOSTS: '127.0.0.1' }, { rest: { pollMs: 40 } });
  owner = await runSetup(srv);
  ownerCookie = await signIn(srv, owner);
  key = (await createKey(srv, ownerCookie, owner, ['apis:read', 'apis:run', 'apis:write', 'runs:read'])).key;
  base = await srv.app.listen({ port: 0, host: '127.0.0.1' });
  client = new Client({ name: 'zz-test-client', version: '1.0.0' }, {});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: { token: async () => key } }));
  // Un worker a démarré : son moteur et son environnement (sans INSTANCE_CONTACT) sont publiés.
  const pool = new pg.Pool({ connectionString: srv.db.url });
  try {
    await publishRobotEngine(pool, { version: '153.0.8010.12', platform: 'linux', productVersion: '1.0.0', identifyInstanceEnv: null, instanceContactEnv: null });
  } finally {
    await pool.end();
  }
  await createUser(srv, 'zz_test_contact_member@example.test', 'member');
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await srv?.close();
});

describe('UX-04 : create_api vérifie le contact d’instance avant de créer', () => {
  test('MCP : refus instance_contact_missing avec message, what_to_do et retryable ; ni API ni run créés', async () => {
    const before = { apis: await count('apis'), runs: await count('runs') };
    const result = await call('create_api', { description: 'zz_test citations', url: 'https://zz-test-quotes.example/', wait_seconds: 0 });
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty('structuredContent');
    const body = JSON.parse(result.content[0]!.text!) as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'instance_contact_missing', message: CONTACT_MISSING.message, retryable: true, next_action: null });
    expect(String(body['what_to_do'])).toContain('/settings/robot');
    expect({ apis: await count('apis'), runs: await count('runs') }).toEqual(before);
  });

  test('REST : 409 instance_contact_missing, même message ; rien n’est créé', async () => {
    const before = { apis: await count('apis'), runs: await count('runs') };
    const res = await rest('POST', '/api/apis', { description: 'zz_test citations', url: 'https://zz-test-quotes.example/' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'instance_contact_missing', message: CONTACT_MISSING.message } });
    expect({ apis: await count('apis'), runs: await count('runs') }).toEqual(before);
  });

  test('le contact posé (réglage de la console), la création passe ; retiré, elle est refusée de nouveau', async () => {
    await setContact('ops@zz-test.example');
    const created = await rest('POST', '/api/apis', { description: 'zz_test avec contact', url: 'https://zz-test-ok.example/' });
    expect(created.statusCode, created.body).toBe(201);
    await setContact(null);
    expect((await rest('POST', '/api/apis', { description: 'zz_test sans contact', url: 'https://zz-test-ko.example/' })).statusCode).toBe(409);
  });

  test('le contact fourni par l’environnement du worker (publié avec son moteur) suffit', async () => {
    const pool = new pg.Pool({ connectionString: srv.db.url });
    try {
      await publishRobotEngine(pool, { version: '153.0.8010.12', platform: 'linux', productVersion: '1.0.0', identifyInstanceEnv: null, instanceContactEnv: 'mailto:env@zz-test.example' });
      expect((await rest('POST', '/api/apis', { description: 'zz_test contact env', url: 'https://zz-test-env.example/' })).statusCode).toBe(201);
      await publishRobotEngine(pool, { version: '153.0.8010.12', platform: 'linux', productVersion: '1.0.0', identifyInstanceEnv: null, instanceContactEnv: null });
    } finally {
      await pool.end();
    }
  });
});

describe('UX-04 / UX-05 : la cause d’un run arrêté pour contact absent', () => {
  async function stoppedRun() {
    const api = await seedApi(srv.db.url, owner.id, { status: 'action_requise', strategy: false });
    const run = await seedRun(srv.db.url, { apiId: api.id, ownerId: owner.id, state: 'failed', kind: 'investigation' });
    await sql("UPDATE runs SET error_detail = 'instance_contact_missing', failure_class = NULL, retryable = false WHERE id = $1", [run.runId]);
    await sql("UPDATE apis SET status_reason = 'instance_contact_missing', investigation_phase = 'done' WHERE id = $1", [api.id]);
    return { api, runId: run.runId };
  }

  test('MCP get_run : error {code, message, what_to_do, retryable}, phrase qui nomme la cause, statut action_requise', async () => {
    const { runId } = await stoppedRun();
    const result = await call('get_run', { run_id: runId });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      run_id: runId,
      state: 'failed',
      status: 'action_requise',
      error: { code: 'instance_contact_missing', message: CONTACT_MISSING.message, retryable: true },
    });
    expect((result.structuredContent!['error'] as { what_to_do: string }).what_to_do).toContain('/settings/robot');
    expect(String(result.structuredContent!['message'])).toContain('instance_contact_missing');
    expect(String(result.structuredContent!['message'])).not.toContain('code_error');
  });

  test('REST : GET /api/runs/{id} porte la même cause ; la raison de l’API est instance_contact_missing, pas un budget', async () => {
    const { api, runId } = await stoppedRun();
    const run = await rest('GET', `/api/runs/${runId}`);
    expect(run.json()).toMatchObject({ failure_class: null, error: { code: 'instance_contact_missing', message: CONTACT_MISSING.message, retryable: true } });
    const detail = await rest('GET', `/api/apis/${api.slug}`);
    expect(detail.json()).toMatchObject({ status: 'action_requise', status_reason: { code: 'instance_contact_missing' } });
    expect(JSON.stringify(detail.json())).not.toContain('investigation_budget_exhausted');
  });

  test('un détail d’erreur qui n’est pas une cause nommée n’est jamais publié', async () => {
    const api = await seedApi(srv.db.url, owner.id);
    const run = await seedRun(srv.db.url, { apiId: api.id, ownerId: owner.id, state: 'failed', failureClass: 'code_error' });
    const res = await rest('GET', `/api/runs/${run.runId}`);
    expect(res.json()).not.toHaveProperty('error');
    expect(res.body).not.toContain('zz_test_private_error');
  });
});

describe('UX-07 : create_api dit l’état réel de l’enquête', () => {
  test('enquête en cours : état du run et phrase « running » cohérents', async () => {
    await setContact('ops@zz-test.example');
    const result = await call('create_api', { description: 'zz_test en cours', url: 'https://zz-test-running.example/', wait_seconds: 0 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ run_state: 'queued', status: 'enquete' });
    expect(textOf(result)).toContain('the investigation is running');
  });

  test('enquête échouée pendant l’attente : état failed avec sa cause, jamais « running »', async () => {
    await setContact('ops@zz-test.example');
    const pending = call('create_api', { description: 'zz_test échec pendant l’attente', url: 'https://zz-test-failed.example/', wait_seconds: 3 });
    // Le worker simulé arrête l'enquête (contact retiré entre-temps) et la machine passe l'API en action_requise.
    const deadline = Date.now() + 2_000;
    let runId: string | undefined;
    while (runId === undefined && Date.now() < deadline) {
      runId = (await sql<{ id: string }>("SELECT id FROM runs WHERE kind = 'investigation' AND state = 'queued' ORDER BY created_at DESC LIMIT 1"))[0]?.id;
      if (runId === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runId).toBeDefined();
    await sql(
      "UPDATE runs SET state = 'failed', outcome = 'failed', failure_class = NULL, retryable = false, error_detail = 'instance_contact_missing', started_at = now(), finished_at = now(), duration_ms = 5 WHERE id = $1",
      [runId],
    );
    await sql("UPDATE apis SET status = 'action_requise', status_reason = 'instance_contact_missing', investigation_phase = 'done' WHERE id = (SELECT api_id FROM runs WHERE id = $1)", [runId]);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      run_state: 'failed',
      status: 'action_requise',
      error: { code: 'instance_contact_missing', retryable: true },
    });
    expect(textOf(result)).not.toContain('the investigation is running');
    expect(textOf(result)).toContain('instance_contact_missing');
  });
});
