// SPDX-License-Identifier: AGPL-3.0-only
// UX-16 et UX-28 (lot B, U1.10) : un export se réimporte toujours, et le nom de la copie s'applique.
// - l'export d'une API en `erreur` (enquête échouée : ni schéma de sortie validé, ni stratégie) est réimportable ;
// - l'export d'une API saine à stratégie `agent_fetch` porte cette stratégie (sans les références de règles du propriétaire) ;
// - `?name=` à l'import donne le nom (slug) de la copie, sans suffixe tant qu'il est libre ;
// - une API importée avec une stratégie ne relance aucune enquête de l'IA : l'enquête n'essaie que la stratégie du fichier.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { seedApi } from '../../../tests/helpers/rest-seed.js';
import { PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';

let srv: TestServer;
let owner: TestUser;
let cookie: string;

const INPUT = { type: 'object', additionalProperties: false, properties: { max_pages: { type: 'integer', minimum: 1, maximum: 50, description: 'Nombre maximal de pages lues par run (une page par requête).' } } };
const OUTPUT = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, price: { type: 'number' } } };

const AGENT_FETCH_SPEC = {
  schema_version: 1,
  kind: 'agent_fetch',
  request: { url: 'https://shop.zz-test.example/books', allowed_hosts: ['shop.zz-test.example'] },
  via: 'fetch',
  instruction: 'Return every book of the page with its title and price.',
  limits: { max_response_bytes: 5_000_000, max_input_chars: 60_000, timeout_ms: 120_000 },
  rules: { rules: [{ ref: 'zz-rule@1#' + 'a'.repeat(64), level: 'api' }], skills: [] },
};

const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => (await c.query<T>(text, params)).rows);
const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  srv.app.inject({ method, url, headers: { cookie, ...(method === 'GET' ? {} : { origin: PUBLIC_URL }) }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

/** API en `erreur` comme la laisse une enquête échouée : demande connue, aucun schéma validé, aucune stratégie. */
async function seedFailedApi(): Promise<{ id: string; slug: string }> {
  const seeded = await seedApi(srv.db.url, owner.id, { status: 'erreur', strategy: false });
  await sql("UPDATE apis SET output_schema = '{}'::jsonb, output_columns = NULL, input_schema = '{}'::jsonb, current_strategy_version = NULL, investigation_phase = 'done', investigation = $2::jsonb WHERE id = $1", [
    seeded.id,
    JSON.stringify({ request: { url: 'https://shop.zz-test.example/books', description: 'Les livres zz test', auto_validate: true, budget_usd: 1, timeout_s: 600 }, spent_usd: 0.2, elapsed_ms: 1000 }),
  ]);
  return seeded;
}

/** API saine dont la stratégie courante est E4 (`agent_fetch`), avec ses références de règles. */
async function seedAgentFetchApi(): Promise<{ id: string; slug: string }> {
  const seeded = await seedApi(srv.db.url, owner.id);
  await sql("UPDATE apis SET investigation_phase = 'done', investigation = $2::jsonb, input_schema = $3::jsonb, output_schema = $4::jsonb, output_columns = '{title,price}' WHERE id = $1", [
    seeded.id,
    JSON.stringify({ request: { url: 'https://shop.zz-test.example/books', description: 'Les livres zz test', auto_validate: true, budget_usd: 1, timeout_s: 600 }, spent_usd: 0, elapsed_ms: 0 }),
    JSON.stringify(INPUT),
    JSON.stringify(OUTPUT),
  ]);
  await sql("UPDATE strategy_versions SET execution = 'agent_fetch', network = 'direct', spec = $2::jsonb, est_cost_usd = 0.004 WHERE api_id = $1 AND version = 1", [seeded.id, JSON.stringify(AGENT_FETCH_SPEC)]);
  return seeded;
}

beforeAll(async () => {
  srv = await startTestServer('portux', { MAX_CONCURRENT_RUNS: '1000', MAX_ACTIVE_RUNS_PER_USER: '1000', MAX_RUNS_PER_KEY_PER_MINUTE: '1000' });
  owner = await runSetup(srv);
  cookie = await signIn(srv, owner);
}, 180_000);

afterAll(async () => {
  await srv?.close();
});

describe('assert_export_reimportable (UX-16) : l’export d’une API en erreur est réimportable', () => {
  test('export 200, aperçu 200, import 201 : une enquête complète repart de la demande d’origine, sans schéma ni stratégie importés', async () => {
    const failed = await seedFailedApi();
    const exported = await call('GET', `/api/apis/${failed.slug}/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    const doc = exported.json() as { strategy: unknown; api: { source_url: string } };
    expect(doc.strategy).toBeNull();
    expect(doc.api.source_url).toBe('https://shop.zz-test.example/books');
    const preview = await call('POST', '/api/apis/import', doc);
    expect(preview.statusCode, preview.body).toBe(200);
    const before = Number((await sql<{ n: string }>('SELECT count(*) AS n FROM apis'))[0]!.n);
    const imported = await call('POST', '/api/apis/import?confirm=true', doc);
    expect(imported.statusCode, imported.body).toBe(201);
    expect(Number((await sql<{ n: string }>('SELECT count(*) AS n FROM apis'))[0]!.n)).toBe(before + 1);
    const { api_id: apiId } = imported.json<{ api_id: string }>();
    const [row] = await sql<{ status: string; investigation: { imported?: unknown; validated_schema?: unknown } }>('SELECT status, investigation FROM apis WHERE id = $1', [apiId]);
    expect(row!.status).toBe('enquete');
    // Rien d'un échec n'est importé : pas de schéma validé, pas de stratégie ; l'enquête part de la demande.
    expect(row!.investigation.imported).toBeUndefined();
    expect(row!.investigation.validated_schema).toBeUndefined();
  });
});

describe('UX-28 : la stratégie agent_fetch s’exporte et se réimporte', () => {
  test('l’export porte la stratégie E4 sans les références de règles du propriétaire (lisibles de lui seul)', async () => {
    const api = await seedAgentFetchApi();
    const exported = await call('GET', `/api/apis/${api.slug}/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    const doc = exported.json() as { strategy: { execution: string; network: string; spec: Record<string, unknown>; est_cost_usd: number | null } | null };
    expect(doc.strategy).toMatchObject({ execution: 'agent_fetch', network: 'direct', est_cost_usd: 0.004 });
    expect(doc.strategy!.spec['kind']).toBe('agent_fetch');
    expect(doc.strategy!.spec).not.toHaveProperty('rules');
    expect(JSON.stringify(doc)).not.toContain('zz-rule@1');
  });

  test('réimport avec ?name= : nom appliqué, stratégie importée, aucune enquête de l’IA (l’enquête n’essaie que la stratégie du fichier)', async () => {
    const api = await seedAgentFetchApi();
    const doc = (await call('GET', `/api/apis/${api.slug}/export`)).json();
    const imported = await call('POST', `/api/apis/import?confirm=true&name=${encodeURIComponent('Copie démo')}`, doc);
    expect(imported.statusCode, imported.body).toBe(201);
    const { api_id: apiId, slug } = imported.json<{ api_id: string; slug: string }>();
    expect(slug).toBe('copie-demo');
    const [row] = await sql<{ slug: string; investigation: { imported?: { execution: string }; validated_schema?: unknown; request: { url: string } } }>('SELECT slug, investigation FROM apis WHERE id = $1', [apiId]);
    expect(row!.slug).toBe('copie-demo');
    expect(row!.investigation.imported).toMatchObject({ execution: 'agent_fetch' });
    expect(row!.investigation.validated_schema).toBeDefined();
    // Un second import du même nom : suffixé seulement parce que le premier existe.
    const again = await call('POST', `/api/apis/import?confirm=true&name=${encodeURIComponent('Copie démo')}`, doc);
    expect(again.statusCode).toBe(201);
    expect(again.json<{ slug: string }>().slug).toMatch(/^copie-demo-[0-9a-f]{6}$/);
  });

  test('un nom illisible ou trop long est refusé avant toute écriture', async () => {
    const api = await seedAgentFetchApi();
    const doc = (await call('GET', `/api/apis/${api.slug}/export`)).json();
    const before = Number((await sql<{ n: string }>('SELECT count(*) AS n FROM apis'))[0]!.n);
    for (const name of ['x'.repeat(81), '   ', '***']) {
      const res = await call('POST', `/api/apis/import?confirm=true&name=${encodeURIComponent(name)}`, doc);
      expect(res.statusCode, name).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_request', action_label: expect.stringMatching(/\S/) } });
    }
    expect(Number((await sql<{ n: string }>('SELECT count(*) AS n FROM apis'))[0]!.n)).toBe(before);
  });
});
