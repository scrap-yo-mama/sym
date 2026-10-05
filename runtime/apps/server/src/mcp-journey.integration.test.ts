// SPDX-License-Identifier: AGPL-3.0-only
// Parcours MCP « du premier coup » (lot A du CDC UX, 03-specs-mcp) sur un serveur réel et le client MCP officiel ; le worker
// est simulé en base (les événements `investigation_events` que le vrai worker écrirait) : ces tests portent sur le contrat du
// serveur. Le parcours complet avec le vrai worker est dans mcp-first-try.integration.test.ts.
// - assert_progress_readable : un jalon libellé (langue du compte) au moins toutes les 5 s, ici à l'échelle (battement de 250 ms) ;
// - assert_wait_honored : `get_run(wait_seconds)` tient l'attente, et rend aussitôt le run qui finit ou attend une décision ;
// - assert_no_duplicate_investigation : une demande, une enquête (24 h, propriétaire, `force_new`, suite après un échec) ;
// - auto_validate par défaut (REST et MCP), nom et slug court (UX-08), schéma proposé dans get_run et get_api (UX-18, UX-36).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { createKey, createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';
import { PROGRESS_HEARTBEAT_MS } from './mcp/result-block.js';

type Party = { user: TestUser; cookie: string; key: string };
type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const SCOPES = ['apis:read', 'apis:run', 'apis:write', 'runs:read', 'datasets:read'];
const HEARTBEAT_MS = 250;
const POLL_MS = 40;

let srv: TestServer;
let base: string;
let ownerCookie: string;
let a: Party;
let b: Party;
let fr: Party;
const clients: Client[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => (await c.query<T>(text, params)).rows);
const count = async (text: string, params: unknown[] = []) => Number(Object.values((await sql<Record<string, string>>(text, params))[0]!)[0]);
const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');

async function connect(key: string, opts: { lang?: string } = {}): Promise<Client> {
  const url = new URL(`${base}/mcp${opts.lang === undefined ? '' : `?lang=${opts.lang}`}`);
  const client = new Client({ name: 'zz-test-client', version: '1.0.0' }, {});
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: { token: async () => key } }));
  clients.push(client);
  return client;
}
const call = async (client: Client, name: string, args: Record<string, unknown>, options?: { onprogress?: (p: { progress: number; message?: string }) => void }): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args }, options)) as ToolResult;

async function emit(runId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
  await sql(
    `INSERT INTO investigation_events (run_id, seq, owner_id, project_id, kind, payload)
     SELECT r.id, coalesce((SELECT max(e.seq) FROM investigation_events e WHERE e.run_id = r.id), 0) + 1, r.owner_id, r.project_id, $2, $3::jsonb FROM runs r WHERE r.id = $1`,
    [runId, kind, JSON.stringify({ run_id: runId, ...payload })],
  );
}

/** Première enquête en file du propriétaire pour cette description, marquée `running` pour n'être prise qu'une fois. */
async function takeInvestigation(owner: Party, description: string, timeoutMs = 10_000): Promise<{ runId: string; apiId: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = (
      await sql<{ id: string; api_id: string }>(
        `UPDATE runs SET state = 'running', started_at = now() WHERE id = (
           SELECT r.id FROM runs r JOIN apis a ON a.id = r.api_id WHERE r.owner_id = $1 AND r.kind = 'investigation' AND r.state = 'queued' AND a.description = $2
           ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, api_id`,
        [owner.user.id, description],
      )
    )[0];
    if (row !== undefined) return { runId: row.id, apiId: row.api_id };
    if (Date.now() > deadline) throw new Error('aucune enquête créée');
    await sleep(20);
  }
}

const SCHEMA = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, price: { type: 'number' } } };
const BUDGET = (spent: number) => ({ spent_usd: spent, max_usd: 0.5, elapsed_s: 1, timeout_s: 120 });
const ACCESS_VIEW = { id: '00000000-0000-0000-0000-0000000000a1', checked_at: new Date().toISOString(), signal: 'allowed', usage_signals: [], llms_txt: false, payment_offer: null, official_api_url: null };

/** Worker simulé : enquête lente (un événement tous les `gapMs`), qui s'arrête au schéma proposé en attente de décision. */
async function simulateToSchema(owner: Party, description: string, gapMs: number): Promise<{ runId: string; apiId: string }> {
  const { runId, apiId } = await takeInvestigation(owner, description);
  await emit(runId, 'investigation.started', { phase: 'access_report', url: 'https://zz-books.example/catalogue/', domain: 'zz-books.example', network: 'direct', budget: BUDGET(0) });
  await sleep(gapMs);
  await emit(runId, 'access_report', { id: ACCESS_VIEW.id, view: ACCESS_VIEW, verdict: { proceed: true } });
  await sleep(gapMs);
  await emit(runId, 'phase.started', { phase: 'reconnaissance', budget: BUDGET(0) });
  await sleep(gapMs);
  await emit(runId, 'reconnaissance.finished', { mode: 'static', candidates: [{ id: 'c1' }], document_bytes: 100, total_bytes: 200, budget: BUDGET(0.001) });
  await sleep(gapMs);
  await emit(runId, 'schema.proposed', { ok: true, output_schema: SCHEMA, sample: [{ title: 'zz_test A', price: 1 }, { title: 'zz_test B', price: 2 }], sources: ['c1'], rejected: [], budget: BUDGET(0.002) });
  await emit(runId, 'phase.started', { phase: 'awaiting_schema_validation', plan: [], budget: BUDGET(0.002) });
  await sql("UPDATE apis SET investigation_phase = 'awaiting_schema_validation', investigation = investigation || jsonb_build_object('proposed_schema', $2::jsonb, 'proposed_columns', $3::jsonb) WHERE id = $1", [apiId, JSON.stringify(SCHEMA), JSON.stringify(['title', 'price'])]);
  await sql("UPDATE runs SET state = 'succeeded', outcome = 'clean', finished_at = now(), duration_ms = 3200, cost_llm_usd = 0.002, cost_proxy_usd = 0 WHERE id = $1", [runId]);
  return { runId, apiId };
}

beforeAll(async () => {
  srv = await startTestServer(
    'journey',
    { MAX_WAIT_SECONDS: '5', MAX_CONCURRENT_RUNS: '1000', MAX_ACTIVE_RUNS_PER_USER: '1000', MAX_RUNS_PER_KEY_PER_MINUTE: '1000', MCP_ALLOWED_HOSTS: '127.0.0.1' },
    { rest: { pollMs: POLL_MS, progressHeartbeatMs: HEARTBEAT_MS } },
  );
  const owner = await runSetup(srv);
  ownerCookie = await signIn(srv, owner);
  await srv.app.inject({ method: 'PUT', url: '/api/settings/identity', headers: { cookie: ownerCookie, origin: PUBLIC_URL }, payload: { instance_contact: 'ops@zz-test.example' } });
  const party = async (user: TestUser): Promise<Party> => {
    const cookie = await signIn(srv, user);
    return { user, cookie, key: (await createKey(srv, cookie, user, SCOPES)).key };
  };
  a = await party(await createUser(srv, 'zz_test_journey_a@example.test'));
  b = await party(await createUser(srv, 'zz_test_journey_b@example.test'));
  fr = await party(await createUser(srv, 'zz_test_journey_fr@example.test'));
  await sql("UPDATE users SET locale = 'fr' WHERE id = $1", [fr.user.id]);
  // Case « j'ai lu » (17 § 11) : exigée par la validation automatique, désormais par défaut.
  for (const p of [a, b, fr]) await sql("INSERT INTO responsible_use_acks (user_id, version) VALUES ($1, '2026-10-01') ON CONFLICT DO NOTHING", [p.user.id]);
  base = await srv.app.listen({ port: 0, host: '127.0.0.1' });
}, 180_000);

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  await srv?.close();
});

describe('progression et attente tenue (03 § 3 et § 5)', () => {
  test('le battement par défaut tient sous les 5 s du CDC', () => {
    expect(PROGRESS_HEARTBEAT_MS).toBeLessThan(5_000);
  });

  test('assert_progress_readable — enquête lente : un jalon libellé au moins toutes les 5 s (ici 250 ms), strictement croissant, dans la langue du compte', async () => {
    const description = 'zz_test progression lisible';
    const client = await connect(fr.key);
    const seen: { at: number; progress: number; message: string }[] = [];
    const sim = simulateToSchema(fr, description, 700);
    const started = Date.now();
    const result = await call(client, 'create_api', { description, url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 }, { onprogress: (p) => seen.push({ at: Date.now(), progress: p.progress, message: p.message ?? '' }) });
    await sim;
    expect(result.isError ?? false).toBe(false);
    // 4 événements espacés de 700 ms : sans battement, des trous de 700 ms ; avec le battement, jamais plus que lui (et la relève).
    expect(seen.length).toBeGreaterThanOrEqual(6);
    const gaps = seen.map((p, i) => p.at - (i === 0 ? started : seen[i - 1]!.at));
    expect(Math.max(...gaps.slice(1)), JSON.stringify(gaps)).toBeLessThanOrEqual(600);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!.progress).toBeGreaterThan(seen[i - 1]!.progress);
    expect(seen.every((p) => p.message.length > 0 && p.message.length <= 80), JSON.stringify(seen.map((p) => p.message))).toBe(true);
    // Les battements portent le jalon courant, libellé comme la console, en français pour ce compte.
    const beats = seen.filter((p) => /^\d\/4 /.test(p.message));
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.every((p) => /Décrire|Reconnaître|Valider le schéma|Essayer/.test(p.message))).toBe(true);
    expect(beats.every((p) => / · \d+ s$/.test(p.message))).toBe(true);
  }, 30_000);

  test('assert_wait_honored — get_run(wait_seconds: 2) sur un run qui reste en cours revient à l’échéance, timeline non vide ; un run qui finit pendant l’attente la coupe', async () => {
    const description = 'zz_test attente tenue';
    const client = await connect(a.key);
    const created = await call(client, 'create_api', { description, url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 0 });
    const runId = String(created.structuredContent!['run_id']);
    const { apiId } = await takeInvestigation(a, description);
    const t0 = Date.now();
    const held = await call(client, 'get_run', { run_id: runId, wait_seconds: 2 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThanOrEqual(3_000);
    expect(held.structuredContent).toMatchObject({ state: 'running', next_action: { tool: 'get_run', args: { run_id: runId } } });
    expect((held.structuredContent!['timeline'] as unknown[]).length).toBeGreaterThan(0);
    // Sans `wait_seconds`, la lecture est immédiate.
    const quick = Date.now();
    await call(client, 'get_run', { run_id: runId });
    expect(Date.now() - quick).toBeLessThan(1_000);
    // Le run finit à mi-attente (schéma proposé, décision attendue) : l'appel revient aussitôt, avec le schéma.
    const waiting = call(client, 'get_run', { run_id: runId, wait_seconds: 5 });
    const w0 = Date.now();
    await sleep(500);
    await emit(runId, 'investigation.started', { phase: 'access_report', url: 'https://zz-books.example/catalogue/', domain: 'zz-books.example', network: 'direct', budget: BUDGET(0) });
    await emit(runId, 'schema.proposed', { ok: true, output_schema: SCHEMA, sample: [{ title: 'zz_test A', price: 1 }], sources: ['c1'], rejected: [], budget: BUDGET(0.002) });
    await sql("UPDATE apis SET investigation_phase = 'awaiting_schema_validation', investigation = investigation || jsonb_build_object('proposed_schema', $2::jsonb, 'proposed_columns', $3::jsonb) WHERE id = $1", [apiId, JSON.stringify(SCHEMA), JSON.stringify(['title', 'price'])]);
    await sql("UPDATE runs SET state = 'succeeded', outcome = 'clean', finished_at = now(), duration_ms = 600, cost_llm_usd = 0.002, cost_proxy_usd = 0 WHERE id = $1", [runId]);
    const ended = await waiting;
    expect(Date.now() - w0).toBeLessThan(2_500);
    expect(ended.structuredContent).toMatchObject({ state: 'awaiting_decision', phase: 'validate_schema', progress: { step: 3, of: 4 } });
  }, 30_000);

  test('schéma proposé, échantillon et champs trouvés dans get_run et get_api tant que l’enquête attend une décision (UX-18, UX-36) ; absents pour un autre compte', async () => {
    const description = 'zz_test schema dans get_run';
    const client = await connect(a.key);
    const sim = simulateToSchema(a, description, 20);
    const created = await call(client, 'create_api', { description, url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    const { runId } = await sim;
    expect(created.structuredContent).toMatchObject({ state: 'awaiting_decision', proposed_output_schema: SCHEMA });
    const run = await call(client, 'get_run', { run_id: runId });
    expect(run.structuredContent).toMatchObject({ state: 'awaiting_decision', proposed_output_schema: SCHEMA, fields_found: ['title', 'price'], next_action: { tool: 'validate_schema' } });
    expect((run.structuredContent!['sample'] as unknown[]).length).toBe(2);
    expect(text(run)).toContain('Proposed output schema');
    const slug = String(created.structuredContent!['slug']);
    const api = await call(client, 'get_api', { slug });
    expect(api.structuredContent).toMatchObject({ slug, proposed_output_schema: SCHEMA, fields_found: ['title', 'price'] });
    // Le schéma proposé est celui du propriétaire : un autre compte lit son API d'instance sans la proposition (jamais le schéma d'autrui).
    await sql("UPDATE apis SET visibility = 'instance' WHERE slug = $1", [slug]);
    const other = await call(await connect(b.key), 'get_api', { slug });
    expect(other.structuredContent).not.toHaveProperty('proposed_output_schema');
    expect(other.structuredContent).not.toHaveProperty('question');
  }, 30_000);
});

describe('une demande, une enquête (03 § 9, UXI8)', () => {
  const url = 'https://zz-books.example/une-demande/';

  test('assert_no_duplicate_investigation — la même demande rappelée 3 fois : existing true, même api_id, aucune enquête de plus ; force_new, autre compte et 24 h écoulées en créent une', async () => {
    const client = await connect(a.key);
    const description = 'zz_test une demande une enquête';
    const first = await call(client, 'create_api', { description, url, auto_validate: false, wait_seconds: 0 });
    expect(first.isError, text(first)).not.toBe(true);
    expect(first.structuredContent).toMatchObject({ existing: false });
    const apiId = String(first.structuredContent!['api_id']);
    const runId = String(first.structuredContent!['run_id']);
    const before = await count("SELECT count(*) FROM runs WHERE owner_id = $1 AND kind = 'investigation'", [a.user.id]);
    for (const variant of [{ description, url }, { description: `  ${description.toUpperCase()}  `, url: `${url.replace('https://', 'https://').toUpperCase().slice(0, 8)}${url.slice(8)}#fragment` }, { description, url: url.replace(/\/$/, '') }]) {
      const again = await call(client, 'create_api', { ...variant, auto_validate: false, wait_seconds: 0 });
      expect(again.isError, text(again)).not.toBe(true);
      expect(again.structuredContent).toMatchObject({ existing: true, api_id: apiId, run_id: runId, state: 'running' });
      expect(text(again)).toContain('already working');
    }
    expect(await count("SELECT count(*) FROM runs WHERE owner_id = $1 AND kind = 'investigation'", [a.user.id])).toBe(before);
    // Deux appels qui se croisent n'en créent qu'un.
    const twin = 'zz_test une demande jumelle';
    const [x, y] = await Promise.all([call(client, 'create_api', { description: twin, url, auto_validate: false, wait_seconds: 0 }), call(await connect(a.key), 'create_api', { description: twin, url, auto_validate: false, wait_seconds: 0 })]);
    expect(x.structuredContent!['api_id']).toBe(y.structuredContent!['api_id']);
    expect([x, y].filter((r) => r.structuredContent!['existing'] === true)).toHaveLength(1);
    // `force_new` : une nouvelle API.
    const forced = await call(client, 'create_api', { description, url, auto_validate: false, force_new: true, wait_seconds: 0 });
    expect(forced.structuredContent).toMatchObject({ existing: false });
    expect(forced.structuredContent!['api_id']).not.toBe(apiId);
    // Un autre compte avec la même demande : sa propre API (jamais celle d'autrui).
    const other = await call(await connect(b.key), 'create_api', { description, url, auto_validate: false, wait_seconds: 0 });
    expect(other.structuredContent).toMatchObject({ existing: false });
    expect(other.structuredContent!['api_id']).not.toBe(apiId);
    // Plus de 24 h après la fin de l'enquête : une nouvelle demande est une nouvelle API.
    await sql("UPDATE runs SET state = 'failed', outcome = 'failed', finished_at = now() - interval '25 hours' WHERE api_id IN (SELECT id FROM apis WHERE owner_id = $1 AND description = $2)", [a.user.id, description]);
    await sql("UPDATE apis SET status = 'erreur', investigation_phase = 'done' WHERE id = $1", [apiId]);
    const later = await call(client, 'create_api', { description, url, auto_validate: false, wait_seconds: 0 });
    expect(later.structuredContent).toMatchObject({ existing: false });
    expect(later.structuredContent!['api_id']).not.toBe(apiId);
  }, 30_000);

  test('une enquête annulée par la personne ne compte pas : la même demande crée une nouvelle API', async () => {
    const client = await connect(a.key);
    const description = 'zz_test demande annulee';
    const first = await call(client, 'create_api', { description, url: 'https://zz-books.example/annulee/', auto_validate: false, wait_seconds: 0 });
    await sql("UPDATE runs SET state = 'cancelled', outcome = NULL, finished_at = now() WHERE id = $1", [String(first.structuredContent!['run_id'])]);
    const again = await call(client, 'create_api', { description, url: 'https://zz-books.example/annulee/', auto_validate: false, wait_seconds: 0 });
    expect(again.structuredContent).toMatchObject({ existing: false });
    expect(again.structuredContent!['api_id']).not.toBe(first.structuredContent!['api_id']);
  }, 30_000);

  test('après un échec (dans les 24 h), la demande rend l’API existante et la suite proposée par SYM, jamais un nouveau create_api', async () => {
    const client = await connect(a.key);
    const description = 'zz_test apres echec';
    const created = await call(client, 'create_api', { description, url: 'https://zz-books.example/apres-echec/', auto_validate: false, wait_seconds: 0 });
    const apiId = String(created.structuredContent!['api_id']);
    const slug = String(created.structuredContent!['slug']);
    const runId = String(created.structuredContent!['run_id']);
    await sql("UPDATE runs SET state = 'failed', outcome = 'failed', failure_class = 'extraction', retryable = false, error_detail = 'no_conformant_strategy', started_at = now(), finished_at = now() WHERE id = $1", [runId]);
    await sql("UPDATE apis SET status = 'erreur', status_reason = 'no_conformant_strategy', investigation_phase = 'done' WHERE id = $1", [apiId]);
    const again = await call(client, 'create_api', { description, url: 'https://zz-books.example/apres-echec/', auto_validate: false, wait_seconds: 0 });
    expect(again.structuredContent).toMatchObject({ existing: true, api_id: apiId, state: 'failed', next_action: { tool: 'run_api', args: { slug, force_investigate: true } } });
    expect(await count("SELECT count(*) FROM runs WHERE api_id = $1", [apiId])).toBe(1);
  }, 30_000);
});

describe('auto_validate par défaut, nom et slug court (Q2, UX-08)', () => {
  test('REST : sans auto_validate, la validation automatique est demandée (case « j’ai lu » exigée) ; auto_validate: false garde la porte du schéma', async () => {
    const cookieOnly = await createUser(srv, 'zz_test_journey_noack@example.test');
    const key = (await createKey(srv, await signIn(srv, cookieOnly), cookieOnly, SCOPES)).key;
    const post = (payload: Record<string, unknown>) => srv.app.inject({ method: 'POST', url: '/api/apis?wait=0', headers: { authorization: `Bearer ${key}` }, payload });
    const refused = await post({ description: 'zz_test defaut auto', url: 'https://zz-books.example/defaut/' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'responsible_use_ack_required' } });
    const gated = await post({ description: 'zz_test defaut porte', url: 'https://zz-books.example/defaut/', auto_validate: false });
    expect(gated.statusCode).toBe(201);
    expect((await sql<{ v: string }>("SELECT investigation #>> '{request,auto_validate}' AS v FROM apis WHERE id = $1", [gated.json<{ api_id: string }>().api_id]))[0]!.v).toBe('false');
    await sql("INSERT INTO responsible_use_acks (user_id, version) VALUES ($1, '2026-10-01') ON CONFLICT DO NOTHING", [cookieOnly.id]);
    const auto = await post({ description: 'zz_test defaut auto ok', url: 'https://zz-books.example/defaut/' });
    expect(auto.statusCode).toBe(201);
    expect((await sql<{ v: string }>("SELECT investigation #>> '{request,auto_validate}' AS v FROM apis WHERE id = $1", [auto.json<{ api_id: string }>().api_id]))[0]!.v).toBe('true');
  });

  test('MCP : create_api sans auto_validate lance une enquête à validation automatique ; le nom donné court le slug et reste lisible ; sans nom, slug court tiré du domaine', async () => {
    const client = await connect(a.key);
    const named = await call(client, 'create_api', { description: 'zz_test les maisons à vendre de cette agence', url: 'https://www.janssens-immobilier.example/biens/', name: 'Biens Janssens', wait_seconds: 0 });
    expect(named.isError, text(named)).not.toBe(true);
    expect(named.structuredContent).toMatchObject({ name: 'Biens Janssens' });
    expect(String(named.structuredContent!['slug'])).toMatch(/^biens-janssens-[0-9a-f]{6}$/);
    expect((await sql<{ v: string }>("SELECT investigation #>> '{request,auto_validate}' AS v FROM apis WHERE id = $1", [String(named.structuredContent!['api_id'])]))[0]!.v).toBe('true');
    const plain = await call(client, 'create_api', { description: 'Récupère toutes les maisons à vendre', url: 'https://www.janssens-immobilier.example/biens/', wait_seconds: 0 });
    expect(String(plain.structuredContent!['slug'])).toMatch(/^maisons-janssens-immobilier-[0-9a-f]{6}$/);
    expect(plain.structuredContent!['name']).toBe('Maisons Janssens Immobilier');
    expect(String(plain.structuredContent!['slug']).length).toBeLessThanOrEqual(50);
  });
});
