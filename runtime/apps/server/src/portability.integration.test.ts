// SPDX-License-Identifier: AGPL-3.0-only
// Portabilité (tâche 3.12, 16 § 6) sur un serveur réel et une base migrée :
// - `assert_export_no_secret` (INV5, INV8) : l'export d'une API à session, avec cookie de site, clé LLM, identifiants de
//   proxy, secret et URL de webhook, données de run, ne porte AUCUN de ces éléments, ni dans le fichier, ni dans le
//   journal du serveur, ni en base (audit) ; l'import ne recopie ni session ni secret ;
// - un import repasse par l'enquête : aperçu sans écriture, puis confirmation → API en `enquete`, phase `access_check`,
//   run d'enquête en file, schéma validé et stratégie importée dans l'état d'enquête (aucun nouvel état, INV3) ; `$ref`
//   distant refusé (INV1), champs inconnus ignorés, empreinte vérifiée ;
// - OpenAPI par API (`/api/apis/{slug}/openapi.json`) : schémas d'entrée et de sortie, section `webhooks`, types
//   générables par openapi-typescript ; l'OpenAPI principale porte aussi sa section `webhooks` ;
// - les modèles de `templates/` s'importent sur une instance vierge.
// Chaque réponse est validée contre l'OpenAPI SERVIE (contrat). Aucun worker : rien n'est demandé à un site.
import { readdirSync, readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { createConfig, lintFromString } from '@redocly/openapi-core';
import { createLogger, parseApiExport, sealExport, type ApiExportDraft } from '@runtime/core';
import type { FastifyBaseLogger } from 'fastify';
import openapiTS, { astToString } from 'openapi-typescript';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { OpenApiContract } from '../../../tests/helpers/openapi-contract.js';
import { withClient } from '../../../tests/helpers/pg.js';
import { seedApi, seedRun, seedSchedule } from '../../../tests/helpers/rest-seed.js';
import { createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';

type Party = { user: TestUser; cookie: string };

const TEMPLATES = new URL('../../../templates/', import.meta.url);

/** Marqueurs de secrets et de données de run : aucun ne doit sortir d'un export, d'un journal ou d'une ligne d'audit. */
const MARK = {
  cookie: 'zz_test_COOKIE_7f3a9c',
  llmKey: 'zz_test_LLMKEY_51d0e2',
  proxy: 'zz_test_PROXYPASS_a8b4c1',
  hookToken: 'zz_test_HOOKTOKEN_93e7f0',
  hookSecret: 'zz_test_WHSEC_2c6d18',
  runData: 'zz_test_RUNDATA_b70e44',
  runLog: 'zz_test_RUNLOG_6aa1f9',
  sample: 'zz_test_SAMPLE_0d93be',
};

const OUTPUT = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, price: { type: 'number' }, note: { type: 'string' } } };
const SPEC = {
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: 'https://shop.zz-test.example/api/books?page=1', allowed_hosts: ['shop.zz-test.example'], params: [{ at: 'url.query.page', role: 'pagination' }] },
  sources: [{ id: 'api', from: 'response', format: 'json', records: '$.books[*]' }],
  fields: { title: { path: '$.title', type: 'string', required: true }, price: { path: '$.price', type: 'number' }, note: { path: '$.note', type: 'string' } },
  pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }], limits: { max_pages_input: 'input.max_pages', hard_max_pages: 50 } },
  limits: { max_response_bytes: 5_000_000, timeout_ms: 15_000 },
};
const INPUT = {
  type: 'object',
  additionalProperties: false,
  properties: { max_pages: { type: 'integer', minimum: 1, maximum: 50, description: 'Nombre maximal de pages lues par run (une page par requête).' } },
};

let srv: TestServer;
let contract: OpenApiContract;
let a: Party;
let b: Party;
const logLines: string[] = [];

async function api(party: Party | null, method: string, url: string, template: string, payload?: unknown) {
  const res = await srv.app.inject({
    method: method as 'GET',
    url,
    headers: { ...(party ? { cookie: party.cookie } : {}), ...(method === 'GET' ? {} : { origin: PUBLIC_URL }) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  const json = (res.headers['content-type'] ?? '').startsWith('application/json') && res.body !== '' ? (res.json() as unknown) : undefined;
  expect(contract.check(method, template, res.statusCode, json), `${method} ${url} → ${res.statusCode} ${res.body.slice(0, 300)}`).toEqual([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- corps JSON lu librement par les assertions (déjà validé au contrat ci-dessus)
  return { status: res.statusCode, body: json as Record<string, any>, raw: res };
}

const count = async (sql: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => Number(Object.values((await c.query<Record<string, string>>(sql, params)).rows[0]!)[0]));

/** API de A à session, prête à exporter : enquête connue, stratégie déclarative, planification, webhook, run, secrets. */
async function seedSessionApi(owner: Party): Promise<{ id: string; slug: string }> {
  const seeded = await seedApi(srv.db.url, owner.user.id, { requiresSession: true });
  await withClient(srv.db.url, async (c) => {
    await c.query(
      `UPDATE apis SET requires = '{"session_domain": "shop.zz-test.example"}', investigation_phase = 'done',
         investigation = $2::jsonb, purpose = 'veille de prix zz', max_cost_usd = 0.4, budget_daily_usd = 3
       WHERE id = $1`,
      [
        seeded.id,
        JSON.stringify({
          request: { url: 'https://shop.zz-test.example/books', description: 'Les livres zz test', auto_validate: false, budget_usd: 1, timeout_s: 600 },
          candidates: [{ id: 'c1', from: 'response', request: { method: 'GET', url: `https://shop.zz-test.example/api/books?sample=${MARK.sample}` } }],
          spent_usd: 0,
          elapsed_ms: 0,
        }),
      ],
    );
    await c.query("UPDATE strategy_versions SET spec = $2::jsonb, est_cost_usd = 0.0002 WHERE api_id = $1 AND version = 1", [seeded.id, JSON.stringify(SPEC)]);
    await c.query('UPDATE apis SET input_schema = $2::jsonb WHERE id = $1', [seeded.id, JSON.stringify(INPUT)]);
    // Cookie de site (INV5) et secrets chiffrés (INV8) : les octets portent un marqueur lisible, pour le voir s'il fuyait.
    await c.query("INSERT INTO site_sessions (owner_id, domain, server_use_allowed, ciphertext, nonce, dek_wrapped, alg, key_version) VALUES ($1, 'shop.zz-test.example', true, $2, $3, 'zz_dek', 'aes-256-gcm', 1)", [
      owner.user.id,
      Buffer.from(`sid=${MARK.cookie}`),
      Buffer.from('zz_nonce_000'),
    ]);
    const secret = async (kind: string, value: string) =>
      (
        await c.query<{ id: string }>(
          "INSERT INTO secrets (owner_id, kind, label, ciphertext, nonce, aad, dek_wrapped, kek_version) VALUES ($1, $2, $3, $4, 'n', 'a', 'd', 1) RETURNING id",
          [owner.user.id, kind, `zz_test ${kind}`, Buffer.from(value)],
        )
      ).rows[0]!.id;
    await secret('llm_key', MARK.llmKey);
    const hookSecret = await secret('webhook_secret', MARK.hookSecret);
    await c.query(
      "INSERT INTO settings (key, value) VALUES ('proxies', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [JSON.stringify([{ id: 'zz_test_dc', type: 'dc', url: `http://zzuser:${MARK.proxy}@127.0.0.1:9`, price: { per_gb_usd: 1 } }])],
    );
    await c.query("INSERT INTO webhook_subscriptions (owner_id, api_id, url, events, secret_id) VALUES ($1, $2, $3, '{run.failed,api.status_changed}', $4)", [
      owner.user.id,
      seeded.id,
      `https://hooks.zz-test.example/in?token=${MARK.hookToken}`,
      hookSecret,
    ]);
  });
  await seedSchedule(srv.db.url, seeded.id, owner.user.id);
  const run = await seedRun(srv.db.url, { apiId: seeded.id, ownerId: owner.user.id, items: [{ title: MARK.runData, price: 1 }] });
  await withClient(srv.db.url, (c) => c.query("INSERT INTO run_logs (run_id, seq, owner_id, level, event, data) VALUES ($1, 9, $2, 'info', 'zz_test_marker', $3)", [run.runId, owner.user.id, JSON.stringify({ v: MARK.runLog })]));
  return seeded;
}

function draft(over: Partial<ApiExportDraft['api']> = {}, rest: Partial<ApiExportDraft> = {}): ApiExportDraft {
  return {
    format: 'scrapyomama.api',
    format_version: '1.0',
    min_runtime_version: '0.0.0',
    exported_at: '2026-10-02T10:00:00.000Z',
    api: {
      slug: 'zz-test-books-000000',
      description: 'Les livres zz test importés',
      source_url: 'https://shop.zz-test.example/books',
      input_schema: INPUT,
      output_schema: OUTPUT,
      output_columns: ['title', 'price', 'note'],
      views: {},
      purpose: null,
      legal_basis: null,
      contains_personal_data: false,
      max_cost_usd: 0.4,
      budget_daily_usd: 3,
      network_policy: { allow: ['direct'] },
      alert_targets: [],
      ...over,
    },
    strategy: { execution: 'fetch', network: 'direct', spec: SPEC, est_cost_usd: 0.0002 },
    schedules: [{ cron: '0 3 * * *', timezone: 'UTC', input: {}, rules: {}, overlap: 'skip', missed: 'skip', enabled: true }],
    ...rest,
  };
}

beforeAll(async () => {
  const destination = new Writable({
    write(chunk: Buffer, _e, done) {
      logLines.push(chunk.toString());
      done();
    },
  });
  srv = await startTestServer('portability', { NODE_ENV: 'test', MAX_CONCURRENT_RUNS: '1000', MAX_ACTIVE_RUNS_PER_USER: '1000' }, {
    loggerInstance: createLogger({ name: 'server', level: 'trace', destination }) as FastifyBaseLogger,
  });
  const o = await runSetup(srv);
  const party = async (user: TestUser): Promise<Party> => ({ user, cookie: await signIn(srv, user) });
  await party(o);
  a = await party(await createUser(srv, 'zz_test_port_a@example.test'));
  b = await party(await createUser(srv, 'zz_test_port_b@example.test'));
  const doc = await srv.app.inject({ method: 'GET', url: '/api/openapi.json', headers: { cookie: a.cookie } });
  contract = new OpenApiContract(doc.json());
}, 180_000);

afterAll(async () => {
  await srv?.close();
});

describe('assert_export_no_secret (INV5, INV8)', () => {
  test('export d’une API à session : ni cookie, ni session, ni clé LLM, ni proxy, ni secret ou URL de webhook, ni donnée de run — fichier, journal et base', async () => {
    const seeded = await seedSessionApi(a);
    const secretsBefore = await count('SELECT count(*) FROM secrets');
    const sessionsBefore = await count('SELECT count(*) FROM site_sessions');

    const res = await api(a, 'GET', `/api/apis/${seeded.slug}/export`, '/api/apis/{slug}/export');
    expect(res.status).toBe(200);
    // Fichier téléchargeable, JSON à clés triées.
    expect(String(res.raw.headers['content-disposition'])).toMatch(/^attachment; filename="[a-z0-9-]+\.api\.json"$/);
    const file = res.raw.body;
    for (const [name, marker] of Object.entries(MARK)) expect(file, name).not.toContain(marker);
    expect(file).not.toMatch(/zzuser|hooks\.zz-test\.example|session_domain|requires_session|"cookie|ciphertext|secret_id|proxy_ids|"investigation":/i);
    expect(Object.keys(JSON.parse(file) as object)).toEqual(Object.keys(JSON.parse(file) as object).sort());

    const doc = res.body;
    expect(doc).toMatchObject({ format: 'scrapyomama.api', format_version: '1.0', api: { slug: seeded.slug, source_url: 'https://shop.zz-test.example/books', output_schema: OUTPUT, input_schema: INPUT } });
    // Une API à session exporte sa définition, JAMAIS la session : aucune trace dans le format (INV5).
    expect(doc['api']).not.toHaveProperty('requires');
    // Cibles d'alerte en référence, sans URL ni secret.
    expect(doc['api']['alert_targets']).toEqual([{ ref: '$ALERT_WEBHOOK_1', events: ['api.status_changed', 'run.failed'] }]);
    expect(doc['strategy']).toEqual({ execution: 'fetch', network: 'direct', spec: SPEC, est_cost_usd: 0.0002 });
    expect(doc['schedules']).toEqual([{ cron: '0 3 * * *', timezone: 'UTC', input: {}, rules: {}, overlap: 'skip', missed: 'skip', enabled: false }]);
    expect(doc['history']).toEqual([expect.objectContaining({ version: 1, execution: 'fetch', network: 'direct', created_by: 'investigation' })]);
    // L'empreinte se vérifie (le fichier se relit tel quel).
    expect(parseApiExport(JSON.parse(file), { runtimeVersion: '0.0.0' })).toMatchObject({ ok: true, ignored: [] });

    // Journal du serveur et base (audit) : aucun marqueur.
    const imported = await api(a, 'POST', '/api/apis/import?confirm=true', '/api/apis/import', JSON.parse(file));
    expect(imported.status).toBe(201);
    const log = logLines.join('');
    expect(log.length).toBeGreaterThan(0);
    for (const [name, marker] of Object.entries(MARK)) expect(log, name).not.toContain(marker);
    const audits = await withClient(srv.db.url, async (c) => (await c.query<{ action: string; meta: unknown }>("SELECT action, meta FROM audit_events WHERE action IN ('api.exported', 'api.imported')")).rows);
    expect(audits.map((r) => r.action).sort()).toEqual(['api.exported', 'api.imported']);
    for (const [name, marker] of Object.entries(MARK)) expect(JSON.stringify(audits), name).not.toContain(marker);

    // L'import ne recopie ni session ni secret ni abonnement webhook ; l'API importée est sans session (INV5).
    expect(await count('SELECT count(*) FROM secrets')).toBe(secretsBefore);
    expect(await count('SELECT count(*) FROM site_sessions')).toBe(sessionsBefore);
    const row = await withClient(srv.db.url, async (c) => (await c.query<{ requires_session: boolean; requires: unknown; network_policy: unknown }>('SELECT requires_session, requires, network_policy FROM apis WHERE id = $1', [imported.body['api_id']])).rows[0]!);
    expect(row).toEqual({ requires_session: false, requires: {}, network_policy: { allow: ['direct'] } });
    expect(await count('SELECT count(*) FROM webhook_subscriptions WHERE api_id = $1', [imported.body['api_id']])).toBe(0);
    expect(await count('SELECT count(*) FROM runs WHERE api_id = $1 AND kind = $2', [imported.body['api_id'], 'run'])).toBe(0);
    expect(await count('SELECT count(*) FROM datasets WHERE api_id = $1', [imported.body['api_id']])).toBe(0);
  });

  test('INV12 : l’export d’une API d’autrui (même visible) répond 404 ; l’OpenAPI d’une API invisible aussi', async () => {
    const seeded = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    expect((await api(b, 'GET', `/api/apis/${seeded.slug}/export`, '/api/apis/{slug}/export')).status).toBe(404);
    const priv = await seedApi(srv.db.url, a.user.id);
    expect((await api(b, 'GET', `/api/apis/${priv.slug}/openapi.json`, '/api/apis/{slug}/openapi.json')).status).toBe(404);
    expect((await api(null, 'GET', `/api/apis/${priv.slug}/export`, '/api/apis/{slug}/export')).status).toBe(401);
  });
});

describe('import : repasse par l’enquête (16 § 6)', () => {
  test('aperçu d’abord (aucune écriture), puis confirmation : enquete, access_check, run d’enquête en file, aucun nouvel état', async () => {
    const sealed = sealExport(draft());
    const apisBefore = await count('SELECT count(*) FROM apis');
    const preview = await api(a, 'POST', '/api/apis/import', '/api/apis/import', sealed);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      preview: true,
      description: 'Les livres zz test importés',
      source_url: 'https://shop.zz-test.example/books',
      output_fields: ['title', 'price', 'note'],
      strategy: { execution: 'fetch', network: 'direct' },
      schedules: 1,
      alert_targets: [],
      ignored_fields: [],
      requires_ack: false,
    });
    expect(await count('SELECT count(*) FROM apis')).toBe(apisBefore);

    const created = await api(a, 'POST', '/api/apis/import?confirm=true', '/api/apis/import', sealed);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ investigation_phase: 'access_check', proposed_output_schema: null, sample: [] });
    expect(created.body['slug']).toMatch(/^[a-z0-9-]+-[a-f0-9]{6}$/);
    const row = await withClient(srv.db.url, async (c) =>
      (
        await c.query<{ status: string; investigation_phase: string; current_strategy_version: number | null; owner_id: string; investigation: Record<string, unknown>; visibility: string; max_cost_usd: string }>(
          'SELECT status, investigation_phase, current_strategy_version, owner_id, investigation, visibility, max_cost_usd FROM apis WHERE id = $1',
          [created.body['api_id']],
        )
      ).rows[0]!,
    );
    // Aucune stratégie courante avant les essais : l'API importée n'est pas exécutable tant que l'enquête n'a pas conclu.
    expect(row).toMatchObject({ status: 'enquete', investigation_phase: 'access_check', current_strategy_version: null, owner_id: a.user.id, visibility: 'private' });
    expect(Number(row.max_cost_usd)).toBe(0.4);
    expect(row.investigation).toMatchObject({
      request: { url: 'https://shop.zz-test.example/books', description: 'Les livres zz test importés', auto_validate: false },
      validated_schema: OUTPUT,
      validated_columns: ['title', 'price', 'note'],
      validated_by: 'import',
      imported: { execution: 'fetch', network: 'direct', spec: SPEC, input_schema: INPUT },
    });
    expect(await count('SELECT count(*) FROM strategy_versions WHERE api_id = $1', [created.body['api_id']])).toBe(0);
    const runs = await withClient(srv.db.url, async (c) => (await c.query<{ kind: string; state: string; job_id: string | null }>('SELECT kind, state, job_id FROM runs WHERE api_id = $1', [created.body['api_id']])).rows);
    expect(runs).toEqual([expect.objectContaining({ kind: 'investigation', state: 'queued' })]);
    expect(runs[0]!.job_id).not.toBeNull();
    expect(created.body['run_id']).toBeTypeOf('string');
    // Planification recréée DÉSACTIVÉE : le propriétaire la relance une fois l'enquête conclue.
    const schedules = await withClient(srv.db.url, async (c) => (await c.query<{ enabled: boolean; cron: string }>('SELECT enabled, cron FROM schedules WHERE api_id = $1', [created.body['api_id']])).rows);
    expect(schedules).toEqual([{ enabled: false, cron: '0 3 * * *' }]);
    // Pas d'exécution possible avant la fin de l'enquête (409, aucun run créé).
    expect((await api(a, 'POST', `/api/apis/${created.body['slug'] as string}/runs`, '/api/apis/{slug}/runs', { input: {} })).status).toBe(409);
  });

  test('champs inconnus ignorés et listés ; `$ref` distant, empreinte fausse, format inconnu, enveloppe invalide : 400, rien n’est créé', async () => {
    const sealed = sealExport(draft()) as unknown as Record<string, unknown> & { api: Record<string, unknown> };
    const withUnknown = { ...sealed, zz_unknown: 1, api: { ...sealed.api, cookies: `sid=${MARK.cookie}` } };
    const preview = await api(a, 'POST', '/api/apis/import', '/api/apis/import', withUnknown);
    expect(preview.status).toBe(200);
    expect((preview.body['ignored_fields'] as string[]).sort()).toEqual(['$.api.cookies', '$.zz_unknown']);
    expect(preview.raw.body).not.toContain(MARK.cookie);

    const apisBefore = await count('SELECT count(*) FROM apis');
    const remote = sealExport(draft({ output_schema: { ...OUTPUT, properties: { ...OUTPUT.properties, note: { $ref: 'https://evil.zz-test.example/s.json' } } } }));
    expect(await api(a, 'POST', '/api/apis/import?confirm=true', '/api/apis/import', remote)).toMatchObject({ status: 400, body: { error: { code: 'remote_ref' } } });
    const tampered = { ...sealExport(draft()), api: { ...draft().api, description: 'modifiée' } };
    expect(await api(a, 'POST', '/api/apis/import?confirm=true', '/api/apis/import', tampered)).toMatchObject({ status: 400, body: { error: { code: 'integrity_mismatch' } } });
    expect(await api(a, 'POST', '/api/apis/import?confirm=true', '/api/apis/import', sealExport(draft({}, { format_version: '2.0' })))).toMatchObject({ status: 400, body: { error: { code: 'unsupported_format' } } });
    expect(await api(a, 'POST', '/api/apis/import?confirm=true', '/api/apis/import', { format: 'scrapyomama.api' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_export' } } });
    // URL de la demande avec un paramètre secret : refusée comme à la création (aucun secret dans l'état d'enquête).
    const secretUrl = sealExport(draft({ source_url: 'https://shop.zz-test.example/books?token=abc' }));
    expect((await api(a, 'POST', '/api/apis/import?confirm=true', '/api/apis/import', secretUrl)).status).toBe(400);
    expect(await count('SELECT count(*) FROM apis')).toBe(apisBefore);
  });

  test('schéma marqué `x-personal` : la case « j’ai lu » est exigée avant l’import (17 § 11)', async () => {
    const personal = sealExport(draft({ output_schema: { ...OUTPUT, properties: { ...OUTPUT.properties, note: { type: 'string', 'x-personal': true } } } }));
    const preview = await api(b, 'POST', '/api/apis/import', '/api/apis/import', personal);
    expect(preview.body).toMatchObject({ requires_ack: true });
    const refused = await api(b, 'POST', '/api/apis/import?confirm=true', '/api/apis/import', personal);
    expect(refused.status).toBe(403);
    expect(refused.body['error']['code']).toBe('responsible_use_ack_required');
  });
});

describe('OpenAPI par API (16 § 6)', () => {
  test('/api/apis/{slug}/openapi.json : opération de run, schémas d’entrée et de sortie, section webhooks, types openapi-typescript', async () => {
    const seeded = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    const res = await api(b, 'GET', `/api/apis/${seeded.slug}/openapi.json`, '/api/apis/{slug}/openapi.json');
    expect(res.status).toBe(200);
    const doc = res.body as { openapi: string; info: { title: string }; paths: Record<string, Record<string, { operationId: string }>>; components: { schemas: Record<string, unknown> }; webhooks: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths[`/api/apis/${seeded.slug}/runs`]?.['post']?.operationId).toBe('runApi');
    expect(doc.paths['/api/runs/{id}']?.['get']?.operationId).toBe('getRun');
    expect(doc.components.schemas['Item']).toEqual(OUTPUT);
    expect(doc.components.schemas['Input']).toMatchObject({ type: 'object' });
    expect(Object.keys(doc.webhooks).sort()).toEqual(['api.status_changed', 'items.new', 'run.failed', 'run.succeeded']);
    // Références locales toutes résolues ; document structurellement valide (Redocly `struct`).
    const components = doc.components as unknown as Record<string, Record<string, unknown>>;
    const refs = [...res.raw.body.matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)/g)];
    expect(refs.filter((m) => !components[m[1]!]?.[m[2]!]).map((m) => m[0])).toEqual([]);
    const config = await createConfig({ rules: { struct: 'error' } });
    const problems = await lintFromString({ source: res.raw.body, absoluteRef: 'api.json', config });
    expect(problems.filter((p) => p.ruleId === 'struct').map((p) => `${p.location[0]?.pointer ?? ''} ${p.message}`)).toEqual([]);
    // Types générés (openapi-typescript, MIT) : le schéma de sortie de l'API y figure, champ par champ.
    const types = astToString(await openapiTS(res.raw.body));
    expect(types).toContain('Item:');
    expect(types).toMatch(/title: string;/);
    expect(types).toContain('"run.succeeded"');
    // Opération stable : même document au second appel.
    expect((await api(b, 'GET', `/api/apis/${seeded.slug}/openapi.json`, '/api/apis/{slug}/openapi.json')).raw.body).toBe(res.raw.body);
  });

  test('OpenAPI principale : section `webhooks` (run.succeeded, run.failed, api.status_changed, items.new)', async () => {
    const res = await api(a, 'GET', '/api/openapi.json', '/api/openapi.json');
    expect(Object.keys((res.body as { webhooks: Record<string, unknown> }).webhooks).sort()).toEqual(['api.status_changed', 'items.new', 'run.failed', 'run.succeeded']);
  });
});

describe('templates/ : modèles importables sur une instance vierge', () => {
  test('chaque modèle s’importe (aperçu puis confirmation) sur une instance neuve et entre en enquête', async () => {
    const files = readdirSync(TEMPLATES).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    const blank = await startTestServer('portability_blank', { NODE_ENV: 'test' });
    try {
      const owner = await runSetup(blank);
      const cookie = await signIn(blank, owner);
      expect(await withClient(blank.db.url, async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM apis')).rows[0]!.n))).toBe(0);
      for (const file of files) {
        const doc = JSON.parse(readFileSync(new URL(file, TEMPLATES), 'utf8')) as unknown;
        const headers = { cookie, origin: PUBLIC_URL };
        const preview = await blank.app.inject({ method: 'POST', url: '/api/apis/import', headers, payload: doc as Record<string, unknown> });
        expect(preview.statusCode, `${file} ${preview.body.slice(0, 300)}`).toBe(200);
        expect(preview.json<{ ignored_fields: string[] }>().ignored_fields, file).toEqual([]);
        const created = await blank.app.inject({ method: 'POST', url: '/api/apis/import?confirm=true', headers, payload: doc as Record<string, unknown> });
        expect(created.statusCode, `${file} ${created.body.slice(0, 300)}`).toBe(201);
        expect(created.json<{ investigation_phase: string }>().investigation_phase, file).toBe('access_check');
      }
      const rows = await withClient(blank.db.url, async (c) => (await c.query<{ status: string; investigation_phase: string }>('SELECT status, investigation_phase FROM apis')).rows);
      expect(rows).toHaveLength(files.length);
      expect(rows.every((r) => r.status === 'enquete' && r.investigation_phase === 'access_check')).toBe(true);
    } finally {
      await blank.close();
    }
  });
});
