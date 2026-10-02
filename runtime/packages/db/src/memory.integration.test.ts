// SPDX-License-Identifier: AGPL-3.0-only
// Mémoire du catalogue et profils des runs sur base réelle (tâche 2.12, migration 0018) : lectures filtrées par
// `owner_id` (RLS, INV12) même pour une API partagée avec l'instance, `strategy_version_memory_refs` avec le `sha256` du
// dossier, `run_profiles` et baseline validée par l'utilisateur seul, purge avec l'API.
import { randomUUID } from 'node:crypto';
import { buildCatalogDossier, profileItems } from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { readCatalogMemory, readMemoryRefs, recordMemoryRefs, saveStrategySignature } from './memory.js';
import { migrateDown, migrateUp } from './migrate.js';
import { excludeFromBaseline, readValidatedBaseline, saveRunJudge, saveRunProfile, validateBaseline } from './quality.js';
import { withActor } from './rls.js';
import { saveRunDataset } from './strategies.js';

const A = randomUUID();
const B = randomUUID();
const SCHEMA = { type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, vendeur: { type: 'string', 'x-personal': true } } };

let tdb: TestDatabase;
let pool: pg.Pool;

async function api(owner: string, slug: string, url: string, opts: { status?: string; visibility?: string; reason?: string } = {}): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, visibility, status, status_reason, output_schema, description, investigation)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'liste des produits', $7::jsonb) RETURNING id`,
      [slug, owner, opts.visibility ?? 'private', opts.status ?? 'sain', opts.reason ?? null, JSON.stringify(SCHEMA), JSON.stringify({ request: { url, description: 'x', auto_validate: true, budget_usd: 1, timeout_s: 60 }, spent_usd: 0, elapsed_ms: 0 })],
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', $3::jsonb, 'investigation')`,
    [id, owner, JSON.stringify({ schema_version: 1, kind: 'declarative', request: { method: 'GET', url: `${url}api/items?page=1`, allowed_hosts: [new URL(url).hostname] } })],
  );
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

async function succeededRun(apiId: string, owner: string, items: unknown[]): Promise<string> {
  const runId = (await pool.query<{ id: string }>(`INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, strategy_version, finished_at, items) VALUES ($1, $2, $2, 'rest', 'succeeded', 1, now(), $3) RETURNING id`, [apiId, owner, items.length])).rows[0]!.id;
  const { datasetId } = await saveRunDataset(pool, { runId, apiId, ownerId: owner, projectId: '00000000-0000-0000-0000-000000000001', items: items as Record<string, unknown>[] });
  await pool.query('UPDATE runs SET dataset_id = $2 WHERE id = $1', [runId, datasetId]);
  return runId;
}

beforeAll(async () => {
  tdb = await createTestDatabase('memory');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_mem_a@example.test', 'active'), ($2, 'zz_test_mem_b@example.test', 'active')", [A, B]);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await tdb?.drop();
});

describe('mémoire du catalogue (0018)', () => {
  test('assert_catalog_memory_owner_scoped — A et B sur le même domaine (B partagée avec l’instance) : aucun élément de B dans la mémoire de A', async () => {
    const a1 = await api(A, 'zz_test_mem_a1', 'https://shop.a.fr/');
    await succeededRun(a1, A, [{ sku: 'ZZ-A-1', vendeur: 'zz vendeur a' }]);
    const b1 = await api(B, 'zz_test_mem_b1', 'https://www.a.fr/', { visibility: 'instance' });
    await succeededRun(b1, B, [{ sku: 'ZZ-B-CANARY', vendeur: 'zz vendeur b' }]);
    const target = await api(A, 'zz_test_mem_target', 'https://a.fr/', { status: 'enquete' });
    // B voit l'API de A ? non (privée) ; A voit celle de B par la RLS (instance_read), mais la mémoire la filtre par owner_id.
    const visible = await withActor(pool, { userId: A, role: 'member' }, (tx) => tx.query('SELECT id FROM apis WHERE id = $1', [b1]));
    expect(visible.rowCount).toBe(1);
    const mem = await readCatalogMemory(pool, { ownerId: A, apiId: target, domain: 'a.fr' });
    expect(mem.entries.map((e) => e.api_id).sort()).toEqual([a1, target].sort());
    expect(JSON.stringify(mem.entries)).not.toMatch(/ZZ-B-CANARY|zz_test_mem_b1/);
    expect(mem.entries.find((e) => e.api_id === a1)!.sample).toEqual([{ sku: 'ZZ-A-1', vendeur: 'zz vendeur a' }]);
    expect(mem.entries.find((e) => e.api_id === a1)!.domain).toBe('a.fr');
    const memB = await readCatalogMemory(pool, { ownerId: B, apiId: b1, domain: 'a.fr' });
    expect(memB.entries.map((e) => e.api_id)).toEqual([b1]);
  });

  test('assert_memory_refs_recorded — strategy_version_memory_refs : entrées consultées, étage et sha256 du dossier ; purgées avec l’API', async () => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await api(A, `zz_test_mem_refs_${i}`, 'https://refs.example.fr/'));
    const target = await api(A, 'zz_test_mem_refs_target', 'https://refs.example.fr/', { status: 'enquete' });
    const mem = await readCatalogMemory(pool, { ownerId: A, apiId: target, domain: 'example.fr' });
    const dossier = buildCatalogDossier({ ownerId: A, apiId: target, domain: 'example.fr', description: 'x', now: new Date() }, mem.entries);
    expect(dossier.similar.length).toBe(3);
    await recordMemoryRefs(pool, { ownerId: A, apiId: target, version: 1, refs: dossier.refs, sha256: dossier.sha256 });
    const refs = await readMemoryRefs(pool, { ownerId: A, apiId: target, version: 1 });
    expect(refs).toHaveLength(dossier.refs.length);
    expect(refs.every((r) => r.dossier_sha256 === dossier.sha256)).toBe(true);
    expect(refs.map((r) => r.tier).sort()).toEqual(dossier.refs.map((r) => r.tier).sort());
    // B ne lit rien (RLS).
    expect(await readMemoryRefs(pool, { ownerId: B, apiId: target, version: 1 })).toEqual([]);
    await saveStrategySignature(pool, { ownerId: A, apiId: target, version: 1, signature: { registrable_domain: 'example.fr' } as never });
    expect((await pool.query('SELECT signature FROM strategy_versions WHERE api_id = $1 AND version = 1', [target])).rows[0].signature).toMatchObject({ registrable_domain: 'example.fr' });
    await pool.query('DELETE FROM apis WHERE id = $1', [target]);
    expect((await pool.query('SELECT 1 FROM strategy_version_memory_refs WHERE api_id = $1', [target])).rowCount).toBe(0);
  });

  test('refusals : une API du même domaine en bloquee ou refusée par robots.txt est lue comme refus (fait et date)', async () => {
    await api(A, 'zz_test_mem_refused', 'https://refused.fr/', { status: 'bloquee', reason: 'forbidden' });
    const mem = await readCatalogMemory(pool, { ownerId: A, apiId: null, domain: 'refused.fr' });
    expect(mem.entries.find((e) => e.slug === 'zz_test_mem_refused')!.refusal).toMatchObject({ class: 'bloquee' });
    expect(mem.refusals.map((r) => r.domain)).toContain('refused.fr');
  });
});

describe('run_profiles et baseline (0018)', () => {
  test('profil sous RLS ; baseline validée par l’utilisateur seul ; un retour « champ faux » sort le run de la baseline', async () => {
    const apiId = await api(A, 'zz_test_profile', 'https://profile.fr/');
    const runId = await succeededRun(apiId, A, [{ sku: 'x' }]);
    const profile = profileItems([{ sku: 'x' }], SCHEMA);
    await saveRunProfile(pool, { runId, apiId, ownerId: A, strategyVersion: 1, inputHash: 'h1', profile });
    expect(await readValidatedBaseline(pool, { apiId, ownerId: A, inputHash: 'h1' })).toBeNull();
    await validateBaseline(pool, { runId, ownerId: A, userId: A });
    expect(await readValidatedBaseline(pool, { apiId, ownerId: A, inputHash: 'h1' })).toEqual(profile);
    // B ne peut ni lire ni valider.
    await expect(validateBaseline(pool, { runId, ownerId: B, userId: B })).rejects.toThrow();
    expect(await readValidatedBaseline(pool, { apiId, ownerId: B, inputHash: 'h1' })).toBeNull();
    await excludeFromBaseline(pool, { runId, ownerId: A });
    expect(await readValidatedBaseline(pool, { apiId, ownerId: A, inputHash: 'h1' })).toBeNull();
    // Avis du juge : seul runs.judge change.
    await saveRunJudge(pool, { runId, ownerId: A, judge: { flag: true, verdicts: [], trigger: 'anomaly' }, costUsd: 0.004 });
    const row = (await pool.query('SELECT judge, state FROM runs WHERE id = $1', [runId])).rows[0];
    expect(row).toMatchObject({ judge: { flag: true, trigger: 'anomaly' }, state: 'succeeded' });
  });

  test('migration 0018 réversible', async () => {
    await migrateDown({ connectionString: tdb.url, steps: 1 });
    expect((await pool.query("SELECT to_regclass('run_profiles') AS t")).rows[0].t).toBeNull();
    await migrateUp({ connectionString: tdb.url });
    expect((await pool.query("SELECT to_regclass('run_profiles') AS t")).rows[0].t).toBe('run_profiles');
  });
});
