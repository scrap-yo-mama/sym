// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.3 en logique pure : items écartés et quarantaine (D-49, 04 §5), seuil de casse, validation contre les dernières
// sorties saines, boucle de réparation (correctif répété, budget), escalade, `output_schema` jamais modifié.
import { describe, expect, test } from 'vitest';
import { extractRecords } from '../dsl/extract.js';
import type { RenderedRequest } from '../dsl/template.js';
import { runDeclarative } from '../exec/declarative.js';
import type { HttpExchange } from '../exec/types.js';
import { validateRepairPatch } from '../dsl/patch.js';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import { PersonalValueRegistry } from '../privacy/mask.js';
import { validateOutput } from '../schema/validator.js';
import { checkAgainstHealthy, healthyProfile } from './healthy.js';
import { escalationExecutions, RepairLedger, REPAIR_DEFAULTS } from './policy.js';
import {
  ITEMS_REJECTED_DEFAULTS,
  itemIssues,
  partitionItems,
  quarantineSummary,
  REJECTED_VALUE_MASK,
  rejectionReasons,
  rejectionThresholdsFromEnv,
  rejectionVerdict,
  sanitizeRejectedItem,
  stripUndeclared,
} from './quarantine.js';

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['titre', 'prix'],
  properties: {
    titre: { type: 'string' },
    prix: { type: 'number' },
    vendeur: { type: 'string', 'x-personal': true },
    extra: { type: 'object', properties: { ville: { type: 'string' } }, additionalProperties: false },
  },
  additionalProperties: false,
};

const good = (i: number) => ({ titre: `Vélo ${i}`, prix: 100 + i, vendeur: `Zztest Vendeur ${i}` });

describe('items écartés (D-49, 04 §5)', () => {
  test('assert_delivered_items_conform — partition : seuls les items conformes sont livrables, ordre conservé', () => {
    const items = [good(1), { titre: 'Vélo 2' }, good(3), { titre: 'Vélo 4', prix: 'cher' }, good(5)];
    const { conform, rejected } = partitionItems(SCHEMA, items);
    expect(conform).toEqual([good(1), good(3), good(5)]);
    for (const item of conform) expect(validateOutput(SCHEMA, item)).toEqual({ ok: true });
    expect(rejected).toHaveLength(2);
    expect(rejected[0]!.issues).toEqual([{ keyword: 'required', instance_path: '/prix' }]);
    expect(rejected[1]!.issues).toEqual([{ keyword: 'type', instance_path: '/prix' }]);
  });

  test('assert_rejected_items_quarantined — 48 items dont 1 sans prix : raison required /prix, sans valeur', () => {
    const items = [...Array.from({ length: 47 }, (_, i) => good(i)), { titre: 'Vélo sans prix', vendeur: 'Zztest Personne' }];
    const { conform, rejected } = partitionItems(SCHEMA, items);
    expect(conform).toHaveLength(47);
    expect(rejectionVerdict(conform.length, rejected.length)).toBe('degraded');
    const summary = quarantineSummary(SCHEMA, rejected);
    expect(summary.total_rejected).toBe(1);
    expect(summary.by_reason).toEqual([{ keyword: 'required', instance_path: '/prix', count: 1 }]);
    // Échantillon : champ personnel masqué (couche 1), aucune valeur de vendeur nulle part.
    expect(JSON.stringify(summary)).not.toContain('Zztest Personne');
    expect(summary.sample).toEqual([{ titre: 'Vélo sans prix', vendeur: '[PERSONAL]' }]);
  });

  test('assert_rejected_items_quarantined — un e-mail sous une clé inconnue : clé absente de l’échantillon, e-mail nulle part', () => {
    const item = { titre: 'Vélo', prix: 'N/A', note_cachee: 'zz_test_leak@example.invalid', extra: { ville: 'Lyon', contact_email: 'zz_test_leak2@example.invalid' } };
    const { rejected } = partitionItems(SCHEMA, [item]);
    const summary = quarantineSummary(SCHEMA, rejected);
    const text = JSON.stringify(summary);
    expect(text).not.toContain('example.invalid');
    expect(summary.sample).toEqual([{ titre: 'Vélo', prix: REJECTED_VALUE_MASK, extra: { ville: 'Lyon' } }]);
    // Une propriété non déclarée n'est jamais nommée dans les raisons (son nom vient du site) : segment neutre `*`.
    expect(summary.by_reason.map((r) => `${r.keyword}:${r.instance_path}`).sort()).toEqual(['additionalProperties:/*', 'additionalProperties:/extra/*', 'type:/prix']);
  });

  test('raisons sans valeur : un nom de clé non déclaré (identifiant, nom…) ne sort jamais dans by_reason, seulement `*`', () => {
    const items = [
      { titre: 'a', prix: 1, zz_test_secret_id_123: true },
      { titre: 'b', prix: 2, extra: { ville: 'Lyon', zz_test_secret_id_123: 'x', autre_cle: 1 } },
      { titre: 'c', prix: 'N/A', zz_test_secret_id_123: 1, zz_test_other_456: 2 },
    ];
    const summary = quarantineSummary(SCHEMA, partitionItems(SCHEMA, items).rejected);
    expect(JSON.stringify(summary)).not.toMatch(/zz_test_secret_id_123|zz_test_other_456|autre_cle/);
    // Un compte par item et par (mot-clé, pointeur neutre) : deux clés inconnues du même item comptent une fois.
    expect(summary.by_reason).toEqual([
      { keyword: 'additionalProperties', instance_path: '/*', count: 2 },
      { keyword: 'additionalProperties', instance_path: '/extra/*', count: 1 },
      { keyword: 'type', instance_path: '/prix', count: 1 },
    ]);
  });

  test('échantillon : une chaîne longue est coupée à une limite de mot, jamais au milieu d’un mot (effacement par motif borné)', () => {
    const titre = `${'A'.repeat(110)} Jean Dupont et la suite`;
    const sample = sanitizeRejectedItem(SCHEMA, { item: { titre, prix: 'x' }, issues: [{ keyword: 'type', instance_path: '/prix' }] }) as Record<string, string>;
    expect(sample['titre']).toBe(`${'A'.repeat(110)} Jean…`);
    expect(sample['titre']).not.toContain('Dupo');
    // Un seul mot plus long que la borne : rien n'en reste.
    const one = sanitizeRejectedItem(SCHEMA, { item: { titre: 'B'.repeat(300), prix: 'x' }, issues: [] }) as Record<string, string>;
    expect(one['titre']).toBe('…');
  });

  test('échantillon : propriétés non déclarées retirées même sous __proto__, valeurs du registre du run masquées, chaînes tronquées', () => {
    const hostile = JSON.parse('{"titre":"x","prix":"bad","__proto__":{"polluted":true},"constructor":"y"}') as unknown;
    const stripped = stripUndeclared(SCHEMA, hostile);
    expect(stripped.removed.sort()).toEqual(['/__proto__', '/constructor']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    const registry = new PersonalValueRegistry();
    registry.add('Zztest Inconnu Du Schema');
    const long = 'L'.repeat(500);
    const sample = sanitizeRejectedItem(SCHEMA, { item: { titre: `${long} Zztest Inconnu Du Schema`, prix: -1, vendeur: 'a@b.example' }, issues: [{ keyword: 'minimum', instance_path: '/prix' }] }, registry) as Record<string, string>;
    expect(sample['prix']).toBe(REJECTED_VALUE_MASK);
    expect(sample['vendeur']).toBe('[PERSONAL]');
    expect(sample['titre']!.length).toBeLessThanOrEqual(121);
    expect(JSON.stringify(sample)).not.toContain('Zztest Inconnu');
  });

  test('échantillon : 5 items au plus ; raisons agrégées par (mot-clé, pointeur), un compte par item', () => {
    const rejected = partitionItems(SCHEMA, Array.from({ length: 9 }, (_, i) => ({ titre: `t${i}`, prix: String(i) }))).rejected;
    const summary = quarantineSummary(SCHEMA, rejected);
    expect(summary.sample).toHaveLength(ITEMS_REJECTED_DEFAULTS.sampleSize);
    expect(rejectionReasons(rejected)).toEqual([{ keyword: 'type', instance_path: '/prix', count: 9 }]);
    expect(itemIssues(SCHEMA, good(1))).toEqual([]);
  });

  test('assert_rejection_threshold_breaks — casse au-delà de 20 % ET 5 items, ou à 0 conforme ; strict à l’enquête', () => {
    expect(rejectionVerdict(70, 30)).toBe('break'); // 30 % et 30 ≥ 5
    expect(rejectionVerdict(0, 3)).toBe('break'); // 0 conforme
    expect(rejectionVerdict(0, 0)).toBe('break'); // rien d'extrait
    expect(rejectionVerdict(1, 3)).toBe('degraded'); // 75 % mais 3 < 5 : cas noté « à valider » (04 §5)
    expect(rejectionVerdict(96, 4)).toBe('degraded');
    expect(rejectionVerdict(80, 20)).toBe('degraded'); // 20 % pile : pas au-delà
    expect(rejectionVerdict(79, 21)).toBe('break');
    expect(rejectionVerdict(10, 0)).toBe('clean');
    expect(rejectionVerdict(29, 1, ITEMS_REJECTED_DEFAULTS, true)).toBe('break'); // enquête : 0 rejet exigé
    expect(rejectionThresholdsFromEnv({})).toEqual({ maxShare: 0.2, minCount: 5 });
    expect(rejectionThresholdsFromEnv({ ITEMS_REJECTED_MAX_SHARE: '0.1', ITEMS_REJECTED_MIN_COUNT: '2' })).toEqual({ maxShare: 0.1, minCount: 2 });
    expect(() => rejectionThresholdsFromEnv({ ITEMS_REJECTED_MAX_SHARE: '2' })).toThrow();
    expect(() => rejectionThresholdsFromEnv({ ITEMS_REJECTED_MIN_COUNT: '0' })).toThrow();
  });
});

const SPEC_INPUT = {
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: 'https://zz-test.example/api/items', allowed_hosts: ['zz-test.example'] },
  sources: [{ id: 'api', from: 'response', format: 'json', records: '$.items[*]' }],
  fields: { titre: { path: '$.title', type: 'string', required: true }, prix: { path: '$.price', type: 'number', required: true } },
};
const OUT = { type: 'object', required: ['titre', 'prix'], properties: { titre: { type: 'string' }, prix: { type: 'number' } }, additionalProperties: false };

function spec(): DeclarativeSpec {
  const check = validateDeclarativeSpec(SPEC_INPUT, { outputSchema: OUT });
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

describe('extraction en politique `quarantine` (runs)', () => {
  const body = JSON.stringify({ items: [{ title: 'a', price: 1 }, { title: 'b', price: 'N/A' }, { title: 'c', price: 3 }] });

  test('strict (enquête, défaut) : un item non conforme écarte la source', () => {
    expect(extractRecords(spec(), { body }, { outputSchema: OUT }).ok).toBe(false);
  });

  test('quarantine : la source passe, l’item mal typé garde sa valeur (raison `type`), puis est écarté par Ajv', () => {
    const out = extractRecords(spec(), { body }, { outputSchema: OUT, itemPolicy: 'quarantine' });
    expect(out.ok).toBe(true);
    expect(out.records).toHaveLength(3);
    const { conform, rejected } = partitionItems(OUT, out.records);
    expect(conform.map((r) => r['titre'])).toEqual(['a', 'c']);
    expect(rejected[0]!.issues).toEqual([{ keyword: 'type', instance_path: '/prix' }]);
  });

  test('quarantine : 0 enregistrement conforme sur une page : la source est écartée (repli), mais ses enregistrements sont rendus à l’exécuteur', () => {
    const all = JSON.stringify({ items: [{ title: 'a' }, { title: 'b', price: 'N/A' }] });
    const out = extractRecords(spec(), { body: all }, { outputSchema: OUT, itemPolicy: 'quarantine' });
    // Le seuil de casse se décide sur le run (D-49), pas sur la page : les items vont au tri (Ajv), puis en quarantaine.
    expect(out.ok).toBe(true);
    expect(out.attempts[0]!.ok).toBe(false);
    expect(out.records).toHaveLength(2);
    expect(partitionItems(OUT, out.records).conform).toHaveLength(0);
    // Strict (enquête) : inchangé, la source casse.
    expect(extractRecords(spec(), { body: all }, { outputSchema: OUT }).ok).toBe(false);
  });

  test('quarantine : une source de repli conforme l’emporte sur une source sans aucun item conforme', () => {
    const withFallback = validateDeclarativeSpec(
      { ...SPEC_INPUT, sources: [{ id: 'api', from: 'response', format: 'json', records: '$.items[*]' }, { id: 'alt', from: 'response', format: 'json', records: '$.alt[*]' }] },
      { outputSchema: OUT },
    );
    if (!withFallback.ok) throw new Error(JSON.stringify(withFallback.errors));
    const body2 = JSON.stringify({ items: [{ title: 'a' }], alt: [{ title: 'b', price: 2 }] });
    const out = extractRecords(withFallback.spec, { body: body2 }, { outputSchema: OUT, itemPolicy: 'quarantine' });
    expect(out).toMatchObject({ ok: true, source_id: 'alt', escalated: true });
    expect(out.records).toEqual([{ titre: 'b', prix: 2 }]);
  });

  test('quarantine : une source sans aucun enregistrement casse toujours (problème de source, pas d’item)', () => {
    expect(extractRecords(spec(), { body: JSON.stringify({ items: [] }) }, { outputSchema: OUT, itemPolicy: 'quarantine' }).ok).toBe(false);
  });
});

describe('pagination en politique `quarantine` : le seuil de casse se décide sur le run, pas page par page (04 §5)', () => {
  const PAGED = {
    ...SPEC_INPUT,
    request: { ...SPEC_INPUT.request, params: [{ at: 'url.query.page', role: 'pagination' }] },
    pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 10 } },
  };
  const paged = (): DeclarativeSpec => {
    const check = validateDeclarativeSpec(PAGED, { outputSchema: OUT });
    if (!check.ok) throw new Error(JSON.stringify(check.errors));
    return check.spec;
  };
  const goods = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ title: `t${from + i}`, price: from + i }));
  const transport = (pages: Record<string, unknown[]>) => async (r: RenderedRequest): Promise<HttpExchange> => {
    const page = new URL(r.url).searchParams.get('page') ?? '1';
    return { status: 200, headers: {}, body: JSON.stringify({ items: pages[page] ?? [] }), url: r.url };
  };
  const run = (pages: Record<string, unknown[]>) =>
    runDeclarative({ spec: paged(), input: {}, outputSchema: OUT, itemPolicy: 'quarantine', transport: transport(pages), signal: new AbortController().signal });

  test('dernière page d’un seul item non conforme : 20 livrés, 1 écarté, run dégradé (1/21, sous 20 % et sous 5)', async () => {
    const out = await run({ '1': goods(0, 10), '2': goods(10, 10), '3': [{ title: 'last', price: 'N/A' }] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.records).toHaveLength(21);
    const { conform, rejected } = partitionItems(OUT, out.records);
    expect(conform).toHaveLength(20);
    expect(rejected).toHaveLength(1);
    expect(rejectionVerdict(conform.length, rejected.length)).toBe('degraded');
    // Preuve d'une page aux items écartés (garde puis squelette pour le rôle `repair`, 04 §5 étape 1).
    expect(out.evidence?.body).toContain('N/A');
  });

  test('page intermédiaire entièrement non conforme, sous le seuil : la pagination continue, le run livre', async () => {
    const out = await run({ '1': goods(0, 10), '2': [{ title: 'x' }, { title: 'y', price: 'N/A' }, { title: 'z' }], '3': goods(20, 10) });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.pages).toBe(4);
    const { conform, rejected } = partitionItems(OUT, out.records);
    expect([conform.length, rejected.length]).toEqual([20, 3]);
    expect(rejectionVerdict(conform.length, rejected.length)).toBe('degraded');
  });

  test('0 item conforme sur tout le run : casse (verdict `break`), pas une livraison', async () => {
    const out = await run({ '1': [{ title: 'x' }], '2': [{ title: 'y', price: 'N/A' }] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { conform, rejected } = partitionItems(OUT, out.records);
    expect(rejectionVerdict(conform.length, rejected.length)).toBe('break');
  });

  test('strict (enquête) : une page non conforme fait toujours échouer l’essai', async () => {
    const out = await runDeclarative({ spec: paged(), input: {}, outputSchema: OUT, transport: transport({ '1': goods(0, 10), '2': [{ title: 'last', price: 'N/A' }] }), signal: new AbortController().signal });
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'extraction' } });
  });
});

describe('réparation : patch borné, sorties saines, arrêt', () => {
  test('assert_output_schema_enforced — une réparation qui assouplit output_schema est rejetée, output_schema inchangé', () => {
    const current = spec();
    const before = JSON.stringify(OUT);
    const loosen = validateRepairPatch(current, [{ op: 'remove', path: '/output_schema/required/1' }], { outputSchema: OUT });
    expect(loosen).toMatchObject({ ok: false, rejections: [{ code: 'forbidden_output_schema' }] });
    const hosts = validateRepairPatch(current, [{ op: 'add', path: '/request/allowed_hosts/-', value: 'evil.example' }], { outputSchema: OUT });
    expect(hosts).toMatchObject({ ok: false, rejections: [{ code: 'forbidden_allowed_hosts' }] });
    // Un champ requis retiré de `fields` : la stratégie corrigée ne couvre plus le schéma, refusée.
    const drop = validateRepairPatch(current, [{ op: 'remove', path: '/fields/prix' }], { outputSchema: OUT });
    expect(drop.ok).toBe(false);
    expect(JSON.stringify(OUT)).toBe(before);
    const fix = validateRepairPatch(current, [{ op: 'replace', path: '/fields/titre/path', value: '$.name' }], { outputSchema: OUT });
    expect(fix.ok).toBe(true);
  });

  test('sorties saines : un champ toujours rempli perdu ou retypé par la réparation = faux succès refusé', () => {
    const healthy = healthyProfile(Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: `n${i}`, city: 'Lyon', score: i })));
    expect(healthy.stable).toEqual({ '/city': 'string', '/id': 'string', '/name': 'string', '/score': 'number' });
    expect(healthy.fingerprint).toMatch(/^sha256:/);
    const repaired = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: `n${i}`, city: 'Lyon', score: i }));
    expect(checkAgainstHealthy(healthy, repaired)).toEqual({ ok: true });
    const lost = repaired.map(({ city: _city, ...rest }) => rest);
    expect(checkAgainstHealthy(healthy, lost)).toEqual({ ok: false, missing: ['/city'], type_changed: [] });
    const retyped = repaired.map((r) => ({ ...r, score: String(r.score) }));
    expect(checkAgainstHealthy(healthy, retyped)).toEqual({ ok: false, missing: [], type_changed: ['/score'] });
    // Sans référence suffisante, seul le schéma juge.
    expect(checkAgainstHealthy(healthyProfile([{ a: 1 }]), [])).toEqual({ ok: true });
  });

  test('sorties saines après un changement de output_schema : seuls les champs DÉCLARÉS du schéma courant, items conformes à lui', () => {
    // Anciennes sorties : `legacy` toujours rempli, `score` en nombre. Schéma courant : `legacy` retiré, `score` en texte.
    const old = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: `n${i}`, legacy: 'x', score: i }));
    const current = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' }, score: { type: 'string' } } };
    const profile = healthyProfile(old, { outputSchema: current });
    // Aucune ancienne sortie n'est conforme au schéma courant (score en nombre) : pas de référence, seul le schéma juge.
    expect(profile.stable).toEqual({});
    const repaired = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: `n${i}`, score: String(i) }));
    expect(checkAgainstHealthy(profile, repaired)).toEqual({ ok: true });
    // Champ retiré du schéma (propriétés libres) : il n'est plus « stable », la réparation qui ne le livre plus passe.
    const open = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' } } };
    const kept = healthyProfile(old, { outputSchema: open });
    expect(kept.stable).toEqual({ '/id': 'string', '/name': 'string' });
    expect(checkAgainstHealthy(kept, repaired.map(({ score: _s, ...r }) => r))).toEqual({ ok: true });
  });

  test('correctif répété → arrêt `repeated_patch` ; budget et nombre de propositions bornés', () => {
    const ledger = new RepairLedger();
    expect(ledger.canPropose(0.01)).toBe(true);
    expect(ledger.propose('sha256:a')).toBe(true);
    expect(ledger.canPropose(0.01)).toBe(true);
    expect(ledger.propose('sha256:a')).toBe(false);
    expect(ledger.stopped).toBe('repeated_patch');
    expect(ledger.canPropose(0)).toBe(false);
    expect(ledger.finish()).toBe('repeated_patch');

    const capped = new RepairLedger({ budgetUsd: 0.05 });
    for (let i = 0; i < REPAIR_DEFAULTS.maxAttempts; i += 1) {
      expect(capped.canPropose(0.001)).toBe(true);
      capped.propose(`k${i}`);
    }
    expect(capped.canPropose(0.001)).toBe(false);
    expect(capped.finish()).toBe('budget_exhausted');

    const money = new RepairLedger({ budgetUsd: 0.05 });
    expect(money.canPropose(0.06)).toBe(false);
    const unknown = new RepairLedger({ budgetUsd: 0.05 });
    unknown.spend(null); // prix inconnu : le plafond n'est plus tenable
    expect(unknown.remainingUsd).toBe(0);
  });

  test('mutations hors du patch borné (15 §11) : move_endpoint (URL) et change_pagination (paramètre non déclaré) refusées', () => {
    const current = spec();
    // move_endpoint : l'URL de la requête n'est pas dans sources, fields ni pagination (04b §2).
    const moved = validateRepairPatch(current, [{ op: 'replace', path: '/request/url', value: 'https://zz-test.example/api/v2/items' }], { outputSchema: OUT });
    expect(moved).toMatchObject({ ok: false, rejections: [{ code: 'forbidden_path' }] });
    // change_pagination (page → offset/limit) : le nouveau paramètre devrait être déclaré dans request.params, hors du patch.
    const offset = validateRepairPatch(
      current,
      [{ op: 'add', path: '/pagination', value: { type: 'offset', param: 'url.query.offset', start: 0, step: 'items_received', stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 50 } } }],
      { outputSchema: OUT },
    );
    expect(offset.ok).toBe(false);
    const params = validateRepairPatch(current, [{ op: 'add', path: '/request/params', value: [{ at: 'url.query.offset', role: 'pagination' }] }], { outputSchema: OUT });
    expect(params.ok).toBe(false);
  });

  test('escalade : exécutions déclaratives plus chères, jamais un agent, Chromium requis pour E2/E3', () => {
    expect(escalationExecutions('fetch', { browser: true })).toEqual(['fetch_in_page', 'playwright']);
    expect(escalationExecutions('fetch_in_page', { browser: true })).toEqual(['playwright']);
    expect(escalationExecutions('fetch', { browser: false })).toEqual([]);
    expect(escalationExecutions('playwright', { browser: true })).toEqual([]);
    expect(escalationExecutions('agent', { browser: true })).toEqual([]);
  });
});
