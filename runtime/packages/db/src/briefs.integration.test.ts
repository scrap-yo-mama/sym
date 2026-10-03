// SPDX-License-Identifier: AGPL-3.0-only
// Dossier d'enquête sur base réelle (tâche 2.14, 19c § 4 et § 9.2, migration 0022) : versions par remplacement (même contenu,
// pas de nouvelle version ; BRIEF_VERSIONS_KEEP), lectures filtrées par owner_id (aucun dossier d'une autre API ni d'un
// autre propriétaire), clone et transfert sans dossier, effacement d'une personne (l'effacement l'emporte sur
// l'immuabilité), rétention des échantillons, faits du code et événement de preuve unique par jour, migration réversible.
import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeBrief, type FinalHint, type InvestigationBrief } from '@runtime/core';
import { isUsableSubjectValue, subjectHash } from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { cloneApi, transferApisWithoutSession } from './accounts.js';
import { briefHintsView, claimHintVerifiedEvent, pruneBriefVersions, readBriefForApi, readHintOutcomes, readLatestBrief, saveHintOutcomes, storeBrief } from './briefs.js';
import { loadMigrations, migrateDown, migrateUp } from './migrate.js';
import { cleanupExpiredRunData, DEFAULT_RETENTION_POLICY, eraseSubject, exportSubject, loadSubjectExclusions } from './retention/index.js';
import { withActor } from './rls.js';
import { buildStrategySource, readSourceBase, readStrategySource, recordStrategySource } from './rules.js';

const A = randomUUID();
const B = randomUUID();
const NOW = new Date('2026-10-03T10:00:00Z');

let tdb: TestDatabase;
let pool: pg.Pool;

async function api(owner: string, slug: string): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, status, description, investigation) VALUES ($1, $2, 'sain', 'zz', $3::jsonb) RETURNING id`,
      [slug, owner, JSON.stringify({ request: { url: 'https://shop.example/catalogue/', description: 'zz', auto_validate: false, budget_usd: 1, timeout_s: 60 }, spent_usd: 0, elapsed_ms: 0 })],
    )
  ).rows[0]!.id;
  await pool.query(`INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', '{}'::jsonb, 'investigation')`, [id, owner]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

async function store(apiId: string, owner: string, brief: InvestigationBrief, keep = 5, isExcluded?: (v: string) => boolean) {
  const normalized = normalizeBrief(brief, { receivedAt: NOW, ...(isExcluded === undefined ? {} : { isExcluded }) });
  return withActor(pool, { userId: owner, role: 'member' }, (tx) => storeBrief(tx, { apiId, ownerId: owner, authorId: owner, via: 'mcp', normalized, keep }));
}

const brief = (n: number): InvestigationBrief => ({ v: 1, notes: `zz note ${n}`, hints: [{ id: 'h1', kind: 'endpoint', value: `GET https://shop.example/api/products?v=${n}`, confidence: 'high' }] });

beforeAll(async () => {
  tdb = await createTestDatabase('briefs');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_brief_a@example.test', 'active'), ($2, 'zz_test_brief_b@example.test', 'active')", [A, B]);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await tdb?.drop();
});

describe('api_briefs et brief_hint_outcomes (0022)', () => {
  test('assert_brief_versioning — même contenu : aucune version de plus ; nouveau dossier : nouvelle version ; au plus BRIEF_VERSIONS_KEEP, la version référencée par une stratégie est gardée', async () => {
    const apiId = await api(A, 'zz_test_brief_versions');
    expect(await store(apiId, A, brief(1))).toMatchObject({ version: 1, created: true });
    expect(await store(apiId, A, brief(1))).toMatchObject({ version: 1, created: false });
    expect(await store(apiId, A, brief(2))).toMatchObject({ version: 2, created: true });
    // La version 1 est la source de la version de stratégie 1 : jamais purgée par le plafond.
    await pool.query(`UPDATE strategy_versions SET source = $2::jsonb WHERE api_id = $1 AND version = 1`, [apiId, JSON.stringify({ brief: { ref: { version: 1, sha256: 'a'.repeat(64) }, used: [], ignored: [] } })]);
    for (let n = 3; n <= 8; n += 1) await store(apiId, A, brief(n), 3);
    const versions = (await pool.query<{ brief_version: number }>('SELECT brief_version FROM api_briefs WHERE api_id = $1 ORDER BY brief_version', [apiId])).rows.map((r) => r.brief_version);
    expect(versions).toEqual([1, 6, 7, 8]);
    expect((await readLatestBrief(pool, { apiId, ownerId: A }))!.version).toBe(8);
    // Purge système (rétention) : même règle.
    expect(await pruneBriefVersions(pool, { keep: 2 })).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM api_briefs WHERE api_id = $1', [apiId])).rows[0].n).toBe(3);
  });

  test('immuable : contenu et empreinte ne se réécrivent qu’avec un effacement ou la purge des échantillons ; propriétaire de l’API seulement', async () => {
    const apiId = await api(A, 'zz_test_brief_immutable');
    await store(apiId, A, brief(1));
    await expect(pool.query(`UPDATE api_briefs SET content = '{"v":1,"notes":"zz changed"}'::jsonb WHERE api_id = $1`, [apiId])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE api_briefs SET brief_version = 9 WHERE api_id = $1`, [apiId])).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(`INSERT INTO api_briefs (api_id, owner_id, brief_version, content, content_sha256, size_bytes, via) VALUES ($1, $2, 5, '{}', $3, 2, 'mcp')`, [apiId, B, 'c'.repeat(64)]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('assert_brief_not_cross_api — le dossier d’une API n’est lu ni pour une autre API du même propriétaire, ni par un autre utilisateur (filtre owner_id, RLS)', async () => {
    const a1 = await api(A, 'zz_test_brief_cross_1');
    const a2 = await api(A, 'zz_test_brief_cross_2');
    await store(a1, A, { v: 1, notes: 'zz_cross_api_canary' });
    expect(await readLatestBrief(pool, { apiId: a2, ownerId: A })).toBeNull();
    expect(await readBriefForApi(pool, { apiId: a2, ownerId: A })).toBeNull();
    // B, même avec l'identifiant de l'API de A, ne lit rien (filtre explicite, même par l'identité système).
    expect(await readLatestBrief(pool, { apiId: a1, ownerId: B })).toBeNull();
    expect(await readBriefForApi(pool, { apiId: a1, ownerId: B })).toBeNull();
    const seen = await withActor(pool, { userId: B, role: 'member' }, (tx) => tx.query('SELECT content FROM api_briefs WHERE api_id = $1', [a1]));
    expect(seen.rowCount).toBe(0);
  });

  test('assert_clone_no_brief — clone et transfert : ni api_briefs ni brief_hint_outcomes chez B, source.brief.ref à null (brief_not_transferred)', async () => {
    const apiId = await api(A, 'zz_test_brief_clone');
    const { version, sha256 } = await store(apiId, A, brief(1));
    await pool.query(`UPDATE strategy_versions SET source = $2::jsonb WHERE api_id = $1 AND version = 1`, [apiId, JSON.stringify({ reason: 'investigation', brief: { ref: { version, sha256 }, used: ['k'.repeat(64)], ignored: [] } })]);
    await saveHintOutcomes(pool, { apiId, ownerId: A, version, hints: [{ id: 'h1', kind: 'endpoint', identity_key: 'e'.repeat(64), state: 'used', reason: 'brief_used', provenance: 'probe', stale: false, probe: null, url: null }], now: NOW });
    const clone = await pool.connect();
    let cloned: { id: string };
    try {
      await clone.query('BEGIN');
      cloned = await cloneApi(clone, { apiId, fromOwnerId: A, toOwnerId: B });
      await clone.query('COMMIT');
    } finally {
      clone.release();
    }
    expect((await pool.query('SELECT 1 FROM api_briefs WHERE api_id = $1', [cloned.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM brief_hint_outcomes WHERE api_id = $1', [cloned.id])).rowCount).toBe(0);
    const src = (await pool.query<{ source: { brief: unknown } }>('SELECT source FROM strategy_versions WHERE api_id = $1 AND version = 1', [cloned.id])).rows[0]!.source;
    expect(src.brief).toEqual({ ref: null, used: [], ignored: [], not_transferred: 'brief_not_transferred' });
    // Une réparation chez B ne lit aucun dossier de A, même par le rôle de service.
    expect(await readBriefForApi(pool, { apiId: cloned.id, ownerId: B, preferVersion: version })).toBeNull();
    // Transfert : le dossier ne suit pas l'API.
    await transferApisWithoutSession(pool, A, B);
    expect((await pool.query('SELECT 1 FROM api_briefs WHERE api_id = $1', [apiId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM brief_hint_outcomes WHERE api_id = $1', [apiId])).rowCount).toBe(0);
    const moved = (await pool.query<{ source: { brief: { ref: unknown } } }>('SELECT source FROM strategy_versions WHERE api_id = $1 AND version = 1', [apiId])).rows[0]!.source;
    expect(moved.brief.ref).toBeNull();
    // Retour à A pour la suite des tests.
    await pool.query('UPDATE apis SET owner_id = $1 WHERE owner_id = $2', [A, B]);
    await pool.query('UPDATE strategy_versions SET owner_id = $1 WHERE owner_id = $2', [A, B]);
  });

  test('faits du code : écrits par clé d’identité, relus pour la mémoire négative ; un seul événement brief_hint_verified par clé et par jour', async () => {
    const apiId = await api(A, 'zz_test_brief_outcomes');
    const { version } = await store(apiId, A, brief(1));
    const hint = (state: FinalHint['state'], key: string): FinalHint => ({ id: 'h1', kind: 'endpoint', identity_key: key, state, reason: state === 'probe_failed' ? 'brief_probe_failed' : 'brief_used', provenance: state === 'used' ? 'probe' : null, stale: false, probe: { at: NOW.toISOString(), http_class: state === 'used' ? '2xx' : '4xx', items_conform: state === 'used' ? 20 : null, duration_ms: 3, cost_usd: 0.001 }, url: null });
    await saveHintOutcomes(pool, { apiId, ownerId: A, version, hints: [hint('used', '1'.repeat(64)), hint('probe_failed', '2'.repeat(64)), { ...hint('unverified', '3'.repeat(64)), probe: null }], now: NOW });
    const facts = await readHintOutcomes(pool, { apiId, ownerId: A });
    expect([...facts.keys()].sort()).toEqual(['1'.repeat(64), '2'.repeat(64)]);
    expect(facts.get('2'.repeat(64))).toMatchObject({ state: 'probe_failed', probed_at: NOW.toISOString(), last_ok_at: null });
    expect(facts.get('1'.repeat(64))!.last_ok_at).toBe(NOW.toISOString());
    // Jamais de corps de réponse dans la sonde.
    await expect(pool.query(`UPDATE brief_hint_outcomes SET probe = '{"body":"x"}'::jsonb WHERE api_id = $1`, [apiId])).rejects.toMatchObject({ code: '23514' });
    let emitted = 0;
    for (let i = 0; i < 13; i += 1) if (await claimHintVerifiedEvent(pool, { apiId, ownerId: A, identityKey: '1'.repeat(64), day: '2026-10-03' })) emitted += 1;
    expect(emitted).toBe(1);
    expect(await claimHintVerifiedEvent(pool, { apiId, ownerId: A, identityKey: '1'.repeat(64), day: '2026-10-04' })).toBe(true);
    expect(await claimHintVerifiedEvent(pool, { apiId, ownerId: B, identityKey: '1'.repeat(64), day: '2026-10-05' })).toBe(false);
    const view = await briefHintsView(pool, { apiId, ownerId: A });
    expect(view.latest).toMatchObject({ version, hints: 1, tried: 0, open_questions: 0 });
    expect(view.hints.map((h) => [h.hint_id, h.state, h.cost_usd]).sort((x, y) => String(x[1]).localeCompare(String(y[1])))).toEqual([['h1', 'probe_failed', 0.001], ['h1', 'used', 0.001]]);
    expect(JSON.stringify(view)).not.toContain('zz note');
  });

  test('assert_erasure_complete (dossier d’enquête) — personne citée dans notes, sample et une URL : 0 occurrence en SQL brut, version marquée erased, export qui liste les deux tables, nouveau dossier stocké sans elle', async () => {
    const apiId = await api(A, 'zz_test_brief_erase');
    const name = 'Zztest Effacable Dossier';
    await store(apiId, A, { v: 1, notes: `Ask ${name}`, hints: [{ id: 'h1', kind: 'pitfall', value: `contact ${name}`, sample: `${name} wrote this` }, { id: 'h2', kind: 'example_url', value: `https://shop.example/u/${encodeURIComponent(name)}?ref=x` }] });
    const key = randomBytes(32);
    const req = { values: [name], key, actor: { userId: A, via: 'ui' as const }, scope: { ownerId: A } };
    const exported = await exportSubject(pool, req, NOW);
    expect(exported.api_briefs.map((b) => b.api_id)).toEqual([apiId]);
    expect(Array.isArray(exported.brief_hint_outcomes)).toBe(true);
    const dry = await eraseSubject(pool, req, { dryRun: true });
    expect(dry.plan.rows['api_briefs']).toBe(1);
    const report = await eraseSubject(pool, req, { confirm: dry.plan.confirmation });
    expect(report.residual).toEqual({});
    const raw = JSON.stringify((await pool.query('SELECT * FROM api_briefs WHERE api_id = $1', [apiId])).rows) + JSON.stringify((await pool.query('SELECT * FROM brief_hint_outcomes WHERE api_id = $1', [apiId])).rows);
    expect(raw).not.toContain('Effacable');
    const row = (await pool.query<{ erased_at: Date | null; content_sha256: string }>('SELECT erased_at, content_sha256 FROM api_briefs WHERE api_id = $1', [apiId])).rows[0]!;
    expect(row.erased_at).not.toBeNull();
    // Un nouveau dossier qui la cite est stocké sans elle (liste d'exclusion hachée consultée avant de stocker).
    const hashes = await loadSubjectExclusions(pool);
    const isExcluded = (v: string) => isUsableSubjectValue(v) && hashes.has(subjectHash(key, v));
    const again = await store(apiId, A, { v: 1, notes: `again ${name}`, hints: [{ id: 'h1', kind: 'pitfall', value: `${name}` }] }, 5, isExcluded);
    expect(again.created).toBe(true);
    const latest = await readLatestBrief(pool, { apiId, ownerId: A });
    expect(JSON.stringify(latest!.content)).not.toContain('Effacable');
    expect(latest!.subject_excluded).toEqual(['h1']);
  });

  test('assert_retention_purge (dossier d’enquête) — sample de plus de 14 jours réduit à son empreinte ; plafond de versions', async () => {
    const apiId = await api(A, 'zz_test_brief_retention');
    await store(apiId, A, { v: 1, hints: [{ id: 'h1', kind: 'pitfall', value: 'zz', sample: 'zz_sample_value_to_purge' }] });
    await pool.query("ALTER TABLE api_briefs DISABLE TRIGGER api_briefs_guard");
    await pool.query("UPDATE api_briefs SET created_at = $2 WHERE api_id = $1", [apiId, new Date(NOW.getTime() - 20 * 86_400_000)]);
    await pool.query("ALTER TABLE api_briefs ENABLE TRIGGER api_briefs_guard");
    const out = await cleanupExpiredRunData(pool, NOW, { ...DEFAULT_RETENTION_POLICY, samplesDays: 14 });
    expect(out.brief_samples).toBeGreaterThanOrEqual(1);
    const content = (await pool.query<{ content: InvestigationBrief; samples_purged_at: Date | null }>('SELECT content, samples_purged_at FROM api_briefs WHERE api_id = $1', [apiId])).rows[0]!;
    expect(JSON.stringify(content.content)).not.toContain('zz_sample_value_to_purge');
    expect(content.content.hints![0]!.sample).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(content.samples_purged_at).not.toBeNull();
    expect(typeof out.brief_versions).toBe('number');
  });

  test('assert_brief_survives_repair — vN avec dossier puis réparation : vN+1 garde source.brief.ref et relit CETTE version du dossier, même après un nouvel envoi', async () => {
    const apiId = await api(A, 'zz_test_brief_repair');
    const first = await store(apiId, A, brief(1));
    const sourceV1 = buildStrategySource({ reason: 'investigation', description: 'zz', url: 'https://shop.example/catalogue/', outputSchemaSha256: 'f'.repeat(64), investigationId: null, rows: [], brief: { ref: { version: first.version, sha256: first.sha256 }, used: ['u'.repeat(64)], ignored: [] } });
    await withActor(pool, { userId: A, role: 'member' }, (tx) => recordStrategySource(tx, { apiId, ownerId: A, version: 1, source: sourceV1, rules: [] }));
    // Un nouveau dossier arrive (affinage) : la réparation de v1 relit quand même la version de sa source.
    await store(apiId, A, brief(2));
    const base = await readSourceBase(pool, { apiId, ownerId: A, version: 1 });
    expect(base?.brief?.ref).toEqual({ version: first.version, sha256: first.sha256 });
    await pool.query(`INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by, parent_version) VALUES ($1, 2, $2, 'fetch', 'direct', '{}'::jsonb, 'repair', 1)`, [apiId, A]);
    const sourceV2 = buildStrategySource({ reason: 'repair', description: base!.request.description, url: base!.request.url, outputSchemaSha256: 'f'.repeat(64), investigationId: null, rows: [], ...(base!.brief === undefined ? {} : { brief: base!.brief }) });
    await withActor(pool, { userId: A, role: 'member' }, (tx) => recordStrategySource(tx, { apiId, ownerId: A, version: 2, source: sourceV2, rules: [] }));
    expect((await readStrategySource(pool, { apiId, ownerId: A, version: 2 }))!.source.brief!.ref).toEqual({ version: first.version, sha256: first.sha256 });
    const reread = await readBriefForApi(pool, { apiId, ownerId: A, preferVersion: base!.brief!.ref!.version });
    expect(reread!.brief.version).toBe(first.version);
    expect(JSON.stringify(reread!.brief.content)).toContain('zz note 1');
    expect((await readBriefForApi(pool, { apiId, ownerId: A }))!.brief.version).toBe(2);
  });

  test('migration 0022 réversible', async () => {
    await migrateDown({ connectionString: tdb.url, steps: loadMigrations().filter((m) => m.version >= 22).length });
    expect((await pool.query("SELECT to_regclass('api_briefs') AS t")).rows[0].t).toBeNull();
    expect((await pool.query("SELECT to_regclass('brief_hint_outcomes') AS t")).rows[0].t).toBeNull();
    await migrateUp({ connectionString: tdb.url });
    expect((await pool.query("SELECT to_regclass('api_briefs') AS t")).rows[0].t).toBe('api_briefs');
  });
});
