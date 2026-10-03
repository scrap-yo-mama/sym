// SPDX-License-Identifier: AGPL-3.0-only
// Mémoire du catalogue et profils des runs sur base réelle (tâche 2.12, migration 0020) : lectures filtrées par
// `owner_id` (RLS, INV12) même pour une API partagée avec l'instance, `strategy_version_memory_refs` avec le `sha256` du
// dossier, `run_profiles` et baseline validée par l'utilisateur seul, purge avec l'API.
import { randomBytes, randomUUID } from 'node:crypto';
import { buildCatalogDossier, profileItems } from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { readCatalogMemory, readMemoryRefs, recordMemoryRefs, saveStrategySignature } from './memory.js';
import { loadMigrations, migrateDown, migrateUp } from './migrate.js';
import { excludeFromBaseline, judgeQueueDefinition, readBaselineItem, readValidatedBaseline, saveRunJudge, saveRunProfile, scheduleRunJudge, validateBaseline } from './quality.js';
import { PgBossJobQueue } from './queue.js';
import { eraseSubject } from './retention/index.js';
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

describe('mémoire du catalogue (0020)', () => {
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

describe('mémoire du catalogue : session, tunnel et refus (revue 2.12)', () => {
  test('assert_no_cross_domain_values_in_context — API sans session mais en tunnel (version N4), API avec requires.session_domain seul, run passé par le tunnel : aucune valeur', async () => {
    const tunnel = await api(A, 'zz_test_mem_tun', 'https://tun.fr/');
    await pool.query(`UPDATE apis SET network_policy = '{"allow": ["tunnel"]}' WHERE id = $1`, [tunnel]);
    await pool.query("UPDATE strategy_versions SET network = 'tunnel' WHERE api_id = $1", [tunnel]);
    await succeededRun(tunnel, A, [{ sku: 'ZZ-TUNNEL-CANARY' }]);
    const sessionDomain = await api(A, 'zz_test_mem_sd', 'https://tun.fr/');
    await pool.query(`UPDATE apis SET requires = '{"session_domain": "tun.fr"}' WHERE id = $1`, [sessionDomain]);
    await succeededRun(sessionDomain, A, [{ sku: 'ZZ-SESSION-DOMAIN-CANARY' }]);
    const viaTunnel = await api(A, 'zz_test_mem_viatun', 'https://tun.fr/');
    const runT = await succeededRun(viaTunnel, A, [{ sku: 'ZZ-TUNNEL-RUN-CANARY' }]);
    await pool.query("INSERT INTO run_attempts (run_id, seq, owner_id, execution, network, result_class) VALUES ($1, 1, $2, 'fetch', 'tunnel', 'ok')", [runT, A]);
    const plain = await api(A, 'zz_test_mem_plain', 'https://tun.fr/');
    await succeededRun(plain, A, [{ sku: 'ZZ-PLAIN-OK' }]);
    const target = await api(A, 'zz_test_mem_tun_target', 'https://tun.fr/', { status: 'enquete' });
    const mem = await readCatalogMemory(pool, { ownerId: A, apiId: target, domain: 'tun.fr' });
    const of = (id: string) => mem.entries.find((e) => e.api_id === id)!;
    expect(of(tunnel)).toMatchObject({ session: true, sample: [] });
    expect(of(sessionDomain)).toMatchObject({ session: true, sample: [] });
    expect(of(viaTunnel).sample).toEqual([]);
    expect(of(plain).sample).toEqual([{ sku: 'ZZ-PLAIN-OK' }]);
    const dossier = buildCatalogDossier({ ownerId: A, apiId: target, domain: 'tun.fr', description: 'x', now: new Date() }, mem.entries);
    expect(dossier.text).not.toMatch(/ZZ-TUNNEL-CANARY|ZZ-SESSION-DOMAIN-CANARY|ZZ-TUNNEL-RUN-CANARY/);
  });

  test('r1 R14 — un refus reste lu au-delà des 200 API les plus récentes (requête dédiée, sans limite)', async () => {
    await api(A, 'zz_test_mem_refused_old', 'https://old-refused.fr/', { status: 'bloquee', reason: 'forbidden' });
    await pool.query(
      "INSERT INTO apis (slug, owner_id, description, updated_at) SELECT 'zz_test_mem_bulk_' || g, $1, 'x', now() + interval '1 hour' FROM generate_series(1, 210) g",
      [A],
    );
    const mem = await readCatalogMemory(pool, { ownerId: A, apiId: null, domain: 'old-refused.fr' });
    expect(mem.refusals).toEqual([expect.objectContaining({ domain: 'old-refused.fr', class: 'bloquee' })]);
    // Les autres domaines n'y figurent pas.
    expect(mem.refusals.every((r) => r.domain === 'old-refused.fr')).toBe(true);
  });
});

describe('run_profiles et baseline (0020)', () => {
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

  test('B exécute l’API de A partagée avec l’instance : le profil appartient au run (B), A ne le lit pas, B ne valide pas de baseline', async () => {
    const apiId = await api(A, 'zz_test_profile_shared', 'https://shared.fr/', { visibility: 'instance' });
    const runId = (
      await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, strategy_version, finished_at) VALUES ($1, $2, $3, 'rest', 'succeeded', 1, now()) RETURNING id", [apiId, B, A])
    ).rows[0]!.id;
    const profile = profileItems([{ sku: 'x' }], SCHEMA);
    await saveRunProfile(pool, { runId, apiId, ownerId: B, strategyVersion: 1, inputHash: 'h-shared', profile });
    expect((await pool.query<{ owner_id: string }>('SELECT owner_id FROM run_profiles WHERE run_id = $1', [runId])).rows[0]!.owner_id).toBe(B);
    expect((await pool.query<{ quality: unknown }>('SELECT quality FROM runs WHERE id = $1', [runId])).rows[0]!.quality).toEqual(profile);
    // A ne lit pas le profil du run de B (sa mémoire non plus).
    expect((await withActor(pool, { userId: A, role: 'member' }, (tx) => tx.query('SELECT 1 FROM run_profiles WHERE run_id = $1', [runId]))).rowCount).toBe(0);
    // Baseline : acte du propriétaire de l’API, sur ses propres runs seulement.
    await expect(validateBaseline(pool, { runId, ownerId: B, userId: B })).rejects.toThrow();
    expect(await readValidatedBaseline(pool, { apiId, ownerId: B, inputHash: 'h-shared' })).toBeNull();
    // Un profil au nom de A pour le run de B est refusé (owner_id = celui du run).
    const other = (
      await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, strategy_version, finished_at) VALUES ($1, $2, $3, 'rest', 'succeeded', 1, now()) RETURNING id", [apiId, B, A])
    ).rows[0]!.id;
    await expect(saveRunProfile(pool, { runId: other, apiId, ownerId: A, strategyVersion: 1, inputHash: 'h-shared', profile })).rejects.toThrow();
  });

  test('effacement d’une personne : run_profiles.profile (top), runs.quality et runs.judge (raison) nettoyés, aucun résidu', async () => {
    const apiId = await api(A, 'zz_test_profile_erase', 'https://erase.fr/');
    const runId = await succeededRun(apiId, A, []);
    const who = 'Zztest Effacable Profil';
    const profile = profileItems(Array.from({ length: 5 }, () => ({ sku: who })), SCHEMA);
    expect(JSON.stringify(profile)).toContain(who);
    await saveRunProfile(pool, { runId, apiId, ownerId: A, strategyVersion: 1, inputHash: 'h-erase', profile });
    await saveRunJudge(pool, { runId, ownerId: A, judge: { flag: true, verdicts: [{ field: 'sku', verdict: 'wrong', indices: [0], reason: `c’est ${who}` }], trigger: 'anomaly' }, costUsd: 0 });
    const req = { values: [who], key: randomBytes(32), actor: { userId: A, via: 'ui' as const }, scope: { ownerId: A } };
    const dry = await eraseSubject(pool, req, { dryRun: true });
    expect(dry.plan.rows['run_profiles']).toBe(1);
    const report = await eraseSubject(pool, req, { confirm: dry.plan.confirmation });
    expect(report.residual).toEqual({});
    expect(report.scrubbed['run_profiles']).toBe(1);
    const left = JSON.stringify([
      (await pool.query('SELECT profile FROM run_profiles WHERE run_id = $1', [runId])).rows,
      (await pool.query('SELECT quality, judge FROM runs WHERE id = $1', [runId])).rows,
    ]);
    expect(left).not.toContain('Effacable');
  });

  test('juge : item de la baseline validée (premier item de son run), et jugement sur anomalie en job pg-boss unique par run', async () => {
    const apiId = await api(A, 'zz_test_profile_base_item', 'https://baseitem.fr/');
    const runId = await succeededRun(apiId, A, [{ sku: 'ZZ-BASE-1' }, { sku: 'ZZ-BASE-2' }]);
    expect(await readBaselineItem(pool, { apiId, ownerId: A, inputHash: 'h-base' })).toBeNull();
    await saveRunProfile(pool, { runId, apiId, ownerId: A, strategyVersion: 1, inputHash: 'h-base', profile: profileItems([{ sku: 'ZZ-BASE-1' }], SCHEMA) });
    await validateBaseline(pool, { runId, ownerId: A, userId: A });
    expect(await readBaselineItem(pool, { apiId, ownerId: A, inputHash: 'h-base' })).toEqual({ sku: 'ZZ-BASE-1' });
    expect(await readBaselineItem(pool, { apiId, ownerId: B, inputHash: 'h-base' })).toBeNull();
    const queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
    await queue.start();
    try {
      await queue.createQueue(judgeQueueDefinition());
      expect(await scheduleRunJudge(queue, { runId, ownerId: A })).not.toBeNull();
      // Un seul job par run : le doublon est écarté sans erreur.
      expect(await scheduleRunJudge(queue, { runId, ownerId: A })).toBeNull();
      expect(await scheduleRunJudge(queue, { runId: randomUUID(), ownerId: A })).not.toBeNull();
    } finally {
      await queue.stop({ timeoutMs: 1000 });
    }
  });

  test('migration 0020 réversible', async () => {
    // 0020 et les migrations venues après elle (0021 de 2.16…) : la 0020 n'est pas forcément la dernière.
    await migrateDown({ connectionString: tdb.url, steps: loadMigrations().filter((m) => m.version >= 20).length });
    expect((await pool.query("SELECT to_regclass('run_profiles') AS t")).rows[0].t).toBeNull();
    await migrateUp({ connectionString: tdb.url });
    expect((await pool.query("SELECT to_regclass('run_profiles') AS t")).rows[0].t).toBe('run_profiles');
  });
});
