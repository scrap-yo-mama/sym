// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.3 de bout en bout sur base réelle, faux fournisseur LLM (rôle `repair`, 15 §4), fixtures « change sur commande »
// (0.5) : run mis en file → worker → exécuteur de stratégie (gardes de 1.6, 1.7, 1.11) → items triés (D-49) → réparation
// dans le même run (patch JSON borné, validation contre le schéma ET les dernières sorties saines, arrêt sur correctif
// répété, bail) → vN+1, statut (04 §6 : 5, 10, 12, 13).
// Critères : fixture qui change → v+1 conforme livrée, `warning` ; correctif répété → `erreur` ; `output_schema` jamais
// modifié ; `assert_rejected_items_quarantined`, `assert_delivered_items_conform`, `assert_rejection_threshold_breaks`.
// Mutations du banc (15 §11) jouées ici avec un correctif scripté : `rename_field`, `wrap_in_envelope`, `type_change`,
// `dom_selector_shift` (site `dom`, version 2) réparées ; `move_endpoint` non réparée (l'URL de la requête est hors du
// patch borné, 04b §2), stratégie précédente conservée. Le taux réel par modèle relève du banc (2.8).
import { randomUUID } from 'node:crypto';
import { DomainPacer, generateMasterKey, MasterKey, Secret, validateOutput, type RunExecutor } from '@runtime/core';
import * as net from '@runtime/core/net';
import { createRun, keyCheck, migrateUp, PgBossJobQueue, PgPacingStore, readRejectedItems, readRun, runQueueDefinition, withActor } from '@runtime/db';
import { createLlmClient, type LlmConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider, type ScriptedStep } from '@runtime/llm/testing';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { contactsSpecInput, fixtureGuard, SCHEMA_CONTACT } from '../../../../tests/helpers/fixture-net.ts';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { createRepairPort } from './repair-executor.js';
import { createStrategyRuntime, type RepairPort } from './strategy-executor.js';

const API_HOST = 'zz_test_api_json.localhost';
const DOM_HOST = 'zz_test_dom.localhost';
const MODEL = 'zz_repair';
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };

/** Contacts + un objet `extra` fermé : une clé inconnue sous `extra` rend l'item non conforme (D-49). */
const SCHEMA_EXTRA = {
  ...SCHEMA_CONTACT,
  properties: { ...SCHEMA_CONTACT.properties, extra: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false } },
};
const SCHEMA_TITLE = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1 } }, additionalProperties: false };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let client: Client;
let worker: Worker;
let fake: FakeProvider;
/** Version courante de l'API lue au retour du port de réparation, c'est-à-dire avant que le run ne reprenne la main. */
const currentAtPortReturn = new Map<string, number[]>();

const base = (host: string) => `http://${host}:${client.server.port}`;

function llmConfig(): LlmConfig {
  return {
    providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: MODEL, price: { in: 1, out: 1 } }] }],
    roles: { repair: { provider: 'fake', model: MODEL } },
  };
}

/** Réponse scriptée du rôle `repair` : opérations RFC 6902, valeur en texte JSON (`value_json`). */
const proposal = (ops: { op: string; path: string; value?: unknown; from?: string }[]) =>
  scripted.json({ patch: ops.map((o) => ({ op: o.op, path: o.path, from: o.from ?? null, value_json: o.value === undefined ? null : JSON.stringify(o.value) })) });

async function insertApi(slug: string, spec: unknown, outputSchema: unknown, execution = 'fetch'): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, output_schema, status, domain_pacing) VALUES ($1, $2, $3, 'sain', '{"min_delay_ms": 2, "max_requests_per_run": 200, "max_wait_ms": 60000}') RETURNING id`,
      [slug, A, JSON.stringify(outputSchema)],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, $3, 'direct', $4, 0, 'investigation')", [
    id,
    A,
    execution,
    JSON.stringify(spec),
  ]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

const runOf = async (apiId: string) => {
  const { runId } = await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), {
    timeout: 45_000,
    interval: 100,
  });
  return (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
};

const apiRow = async (apiId: string) =>
  (await pool.query<{ status: string; status_reason: string | null; current_strategy_version: number; output_schema: unknown }>('SELECT status, status_reason, current_strategy_version, output_schema FROM apis WHERE id = $1', [apiId])).rows[0]!;
const transitions = async (apiId: string) =>
  (await pool.query<{ from_status: string; to_status: string; reason: string }>('SELECT from_status, to_status, reason FROM status_events WHERE api_id = $1 ORDER BY id', [apiId])).rows.map((r) => `${r.from_status}>${r.to_status}:${r.reason}`);
const itemsOf = async (datasetId: string | null) =>
  datasetId === null ? [] : (await withActor(pool, actorA, (tx) => tx.query<{ item: Record<string, unknown> }>('SELECT item FROM dataset_items WHERE dataset_id = $1 ORDER BY seq', [datasetId]))).rows.map((r) => r.item);
const versions = async (apiId: string) =>
  (await pool.query<{ version: number; created_by: string; parent_version: number | null; patch: unknown; execution: string }>('SELECT version, created_by, parent_version, patch, execution FROM strategy_versions WHERE api_id = $1 ORDER BY version', [apiId])).rows;
const logEvents = async (runId: string) => (await pool.query<{ event: string; data: unknown }>('SELECT event, data FROM run_logs WHERE run_id = $1 ORDER BY seq', [runId])).rows;
const site = (siteId: string, args: Record<string, unknown>) => client.control({ op: 'site', site: siteId, ...args });

beforeAll(async () => {
  client = await startClient();
  fake = await createFakeProvider();
  tdb = await createTestDatabase('repair');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 8 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_repair@example.test', 'active')", [A]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(client.server.port, [API_HOST, DOM_HOST], net);
  const inner = createRepairPort({ pool, browser: false, llm: { config: async () => llmConfig(), client: (config) => createLlmClient(config) }, leaseWaitMs: 15_000 });
  // Observation du bail : quand le port rend la main, il a libéré le bail ; vN+1 doit déjà être la version courante.
  const repair: RepairPort = async (request) => {
    const out = await inner(request);
    if (out.kind === 'repaired') {
      const { rows } = await pool.query<{ v: number }>('SELECT current_strategy_version AS v FROM apis WHERE id = $1', [request.ctx.apiId]);
      currentAtPortReturn.set(request.ctx.apiId, [...(currentAtPortReturn.get(request.ctx.apiId) ?? []), rows[0]!.v]);
    }
    return out;
  };
  const strategy = createStrategyRuntime({ pool, guard, pacer: new DomainPacer(new PgPacingStore(pool)), browsers: null, repair, instanceContact: async () => 'mailto:ops@zz-test.example', version: '9.9.9' });
  const executor: RunExecutor = strategy.executor;
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
  await client?.close();
});

beforeEach(async () => {
  fake.reset();
  await client.reset();
});

/** API de contacts saine, puis un run de référence (sorties saines) avant la mutation. */
async function healthyContacts(slug: string, schema: unknown = SCHEMA_CONTACT): Promise<string> {
  const spec = contactsSpecInput(base(API_HOST), API_HOST, 50);
  if (schema === SCHEMA_EXTRA) spec['fields'] = { ...(spec['fields'] as object), extra: { path: '$.extra', type: 'object' } };
  const apiId = await insertApi(slug, spec, schema);
  const ref = await runOf(apiId);
  expect(ref).toMatchObject({ state: 'succeeded', outcome: 'clean', items: 500, items_rejected: 0 });
  return apiId;
}

describe('items non conformes écartés (D-49)', () => {
  test('assert_rejected_items_quarantined, assert_delivered_items_conform — 1 item hors schéma : 499 livrés, 1 en quarantaine, warning (5), aucune réparation', async () => {
    const apiId = await healthyContacts('zz_test_one_bad', SCHEMA_EXTRA);
    await site('api_json', { mutation: 'one_item_bad_type' });
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'succeeded', outcome: 'degraded', items: 499, items_rejected: 1, strategy_version: 1 });
    expect(run.degraded_reasons).toEqual(['items_rejected']);
    expect(run.rejected).toEqual({ count: 1, by_reason: expect.arrayContaining([{ keyword: 'type', path: '/score', count: 1 }, { keyword: 'additionalProperties', path: '/extra/contact_email', count: 1 }]) as unknown });
    // Livré = conforme (INV1) : aucun item du dataset n'est hors schéma.
    const items = await itemsOf(run.dataset_id);
    expect(items).toHaveLength(499);
    for (const item of items) expect(validateOutput(SCHEMA_EXTRA, item)).toEqual({ ok: true });
    // Échantillon : lisible par l'appelant, clé inconnue retirée, e-mail nulle part (motif masqué), valeur en erreur masquée.
    const read = await readRejectedItems(pool, actorA, run.id);
    expect(read?.access).toBe('caller');
    const sample = read?.access === 'caller' ? read.sample : [];
    expect(sample).toHaveLength(1);
    expect(sample[0]).toMatchObject({ score: '[masqué]', extra: {} });
    const everywhere = JSON.stringify((await pool.query('SELECT to_jsonb(q) AS q FROM run_rejected_items q WHERE run_id = $1', [run.id])).rows);
    expect(everywhere).not.toContain('example.invalid');
    expect(everywhere).not.toContain('zz_test_leak');
    // Statut : sain → warning par la transition 5 (`items_rejected`), aucun appel au rôle `repair`.
    expect(await transitions(apiId)).toEqual(['sain>warning:items_rejected']);
    expect(fake.requests).toBe(0);
    // Essai journalisé ok (le run a livré) ; webhook run.succeeded porterait items_rejected = 1 (`runs.items_rejected`).
    expect(run.attempts).toEqual([expect.objectContaining({ execution: 'fetch', network: 'direct', result: 'ok' })]);
  });

  test('assert_rejection_threshold_breaks — 30 % hors schéma (≥ 5) : casse `extraction`, réparation dans le même run, rien de livré', async () => {
    const apiId = await healthyContacts('zz_test_30pct');
    await site('api_json', { mutation: 'bad_items_30pct' });
    // Aucun patch ne rend conformes des données fausses : le modèle répond une liste vide, pas d'escalade sans Chromium.
    fake.setScenario(MODEL, [scripted.json({ patch: [] })]);
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'extraction', items: 0, dataset_id: null });
    expect(run.attempts[0]).toMatchObject({ result: 'extraction' });
    expect(fake.requests).toBe(1);
    // Aucun dataset ne contient un item non conforme (aucun dataset du tout pour ce run) ; quarantaine écrite (diagnostic).
    expect((await pool.query('SELECT 1 FROM datasets WHERE run_id = $1', [run.id])).rowCount).toBe(0);
    expect((await pool.query<{ total_rejected: number }>('SELECT total_rejected FROM run_rejected_items WHERE run_id = $1', [run.id])).rows[0]!.total_rejected).toBe(150);
    // 10 (réparation) puis 13 (budget épuisé) ; stratégie précédente conservée.
    expect(await transitions(apiId)).toEqual(['sain>reparation:extraction', 'reparation>erreur:repair_budget_exhausted']);
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', current_strategy_version: 1 });
    expect(await versions(apiId)).toHaveLength(1);
  });
});

describe('réparation dans le même run (04 §5)', () => {
  test.each([
    ['rename_field', [{ op: 'replace', path: '/fields/name/path', value: '$.full_name' }]],
    [
      'wrap_in_envelope',
      [
        { op: 'replace', path: '/sources/0/records', value: '$.data.results[*]' },
        { op: 'replace', path: '/pagination/stop/1/path', value: '$.data.meta.has_more' },
      ],
    ],
    ['type_change', [{ op: 'add', path: '/fields/score/ops', value: ['to_number'] }]],
  ] as const)('fixture « change sur commande » (%s) : v+1 conforme livrée, warning (10 puis 12), output_schema inchangé', async (mutation, ops) => {
    const apiId = await healthyContacts(`zz_test_fix_${mutation}`);
    const schemaBefore = (await apiRow(apiId)).output_schema;
    await site('api_json', { mutation });
    fake.setScenario(MODEL, [proposal(ops as unknown as { op: string; path: string; value?: unknown }[])]);
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'succeeded', outcome: 'degraded', items: 500, items_rejected: 0, strategy_version: 2 });
    expect(run.degraded_reasons).toContain('repaired');
    for (const item of await itemsOf(run.dataset_id)) expect(validateOutput(SCHEMA_CONTACT, item)).toEqual({ ok: true });
    expect(await transitions(apiId)).toEqual(['sain>reparation:extraction', 'reparation>warning:repaired']);
    const api = await apiRow(apiId);
    expect(api).toMatchObject({ status: 'warning', status_reason: 'repaired', current_strategy_version: 2 });
    expect(api.output_schema).toEqual(schemaBefore);
    const v = await versions(apiId);
    expect(v[1]).toMatchObject({ version: 2, created_by: 'repair', parent_version: 1, execution: 'fetch' });
    expect(v[1]!.patch).toEqual(ops);
    // Deux essais journalisés : la v1 en échec, la candidate réparée.
    expect(run.attempts.map((a) => a.result)).toEqual(['extraction', 'ok']);
    // Le rôle `repair` n'a vu que des squelettes : aucune valeur de contact dans le prompt.
    expect(fake.requests).toBe(1);
    const prompt = JSON.stringify(fake.calls[0]!.body);
    expect(prompt).not.toMatch(/Zztest|example\.invalid|zz_test_contact_0001/);
    // Le run suivant rejoue vN+1 sans LLM.
    const next = await runOf(apiId);
    expect(next).toMatchObject({ state: 'succeeded', strategy_version: 2, items: 500 });
    expect(fake.requests).toBe(1);
  });

  test('dom_selector_shift (site dom, version 2) : sélecteurs corrigés par un patch sur sources et fields, v2 conforme', async () => {
    const spec = {
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `${base(DOM_HOST)}/`, allowed_hosts: [DOM_HOST] },
      sources: [{ id: 'dom', from: 'html', records: 'li.item' }],
      fields: { title: { css: '.item-title', attr: 'text', type: 'string', required: true, ops: ['trim'] } },
    };
    const apiId = await insertApi('zz_test_dom_shift', spec, SCHEMA_TITLE);
    expect(await runOf(apiId)).toMatchObject({ state: 'succeeded', items: 25 });
    await site('dom', { version: 2 });
    const ops = [
      { op: 'replace', path: '/sources/0/records', value: '.card' },
      { op: 'replace', path: '/fields/title/css', value: '.card__name' },
    ];
    fake.setScenario(MODEL, [proposal(ops)]);
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'succeeded', items: 25, strategy_version: 2 });
    expect(await apiRow(apiId)).toMatchObject({ status: 'warning', status_reason: 'repaired' });
    // Le prompt porte la forme de la page (squelette HTML), jamais ses valeurs.
    const prompt = JSON.stringify(fake.calls[0]!.body);
    expect(prompt).toContain('card__name');
    expect(prompt).not.toContain('Zztest');
  });

  test('move_endpoint : non réparée (URL hors du patch borné, pas d’escalade sans Chromium) → erreur, v1 conservée', async () => {
    const apiId = await healthyContacts('zz_test_moved');
    await site('api_json', { mutation: 'move_endpoint' });
    // Un patch qui viserait l'URL de la requête est refusé (racine `request` hors de sources, fields, pagination).
    fake.setScenario(MODEL, [proposal([{ op: 'replace', path: '/request/url', value: `${base(API_HOST)}/api/v2/contacts?per_page=50` }]), scripted.json({ patch: [] })]);
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'not_found' });
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', current_strategy_version: 1 });
    expect(await versions(apiId)).toHaveLength(1);
    const refused = (await logEvents(run.id)).find((e) => e.event === 'repair_patch_refused');
    expect(refused?.data).toMatchObject({ codes: ['forbidden_path'] });
  });

  test('correctif répété → arrêt, erreur (13 `repair_repeated_patch`), stratégie précédente conservée', async () => {
    const apiId = await healthyContacts('zz_test_repeat');
    await site('api_json', { mutation: 'rename_field' });
    const wrong = [{ op: 'replace', path: '/fields/name/path', value: '$.nom' }];
    fake.setScenario(MODEL, [proposal(wrong), proposal(wrong), proposal(wrong)]);
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'failed', failure_class: 'extraction' });
    expect(fake.requests).toBe(2);
    expect(await transitions(apiId)).toEqual(['sain>reparation:extraction', 'reparation>erreur:repair_repeated_patch']);
    expect(await apiRow(apiId)).toMatchObject({ status: 'erreur', current_strategy_version: 1 });
    expect(await versions(apiId)).toHaveLength(1);
    expect((await logEvents(run.id)).map((e) => e.event)).toContain('repair_repeated_patch');
  });

  test('assert_output_schema_enforced — un patch sur output_schema est refusé, un faux succès (champ stable perdu) aussi ; la 3e proposition répare', async () => {
    const apiId = await healthyContacts('zz_test_guarded');
    const schemaBefore = (await apiRow(apiId)).output_schema;
    await site('api_json', { mutation: 'rename_field' });
    fake.setScenario(MODEL, [
      // 1. Assouplir le schéma (retirer `name` des requis) : refusé avant tout essai.
      proposal([{ op: 'remove', path: '/output_schema/required/1' }]),
      // 2. Conforme au schéma, mais `city` (toujours remplie dans les sorties saines) disparaît : faux succès refusé.
      proposal([
        { op: 'replace', path: '/fields/name/path', value: '$.full_name' },
        { op: 'remove', path: '/fields/city' },
      ]),
      // 3. Le bon correctif.
      proposal([{ op: 'replace', path: '/fields/name/path', value: '$.full_name' }]),
    ]);
    const run = await runOf(apiId);
    expect(run).toMatchObject({ state: 'succeeded', strategy_version: 2, items: 500 });
    const api = await apiRow(apiId);
    expect(api.output_schema).toEqual(schemaBefore);
    expect(api).toMatchObject({ status: 'warning', current_strategy_version: 2 });
    const events = await logEvents(run.id);
    expect(events.find((e) => e.event === 'repair_patch_refused')?.data).toMatchObject({ codes: ['forbidden_output_schema'] });
    expect(events.find((e) => e.event === 'repair_false_success')?.data).toMatchObject({ missing: ['/city'] });
    // Essais journalisés : v1, la candidate « faux succès », la candidate retenue (le patch refusé n'a rien rejoué).
    expect(run.attempts.map((a) => a.result)).toEqual(['extraction', 'ok', 'ok']);
    expect((await versions(apiId))[1]!.patch).toEqual([{ op: 'replace', path: '/fields/name/path', value: '$.full_name' }]);
  });
});

describe('bail de réparation (04 §5)', () => {
  test('une seule réparation à la fois par API : vN+1 est courante avant la libération du bail ; le run concurrent attend puis rejoue vN+1 sans LLM', async () => {
    const apiId = await healthyContacts('zz_test_lease');
    await site('api_json', { mutation: 'rename_field' });
    const ops = [{ op: 'replace', path: '/fields/name/path', value: '$.full_name' }];
    // La proposition tarde : le second run casse pendant ce temps et trouve le bail tenu.
    fake.setScenario(MODEL, [{ ...proposal(ops), delayMs: 1_500 } as ScriptedStep, proposal(ops)]);
    const [a, b] = await Promise.all([runOf(apiId), runOf(apiId)]);
    // Un seul appel au rôle `repair`, une seule vN+1.
    expect(fake.requests).toBe(1);
    expect(await versions(apiId)).toHaveLength(2);
    expect(currentAtPortReturn.get(apiId)).toEqual([2]);
    for (const run of [a, b]) expect(run).toMatchObject({ state: 'succeeded', items: 500, items_rejected: 0, strategy_version: 2 });
    // Une seule entrée en `reparation` et une seule sortie (12) ; l'autre run a attendu le bail.
    expect(await transitions(apiId)).toEqual(['sain>reparation:extraction', 'reparation>warning:repaired']);
    const waited = [...(await logEvents(a.id)), ...(await logEvents(b.id))].filter((e) => e.event === 'repair_lease_waited');
    expect(waited).toEqual([expect.objectContaining({ data: expect.objectContaining({ from_version: 1, current_version: 2 }) as unknown })]);
    expect((await pool.query<{ owner: string | null }>('SELECT repair_lease_owner AS owner FROM apis WHERE id = $1', [apiId])).rows[0]!.owner).toBeNull();
  });
});
