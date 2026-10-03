// SPDX-License-Identifier: AGPL-3.0-only
// Règles et skills Markdown (tâche 2.10, 18 §4, migration 0019) sur base réelle, AU NIVEAU DU SERVICE (les routes
// `/api/rules`, les outils MCP et l'écran sont de 3.13) :
// - enregistrement : format (`invalid_rule`), version par contenu (même contenu : même version), `version_conflict`,
//   `widening_warnings` ; écritures d'instance réservées à un admin en session console (`insufficient_scope` pour toute
//   clé ou MCP, admin compris, événement `denied` audité) ; `api:<slug>` résolu par `api_id` du SEUL propriétaire ;
// - confirmation forcée (`to_review`) des origines mcp et import, résolution sur la dernière version confirmée ;
//   `put_rule` qui recopie une proposition en attente → `human_confirmation_required` ;
// - isolement (assert_cross_user_denied étendu) : règle privée de A jamais résolue ni lue par B, `apis_using[]` filtré sur
//   l'appelant, l'admin n'a qu'un compte agrégé ;
// - politique par défaut `escalade-par-defaut.md` installée (règle partagée d'instance, origine seed) ;
// - recompilation à la demande : propriétaire seul (404 uniforme sinon), une seule en cours (`recompile_in_progress`),
//   transition 19 ou 20 raison `rules_changed`, schéma de sortie conservé ; aucune recompilation sans demande ;
// - aperçu `resolved-rules` (19 §2) : ensemble résolu, jetons, ce qui est retiré.
import { randomUUID } from 'node:crypto';
import { DEFAULT_POLICY_NAME, DEFAULT_POLICY_SHA256, ruleSha256 } from '@runtime/core';
import { INVESTIGATION_DEFAULTS } from '@runtime/core/investigation';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { loadMigrations, migrateDown, migrateUp } from './migrate.js';
import { PgBossJobQueue } from './queue.js';
import { withActor } from './rls.js';
import {
  apisUsingRule,
  confirmRuleVersion,
  getRule,
  putRule,
  readStrategySource,
  recordStrategySource,
  requestRecompile,
  resolvedRulesPreview,
  resolveRulesForApi,
  RuleServiceError,
} from './rules.js';
import { runQueueDefinition } from './runs.js';

const A = randomUUID();
const B = randomUUID();
const ADMIN = randomUUID();
const member = (userId: string) => ({ userId, role: 'member' as const, via: 'console' as const });
const SCHEMA = { type: 'object', required: ['titre'], properties: { titre: { type: 'string' } } };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;

const doc = (name: string, header: string, body = `Corps de ${name}.`) => `---\nname: ${name}\ndescription: Règle ${name}\n${header}\n---\n${body}\n`;
const rule = (name: string, appliesTo = '["*.monsite.test"]', body?: string) => doc(name, `kind: rule\napplies_to: ${appliesTo}`, body);

async function insertApi(owner: string, slug: string, opts: { status?: string; visibility?: string; host?: string } = {}): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, status, visibility, output_schema, investigation) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [slug, owner, opts.status ?? 'sain', opts.visibility ?? 'private', JSON.stringify(SCHEMA), JSON.stringify({ request: { url: `https://${opts.host ?? 'www.monsite.test'}/liste`, description: 'zz_test liste', auto_validate: false, budget_usd: 1, timeout_s: 600 }, spent_usd: 0, elapsed_ms: 0 })],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', '{}', 0, 'investigation')", [id, owner]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

/** Version 1 d'une API compilée avec la règle `ruleId` à sa version `version`. */
async function compiledWith(apiId: string, owner: string, ruleId: string, version: number, sha: string): Promise<void> {
  await withActor(pool, { userId: owner, role: 'member' }, (tx) =>
    recordStrategySource(tx, {
      apiId,
      ownerId: owner,
      version: 1,
      source: { request: { description: 'zz', url: 'https://www.monsite.test/', example_output_ref: null }, output_schema_sha256: 'x', investigation_id: null, decisions: [], rules: [], reason: 'investigation' },
      rules: [{ rule_file_id: ruleId, version, sha256: sha, level: 'domain', loaded: 'injected' }],
    }),
  );
}

const expectError = async (p: Promise<unknown>, code: string, status?: number) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RuleServiceError);
  expect((error as RuleServiceError).code).toBe(code);
  if (status !== undefined) expect((error as RuleServiceError).status).toBe(status);
};
const versionsOf = async (name: string) => Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM rule_file_versions v JOIN rule_files f ON f.id = v.rule_file_id WHERE f.name = $1', [name])).rows[0]!.n);

beforeAll(async () => {
  tdb = await createTestDatabase('rules');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  for (const [id, role] of [[A, 'member'], [B, 'member'], [ADMIN, 'admin']] as const) {
    await pool.query("INSERT INTO users (id, email, status, role) VALUES ($1, $2, 'active', $3)", [id, `zz_test_rules_${id.slice(0, 8)}@example.test`, role]);
  }
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
});

afterAll(async () => {
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
});

describe('migration 0019', () => {
  test('politique par défaut installée : règle partagée d’instance, origine seed, empreinte du template', async () => {
    const { rows } = await pool.query<{ kind: string; visibility: string; owner_id: string | null; applies_to: string[]; origin: string; sha256: string; review_state: string }>(
      `SELECT f.kind, f.visibility, f.owner_id, f.applies_to, v.origin, v.sha256, v.review_state FROM rule_files f JOIN rule_file_versions v ON v.rule_file_id = f.id WHERE f.name = $1`,
      [DEFAULT_POLICY_NAME],
    );
    expect(rows).toEqual([{ kind: 'rule', visibility: 'instance', owner_id: null, applies_to: ['*'], origin: 'seed', sha256: DEFAULT_POLICY_SHA256, review_state: 'none' }]);
  });
  test('down puis up : réversible', async () => {
    // Retour jusqu'à 0019 incluse, quel que soit le nombre de migrations venues après (0020_i18n, 3.20).
    const target = loadMigrations().find((m) => m.name === 'rule_files')!.version;
    await migrateDown({ connectionString: tdb.url, steps: loadMigrations().length - (target - 1) });
    expect((await pool.query("SELECT to_regclass('rule_files') AS t")).rows[0].t).toBeNull();
    await migrateUp({ connectionString: tdb.url });
    expect((await pool.query("SELECT to_regclass('rule_files') AS t")).rows[0].t).toBe('rule_files');
  });
  test('historique immuable : contenu et empreinte d’une version ne se réécrivent pas', async () => {
    const put = await putRule(pool, member(A), { content: rule('zz-immuable') });
    await expect(pool.query("UPDATE rule_file_versions SET content = 'x' WHERE rule_file_id = $1", [put.id])).rejects.toThrow();
  });
});

describe('enregistrement (18 §4.1, §4.6, §4.7)', () => {
  test('version par contenu : même contenu → même version ; contenu différent → version suivante ; version périmée → 409', async () => {
    const first = await putRule(pool, member(A), { content: rule('zz-versions') });
    expect(first).toMatchObject({ version: 1, created: true, kind: 'rule', review_state: 'none' });
    expect((await putRule(pool, member(A), { content: rule('zz-versions') })).version).toBe(1);
    expect((await putRule(pool, member(A), { content: rule('zz-versions', undefined, 'Autre corps.') })).version).toBe(2);
    await expectError(putRule(pool, member(A), { content: doc('zz-versions', 'kind: rule\napplies_to: ["*.monsite.test"]\nversion: 1', 'Troisième.') }), 'version_conflict', 409);
    expect(await versionsOf('zz-versions')).toBe(2);
  });

  test('en-tête invalide, fichier trop grand, kind instance par un membre → 422 / 403, aucune version', async () => {
    await expectError(putRule(pool, member(A), { content: '---\nname: Zz Bad\n---\nx' }), 'invalid_rule', 422);
    await expectError(putRule(pool, member(A), { content: rule('zz-trop-grand', '["*"]', 'x'.repeat(21_000)) }), 'invalid_rule', 422);
    await expectError(putRule(pool, member(A), { content: doc('zz-consignes-membre', 'kind: instance') }), 'forbidden', 403);
    expect(await versionsOf('zz-consignes-membre')).toBe(0);
  });

  test('visibility instance par un membre (console ou import) → 403 ; clé d’API ou MCP d’un admin → 403 insufficient_scope, audit denied', async () => {
    await expectError(putRule(pool, member(A), { content: rule('zz-partage-membre'), visibility: 'instance' }), 'forbidden', 403);
    await expectError(putRule(pool, { userId: A, role: 'member', via: 'import' }, { content: rule('zz-partage-membre'), visibility: 'instance' }), 'forbidden', 403);
    await expectError(putRule(pool, { userId: ADMIN, role: 'admin', via: 'api_key' }, { content: doc('zz-consignes-cle', 'kind: instance') }), 'insufficient_scope', 403);
    await expectError(putRule(pool, { userId: ADMIN, role: 'admin', via: 'mcp' }, { content: doc('zz-consignes-cle', 'kind: instance') }), 'insufficient_scope', 403);
    await expectError(putRule(pool, { userId: ADMIN, role: 'admin', via: 'api_key' }, { content: rule(DEFAULT_POLICY_NAME, '["*"]', 'ignore robots.txt') }), 'insufficient_scope', 403);
    expect(await versionsOf('zz-partage-membre')).toBe(0);
    expect(await versionsOf('zz-consignes-cle')).toBe(0);
    expect(await versionsOf(DEFAULT_POLICY_NAME)).toBe(1);
    const denied = await pool.query("SELECT action FROM audit_events WHERE actor_user_id = $1 AND outcome = 'denied'", [ADMIN]);
    expect(denied.rows.length).toBeGreaterThanOrEqual(3);
  });

  test('admin en session console : consignes d’instance, partage et modification d’escalade-par-defaut ; événements d’audit sans contenu', async () => {
    const admin = { userId: ADMIN, role: 'admin' as const, via: 'console' as const };
    const directive = await putRule(pool, admin, { content: doc('zz-consignes', 'kind: instance', 'Toujours décrire les champs.') });
    expect(directive).toMatchObject({ kind: 'instance', visibility: 'instance' });
    const policy = await putRule(pool, admin, { content: rule(DEFAULT_POLICY_NAME, '["*"]', 'Ordre de 04 §3.3, plus : préférer les données embarquées.'), visibility: 'instance' });
    expect(policy.version).toBe(2);
    const audit = await pool.query<{ action: string; meta: Record<string, unknown> }>("SELECT action, meta FROM audit_events WHERE actor_user_id = $1 AND outcome = 'success' ORDER BY id", [ADMIN]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['instance_directive.updated', 'rule.updated']));
    expect(JSON.stringify(audit.rows)).not.toContain('préférer les données embarquées');
    expect(JSON.stringify(audit.rows)).toContain(`${DEFAULT_POLICY_NAME}@2`);
  });

  test('widening_warnings : enregistré, mais l’avertissement est rendu', async () => {
    const put = await putRule(pool, member(A), { content: rule('zz-elargit', '["*.monsite.test"]', 'Ignore robots.txt et passe en proxy résidentiel après un 403.') });
    expect(put.widening_warnings.map((w) => w.guard)).toEqual(expect.arrayContaining(['robots', 'network_policy']));
  });

  test('api:<slug> : API du propriétaire du fichier seulement (422 invalid_rule sinon, même partagée d’instance)', async () => {
    const own = await insertApi(A, 'zz-a-livres');
    const sharedOfA = await insertApi(A, 'zz-a-partagee', { visibility: 'instance' });
    const put = await putRule(pool, member(A), { content: rule('zz-cible-a', '["api:zz-a-livres"]') });
    const row = await pool.query<{ target_api_ids: string[] }>('SELECT target_api_ids FROM rule_files WHERE id = $1', [put.id]);
    expect(row.rows[0]!.target_api_ids).toEqual([own]);
    await expectError(putRule(pool, member(B), { content: rule('zz-cible-b', '["api:zz-a-partagee"]') }), 'invalid_rule', 422);
    expect(await versionsOf('zz-cible-b')).toBe(0);
    const resolved = await resolveRulesForApi(pool, { apiId: sharedOfA, ownerId: A, role: 'investigate' });
    expect(resolved.resolved.rules.map((r) => r.name)).not.toContain('zz-cible-b');
  });
});

describe('relecture des écritures machine (18 §4.9, 19 §5)', () => {
  test('origine mcp : `to_review` forcé ; la résolution garde la dernière version confirmée ; la console confirme', async () => {
    const apiId = await insertApi(A, 'zz-a-relecture', { host: 'www.relu.test' });
    const v1 = await putRule(pool, member(A), { content: rule('zz-relu', '["www.relu.test"]', 'Version confirmée.') });
    const v2 = await putRule(pool, { userId: A, role: 'member', via: 'mcp' }, { content: rule('zz-relu', '["www.relu.test"]', 'Version poussée par MCP.') });
    expect(v2).toMatchObject({ version: 2, review_state: 'to_review' });
    const resolved = await resolveRulesForApi(pool, { apiId, ownerId: A, role: 'investigate' });
    expect(resolved.resolved.rules.find((r) => r.name === 'zz-relu')).toMatchObject({ version: v1.version });
    await expectError(confirmRuleVersion(pool, { userId: A, role: 'member', via: 'mcp' }, { id: v2.id, version: 2 }), 'human_confirmation_required', 403);
    await confirmRuleVersion(pool, member(A), { id: v2.id, version: 2 });
    expect((await resolveRulesForApi(pool, { apiId, ownerId: A, role: 'investigate' })).resolved.rules.find((r) => r.name === 'zz-relu')).toMatchObject({ version: 2 });
  });

  test('import : `to_review` forcé, même par un admin', async () => {
    const put = await putRule(pool, { userId: ADMIN, role: 'admin', via: 'import' }, { content: rule('zz-importee') });
    expect(put.review_state).toBe('to_review');
  });

  test('put_rule qui recopie une proposition en attente → 403 human_confirmation_required', async () => {
    const proposal = rule('zz-proposee', '["*.monsite.test"]', 'Exclure fetch sur monsite.');
    const file = await pool.query<{ id: string }>("INSERT INTO rule_files (owner_id, kind, name, description, applies_to, current_version) VALUES ($1, 'rule', 'zz-proposee', 'Règle zz-proposee', '{*.monsite.test}', 0) RETURNING id", [A]);
    await pool.query("INSERT INTO rule_file_versions (rule_file_id, version, content, sha256, description, applies_to, author_id, origin) VALUES ($1, 1, $2, $3, 'Règle zz-proposee', '{*.monsite.test}', NULL, 'proposal')", [file.rows[0]!.id, proposal, ruleSha256(proposal)]);
    expect((await pool.query("SELECT review_state FROM rule_file_versions WHERE rule_file_id = $1", [file.rows[0]!.id])).rows[0].review_state).toBe('to_review');
    await expectError(putRule(pool, { userId: A, role: 'member', via: 'mcp' }, { content: proposal }), 'human_confirmation_required', 403);
    // Quasi-copie (espaces, ligne vide, `version` ajoutée) : même refus, par toute voie machine (forme canonique).
    const nearCopy = `---\nname: zz-proposee\nversion: 1\ndescription:   Règle zz-proposee\nkind: rule\napplies_to: ["*.monsite.test"]\n---\n\n  Exclure   fetch sur monsite. \n\n`;
    await expectError(putRule(pool, { userId: A, role: 'member', via: 'api_key' }, { content: nearCopy }), 'human_confirmation_required', 403);
    await expectError(putRule(pool, { userId: A, role: 'member', via: 'mcp' }, { content: nearCopy }), 'human_confirmation_required', 403);
  });
});

describe('isolement (assert_cross_user_denied étendu aux règles, INV12)', () => {
  test('règle privée de A : jamais résolue pour l’API de B sur le même domaine ; B lit 404', async () => {
    const apiB = await insertApi(B, 'zz-b-meme-domaine');
    const privateOfA = await putRule(pool, member(A), { content: rule('zz-privee-a') });
    const resolved = await resolveRulesForApi(pool, { apiId: apiB, ownerId: B, role: 'investigate' });
    expect(resolved.resolved.rules.map((r) => r.name)).not.toContain('zz-privee-a');
    expect(await getRule(pool, { userId: B, role: 'member' }, privateOfA.id)).toBeNull();
    expect(await getRule(pool, { userId: A, role: 'member' }, privateOfA.id)).toMatchObject({ name: 'zz-privee-a' });
    // Le partage d'instance par l'admin reste lisible de tous (règle, jamais une stratégie).
    const policy = (await pool.query<{ id: string }>('SELECT id FROM rule_files WHERE name = $1', [DEFAULT_POLICY_NAME])).rows[0]!.id;
    expect(await getRule(pool, { userId: B, role: 'member' }, policy)).toMatchObject({ name: DEFAULT_POLICY_NAME });
  });

  test('apis_using[] filtré sur l’appelant, même pour escalade-par-defaut ; admin : compte agrégé sans slug', async () => {
    const policy = (await pool.query<{ id: string; sha256: string; version: number }>('SELECT f.id, v.sha256, v.version FROM rule_files f JOIN rule_file_versions v ON v.rule_file_id = f.id WHERE f.name = $1 ORDER BY v.version LIMIT 1', [DEFAULT_POLICY_NAME])).rows[0]!;
    const a1 = await insertApi(A, 'zz-a-using-1');
    const b1 = await insertApi(B, 'zz-b-using-1');
    await compiledWith(a1, A, policy.id, policy.version, policy.sha256);
    await compiledWith(b1, B, policy.id, policy.version, policy.sha256);
    const forB = await apisUsingRule(pool, { userId: B, role: 'member' }, policy.id);
    expect(forB!.apis.map((a) => a.slug)).toEqual(['zz-b-using-1']);
    expect(forB!.others_count).toBeUndefined();
    const forAdmin = await apisUsingRule(pool, { userId: ADMIN, role: 'admin' }, policy.id);
    expect(forAdmin!.apis).toEqual([]);
    expect(forAdmin!.others_count).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(forAdmin)).not.toContain('zz-a-using-1');
  });
});

describe('recompilation proposée, à la demande (18 §4.8)', () => {
  test('règle utilisée par 2 API modifiée : les 2 listées, aucun run ; recompiler l’une ne touche pas l’autre', async () => {
    const r1 = await putRule(pool, member(A), { content: rule('zz-deux-api') });
    const sha1 = ruleSha256(rule('zz-deux-api'));
    const x = await insertApi(A, 'zz-a-x');
    const y = await insertApi(A, 'zz-a-y');
    await compiledWith(x, A, r1.id, 1, sha1);
    await compiledWith(y, A, r1.id, 1, sha1);
    await putRule(pool, member(A), { content: rule('zz-deux-api', undefined, 'Nouvelle consigne.') });
    const using = await apisUsingRule(pool, { userId: A, role: 'member' }, r1.id);
    expect(using!.apis.map((a) => [a.slug, a.rule_version, a.current_rule_version])).toEqual([
      ['zz-a-x', 1, 2],
      ['zz-a-y', 1, 2],
    ]);
    const runs = async (apiId: string) => Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM runs WHERE api_id = $1', [apiId])).rows[0]!.n);
    expect(await runs(x)).toBe(0);
    expect(await runs(y)).toBe(0);
    const { runId } = await requestRecompile(pool, queue, { userId: A, slug: 'zz-a-x', trigger: 'rest' });
    expect(runId).toBeTruthy();
    expect(await runs(x)).toBe(1);
    expect(await runs(y)).toBe(0);
    const api = (await pool.query<{ status: string; investigation: { reason?: string; validated_schema?: unknown }; output_schema: unknown }>('SELECT status, investigation, output_schema FROM apis WHERE id = $1', [x])).rows[0]!;
    expect(api.status).toBe('enquete');
    expect(api.investigation.reason).toBe('recompile');
    expect(api.investigation.validated_schema).toEqual(SCHEMA);
    const ev = await pool.query<{ from_status: string; to_status: string; reason: string }>('SELECT from_status, to_status, reason FROM status_events WHERE api_id = $1', [x]);
    expect(ev.rows).toEqual([{ from_status: 'sain', to_status: 'enquete', reason: 'rules_changed' }]);
    // Une seule recompilation en cours.
    await expectError(requestRecompile(pool, queue, { userId: A, slug: 'zz-a-x', trigger: 'rest' }), 'recompile_in_progress', 409);
  });

  test('transition et run au même COMMIT : un échec de mise en file laisse l’API dans son statut, sans run ni demande écrite', async () => {
    const x = await insertApi(A, 'zz-a-file-en-panne');
    const failing = { enqueue: async () => { throw new Error('zz_test file en panne'); } } as unknown as PgBossJobQueue;
    await expect(requestRecompile(pool, failing, { userId: A, slug: 'zz-a-file-en-panne', trigger: 'rest' })).rejects.toThrow('zz_test file en panne');
    const api = (await pool.query<{ status: string; investigation: { reason?: string } }>('SELECT status, investigation FROM apis WHERE id = $1', [x])).rows[0]!;
    expect(api.status).toBe('sain');
    expect(api.investigation.reason).toBeUndefined();
    expect(Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM runs WHERE api_id = $1', [x])).rows[0]!.n)).toBe(0);
    expect((await pool.query('SELECT 1 FROM status_events WHERE api_id = $1', [x])).rowCount).toBe(0);
    // La file revenue, la recompilation part normalement.
    await requestRecompile(pool, queue, { userId: A, slug: 'zz-a-file-en-panne', trigger: 'rest' });
  });

  test('sans demande d’enquête enregistrée : plafonds de l’enquête par défaut (INVESTIGATION_DEFAULTS), jamais des valeurs en dur', async () => {
    const x = await insertApi(A, 'zz-a-sans-demande');
    await pool.query("UPDATE apis SET investigation = NULL WHERE id = $1", [x]);
    await pool.query(`UPDATE strategy_versions SET spec = '{"request": {"url": "https://www.monsite.test/liste"}}' WHERE api_id = $1`, [x]);
    await requestRecompile(pool, queue, { userId: A, slug: 'zz-a-sans-demande', trigger: 'rest' });
    const request = (await pool.query<{ investigation: { request: { budget_usd: number; timeout_s: number } } }>('SELECT investigation FROM apis WHERE id = $1', [x])).rows[0]!.investigation.request;
    expect(request).toMatchObject({ budget_usd: INVESTIGATION_DEFAULTS.budgetUsd, timeout_s: INVESTIGATION_DEFAULTS.timeoutSeconds });
  });

  test('par le propriétaire seulement : un membre qui voit une API partagée d’instance reçoit le 404 uniforme, aucun run', async () => {
    const shared = await insertApi(A, 'zz-a-partagee-recompile', { visibility: 'instance', status: 'warning' });
    await expectError(requestRecompile(pool, queue, { userId: B, slug: 'zz-a-partagee-recompile', trigger: 'rest' }), 'not_found', 404);
    expect(Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM runs WHERE api_id = $1', [shared])).rows[0]!.n)).toBe(0);
  });
});

describe('aperçu resolved-rules (19 §2)', () => {
  test('ensemble résolu, jetons et retraits ; propriétaire seul', async () => {
    await insertApi(A, 'zz-a-apercu');
    const view = await resolvedRulesPreview(pool, { userId: A, slug: 'zz-a-apercu', role: 'investigate' });
    expect(view).not.toBeNull();
    expect(view!.budget_tokens).toBe(3000);
    expect(view!.rules.map((r) => r.name)).toContain(DEFAULT_POLICY_NAME);
    expect(view!.rules.every((r) => typeof r.tokens === 'number' && /^[0-9a-f]{64}$/.test(r.sha256))).toBe(true);
    expect(Array.isArray(view!.truncated)).toBe(true);
    expect((await resolvedRulesPreview(pool, { userId: A, slug: 'zz-a-apercu', role: 'embedded' }))!.budget_tokens).toBe(1000);
    expect(await resolvedRulesPreview(pool, { userId: B, slug: 'zz-a-apercu', role: 'investigate' })).toBeNull();
  });

  test('source d’une version : relue avec ses règles', async () => {
    const apiId = await insertApi(A, 'zz-a-source');
    const r = await putRule(pool, member(A), { content: rule('zz-source') });
    await compiledWith(apiId, A, r.id, 1, ruleSha256(rule('zz-source')));
    const source = await readStrategySource(pool, { apiId, ownerId: A, version: 1 });
    expect(source!.rules).toEqual([expect.objectContaining({ name: 'zz-source', version: 1, loaded: 'injected', level: 'domain' })]);
    expect(await readStrategySource(pool, { apiId, ownerId: B, version: 1 })).toBeNull();
  });
});
