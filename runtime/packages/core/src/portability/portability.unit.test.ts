// SPDX-License-Identifier: AGPL-3.0-only
// Format portable d'une API (tâche 3.12, 16 § 6) : enveloppe fermée à clés triées, empreinte d'intégrité, stratégie
// exportable (déclarative, sans session ni tunnel ni code), import qui ignore les champs inconnus et refuse un `$ref`
// distant (INV1), une version de format inconnue, une empreinte fausse, une session.
import { describe, expect, test } from 'vitest';
import { buildImportedPlan } from '../investigation/candidates.js';
import {
  API_EXPORT_FORMAT,
  API_EXPORT_FORMAT_VERSION,
  API_EXPORT_SCHEMA,
  canonicalJson,
  exportableStrategy,
  formatExport,
  parseApiExport,
  portableNetworkAllow,
  sealExport,
  type ApiExportDraft,
} from './index.js';

const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name'],
  properties: { id: { type: 'string' }, name: { type: 'string' }, score: { type: 'integer' } },
};

const INPUT = {
  type: 'object',
  additionalProperties: false,
  properties: { max_pages: { type: 'integer', minimum: 1, maximum: 50, description: 'Nombre maximal de pages lues par run (une page par requête).' } },
};

const SPEC = {
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: 'https://data.zz-test.example/api/items?page=1', allowed_hosts: ['data.zz-test.example'], params: [{ at: 'url.query.page', role: 'pagination' }] },
  sources: [{ id: 'api', from: 'response', format: 'json', records: '$.items[*]' }],
  fields: { id: { path: '$.id', type: 'string', required: true }, name: { path: '$.name', type: 'string', required: true }, score: { path: '$.score', type: 'integer' } },
  pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }], limits: { max_pages_input: 'input.max_pages', hard_max_pages: 50 } },
};

function draft(over: Partial<ApiExportDraft> = {}): ApiExportDraft {
  return {
    format: API_EXPORT_FORMAT,
    format_version: API_EXPORT_FORMAT_VERSION,
    min_runtime_version: '0.0.0',
    exported_at: '2026-10-02T10:00:00.000Z',
    api: {
      slug: 'zz-test-items-abc123',
      description: 'Les éléments du catalogue zz test',
      source_url: 'https://www.zz-test.example/catalogue',
      input_schema: INPUT,
      output_schema: OUTPUT,
      output_columns: ['id', 'name', 'score'],
      views: {},
      purpose: null,
      legal_basis: null,
      contains_personal_data: false,
      max_cost_usd: 0.5,
      budget_daily_usd: 5,
      network_policy: { allow: ['direct'] },
      alert_targets: [{ ref: '$ALERT_WEBHOOK_1', events: ['run.failed'] }],
    },
    strategy: { execution: 'fetch', network: 'direct', spec: SPEC, est_cost_usd: 0.0001 },
    history: [{ version: 1, execution: 'fetch', network: 'direct', created_by: 'investigation', created_at: '2026-10-01T10:00:00.000Z' }],
    schedules: [{ cron: '0 3 * * *', timezone: 'Europe/Paris', input: { max_pages: 2 }, rules: {}, overlap: 'skip', missed: 'skip', enabled: true }],
    ...over,
  };
}

const parse = (doc: unknown, runtimeVersion = '0.1.0') => parseApiExport(doc, { runtimeVersion });

/** Stratégie E4 (`agent_fetch`) du propriétaire, avec ses références de règles (UX-28). */
const AGENT_FETCH_SPEC = {
  schema_version: 1,
  kind: 'agent_fetch',
  request: { url: 'https://www.zz-test.example/catalogue', allowed_hosts: ['www.zz-test.example'] },
  via: 'fetch',
  instruction: 'Return every item of the page with its id, name and score.',
  limits: { max_response_bytes: 5_000_000, max_input_chars: 60_000, timeout_ms: 120_000 },
  rules: { rules: [{ ref: `zz-rule@1#${'a'.repeat(64)}`, level: 'api' as const }], skills: [] },
};

describe('format portable (16 § 6)', () => {
  test('enveloppe scellée : clés triées à toute profondeur, empreinte sha256 sur le JSON canonique sans `integrity`', () => {
    const sealed = sealExport(draft());
    expect(sealed.integrity.sha256).toMatch(/^[a-f0-9]{64}$/);
    const text = formatExport(sealed);
    expect(text.endsWith('\n')).toBe(true);
    // Clés triées (diffs git lisibles) : l'ordre du texte est l'ordre alphabétique, à chaque niveau.
    const top = Object.keys(JSON.parse(text) as object);
    expect(top).toEqual([...top].sort());
    expect(Object.keys((JSON.parse(text) as { api: object }).api)).toEqual(Object.keys((JSON.parse(text) as { api: object }).api).sort());
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
    // Le même contenu dans un autre ordre a la même empreinte.
    const shuffled = Object.fromEntries(Object.entries(draft()).reverse()) as ApiExportDraft;
    expect(sealExport(shuffled).integrity.sha256).toBe(sealed.integrity.sha256);
    // Schéma fermé (additionalProperties: false) à la racine, sur `api`, la stratégie et les planifications.
    expect(API_EXPORT_SCHEMA.additionalProperties).toBe(false);
    expect(API_EXPORT_SCHEMA.properties.api.additionalProperties).toBe(false);
  });

  test('aller-retour : un export scellé se relit tel quel, sans champ ignoré', () => {
    const sealed = sealExport(draft());
    const out = parse(JSON.parse(formatExport(sealed)));
    expect(out).toMatchObject({ ok: true, ignored: [] });
    if (!out.ok) throw new Error('attendu ok');
    expect(out.export.api.output_schema).toEqual(OUTPUT);
    expect(out.export.strategy?.execution).toBe('fetch');
  });

  test('D-123 : `max_cost_usd` null (aucun plafond par run) ou absent est accepté ; un nombre reste un plafond', () => {
    const base = draft();
    for (const value of [null, undefined, 2]) {
      const api = { ...base.api, max_cost_usd: value } as unknown as ApiExportDraft['api'];
      if (value === undefined) delete (api as { max_cost_usd?: unknown }).max_cost_usd;
      const out = parse(sealExport({ ...base, api }));
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (out.ok) expect(out.export.api.max_cost_usd ?? null).toBe(value ?? null);
    }
  });

  test('le format n’a AUCUN champ de session, cookie, secret ni réglage de contournement', () => {
    const names = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'properties' && v !== null && typeof v === 'object') for (const name of Object.keys(v)) names.add(name);
          walk(v);
        }
      }
    };
    walk(API_EXPORT_SCHEMA);
    const forbidden = [...names].filter((n) => /session|cookie|secret|password|token|credential|api_key|proxy_ids|stealth|captcha|fingerprint|robots/i.test(n));
    expect(forbidden).toEqual([]);
  });

  test('champs inconnus ignorés (et listés), à la racine comme dans `api` et les planifications ; l’empreinte porte sur les champs connus', () => {
    const sealed = sealExport(draft());
    const doc = JSON.parse(formatExport(sealed)) as Record<string, unknown> & { api: Record<string, unknown>; schedules: Record<string, unknown>[] };
    doc['zz_extra'] = { any: 1 };
    doc.api['cookies'] = 'zz_test_cookie=SECRET';
    doc.schedules[0]!['webhook_secret'] = 'whsec_zz';
    const out = parse(doc);
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) throw new Error('attendu ok');
    expect([...out.ignored].sort()).toEqual(['$.api.cookies', '$.schedules[0].webhook_secret', '$.zz_extra']);
    expect(JSON.stringify(out.export)).not.toContain('SECRET');
    expect(JSON.stringify(out.export)).not.toContain('whsec_zz');
  });

  test('refus : empreinte fausse, format ou version de format inconnus, runtime trop ancien, enveloppe invalide', () => {
    const sealed = sealExport(draft());
    const tampered = JSON.parse(formatExport(sealed)) as { api: { description: string } };
    tampered.api.description = 'modifiée à la main';
    expect(parse(tampered)).toMatchObject({ ok: false, code: 'integrity_mismatch' });
    expect(parse({ ...sealed, format: 'other.api' })).toMatchObject({ ok: false, code: 'unsupported_format' });
    expect(parse(sealExport(draft({ format_version: '2.0' })))).toMatchObject({ ok: false, code: 'unsupported_format' });
    // Une version mineure plus récente du format 1 se lit (champs inconnus ignorés).
    expect(parse(sealExport(draft({ format_version: '1.7' })))).toMatchObject({ ok: true });
    expect(parse(sealExport(draft({ min_runtime_version: '9.0.0' })), '0.1.0')).toMatchObject({ ok: false, code: 'runtime_too_old' });
    expect(parse('{}')).toMatchObject({ ok: false, code: 'invalid_export' });
    expect(parse({ format: API_EXPORT_FORMAT })).toMatchObject({ ok: false, code: 'invalid_export' });
    // Anti-affectation de masse (08b § 4, cas 4) : identité, propriété, état ou session ne sont pas ignorés, ils sont refusés.
    for (const key of ['owner_id', 'user_id', 'status', 'server_use_allowed', 'requires_session']) {
      expect(parse({ ...sealed, [key]: 'zz' }), key).toMatchObject({ ok: false, code: 'invalid_export' });
      expect(parse({ ...sealed, api: { ...sealed.api, [key]: 'zz' } }), `api.${key}`).toMatchObject({ ok: false, code: 'invalid_export' });
    }
    expect(parse(sealExport({ ...draft(), api: { ...draft().api, description: '' } }))).toMatchObject({ ok: false, code: 'invalid_export' });
  });

  test('INV1 : un `$ref` distant est refusé partout (schémas d’entrée, de sortie, stratégie), sans aucune requête', () => {
    const remote = { ...OUTPUT, properties: { ...OUTPUT.properties, name: { $ref: 'https://evil.zz-test.example/schema.json' } } };
    expect(parse(sealExport(draft({ api: { ...draft().api, output_schema: remote } })))).toMatchObject({ ok: false, code: 'remote_ref' });
    const remoteInput = { ...INPUT, properties: { max_pages: { $ref: 'http://evil.zz-test.example/x' } } };
    expect(parse(sealExport(draft({ api: { ...draft().api, input_schema: remoteInput } })))).toMatchObject({ ok: false, code: 'remote_ref' });
    // Une référence locale (`#/$defs/...`) reste admise.
    const local = { ...OUTPUT, $defs: { s: { type: 'string' } }, properties: { ...OUTPUT.properties, name: { $ref: '#/$defs/s' } } };
    expect(parse(sealExport(draft({ api: { ...draft().api, output_schema: local } })))).toMatchObject({ ok: true });
  });

  test('stratégie : déclarative seulement, hôtes dans la portée du site, jamais de session ni de secret ; échantillon synthétique conforme', () => {
    const withSession = { ...SPEC, request: { ...SPEC.request, session: { mode: 'cookie', domain: 'zz-test.example' } } };
    expect(parse(sealExport(draft({ strategy: { execution: 'fetch', network: 'direct', spec: withSession, est_cost_usd: null } })))).toMatchObject({ ok: false, code: 'invalid_strategy' });
    const secretHeader = { ...SPEC, request: { ...SPEC.request, headers: { Cookie: 'sid=zz' } } };
    expect(parse(sealExport(draft({ strategy: { execution: 'fetch', network: 'direct', spec: secretHeader, est_cost_usd: null } })))).toMatchObject({ ok: false, code: 'invalid_strategy' });
    const elsewhere = { ...SPEC, request: { ...SPEC.request, url: 'https://other.zz-test.invalid/api', allowed_hosts: ['other.zz-test.invalid'] } };
    expect(parse(sealExport(draft({ strategy: { execution: 'fetch', network: 'direct', spec: elsewhere, est_cost_usd: null } })))).toMatchObject({ ok: false, code: 'invalid_strategy' });
    // Couverture des `required` du schéma de sortie (INV1).
    const partial = { ...SPEC, fields: { id: SPEC.fields.id } };
    expect(parse(sealExport(draft({ strategy: { execution: 'fetch', network: 'direct', spec: partial, est_cost_usd: null } })))).toMatchObject({ ok: false, code: 'invalid_strategy' });
    // Tunnel (identité de l'utilisateur) ou agent : hors format.
    expect(parse(sealExport(draft({ strategy: { execution: 'fetch', network: 'tunnel' as 'direct', spec: SPEC, est_cost_usd: null } })))).toMatchObject({ ok: false, code: 'invalid_export' });
    expect(parse(sealExport(draft({ strategy: null })))).toMatchObject({ ok: true });
    expect(parse(sealExport(draft({ fixtures: { items: [{ id: 'a', name: 'b', score: 1 }] } })))).toMatchObject({ ok: true });
    expect(parse(sealExport(draft({ fixtures: { items: [{ id: 'a' }] } })))).toMatchObject({ ok: false, code: 'invalid_fixtures' });
  });

  test('exportableStrategy : la version courante n’est exportée que déclarative, sans script, session ni tunnel', () => {
    expect(exportableStrategy({ execution: 'fetch', network: 'direct', spec: SPEC, script_ref: null, est_cost_usd: '0.000100' })).toEqual({ execution: 'fetch', network: 'direct', spec: SPEC, est_cost_usd: 0.0001 });
    expect(exportableStrategy({ execution: 'hybrid', network: 'direct', spec: SPEC, script_ref: null, est_cost_usd: null })).toBeNull();
    expect(exportableStrategy({ execution: 'agent', network: 'direct', spec: AGENT_FETCH_SPEC, script_ref: null, est_cost_usd: null })).toBeNull();
    expect(exportableStrategy({ execution: 'fetch', network: 'direct', spec: null, script_ref: 'zz/script.js', est_cost_usd: null })).toBeNull();
    expect(exportableStrategy({ execution: 'fetch', network: 'tunnel', spec: SPEC, script_ref: null, est_cost_usd: null })).toBeNull();
    expect(exportableStrategy({ execution: 'fetch', network: 'direct', spec: { ...SPEC, request: { ...SPEC.request, session: { mode: 'cookie', domain: 'zz-test.example' } } }, script_ref: null, est_cost_usd: null })).toBeNull();
    expect(exportableStrategy({ execution: 'fetch', network: 'direct', spec: { ...SPEC, request: { ...SPEC.request, params: [{ at: 'header.x', role: 'session' }] } }, script_ref: null, est_cost_usd: null })).toBeNull();
  });
});

describe('stratégie agent_fetch portée par le fichier (UX-28)', () => {
  test('exportableStrategy : E4 s’exporte sans les références de règles du propriétaire ; spec invalide, hors serveur ou tunnel : null', () => {
    const out = exportableStrategy({ execution: 'agent_fetch', network: 'direct', spec: AGENT_FETCH_SPEC, script_ref: null, est_cost_usd: '0.004000' });
    expect(out).toMatchObject({ execution: 'agent_fetch', network: 'direct', est_cost_usd: 0.004 });
    expect(out!.spec['kind']).toBe('agent_fetch');
    expect(out!.spec).not.toHaveProperty('rules');
    expect(JSON.stringify(out)).not.toContain('zz-rule@1');
    expect(exportableStrategy({ execution: 'agent_fetch', network: 'tunnel', spec: AGENT_FETCH_SPEC, script_ref: null, est_cost_usd: null })).toBeNull();
    expect(exportableStrategy({ execution: 'agent_fetch', network: 'direct', spec: { ...AGENT_FETCH_SPEC, request: { ...AGENT_FETCH_SPEC.request, headers: { authorization: 'x' } } }, script_ref: null, est_cost_usd: null })).toBeNull();
    // Une spécification déclarative sous l'étiquette agent_fetch (ou l'inverse) n'est pas exportée.
    expect(exportableStrategy({ execution: 'agent_fetch', network: 'direct', spec: SPEC, script_ref: null, est_cost_usd: null })).toBeNull();
    expect(exportableStrategy({ execution: 'fetch', network: 'direct', spec: AGENT_FETCH_SPEC, script_ref: null, est_cost_usd: null })).toBeNull();
  });

  test('parseApiExport : la stratégie E4 d’un fichier est relue (spec validée, hôtes dans le site de la demande) ; hôte voisin ou règles refusés', () => {
    const { rules: _rules, ...portable } = AGENT_FETCH_SPEC;
    const ok = parse(sealExport(draft({ strategy: { execution: 'agent_fetch', network: 'direct', spec: portable, est_cost_usd: 0.004 } })));
    if (!ok.ok) throw new Error(`attendu ok : ${ok.code} ${ok.message}`);
    expect(ok.export.strategy).toMatchObject({ execution: 'agent_fetch', network: 'direct' });
    const neighbour = parse(sealExport(draft({ strategy: { execution: 'agent_fetch', network: 'direct', spec: { ...portable, request: { url: 'https://evil.example/', allowed_hosts: ['evil.example'] } }, est_cost_usd: null } })));
    expect(neighbour).toMatchObject({ ok: false, code: 'invalid_strategy' });
    const withRules = parse(sealExport(draft({ strategy: { execution: 'agent_fetch', network: 'direct', spec: AGENT_FETCH_SPEC, est_cost_usd: null } })));
    expect(withRules).toMatchObject({ ok: false, code: 'invalid_strategy' });
    const mismatch = parse(sealExport(draft({ strategy: { execution: 'agent_fetch', network: 'direct', spec: SPEC, est_cost_usd: null } })));
    expect(mismatch).toMatchObject({ ok: false, code: 'invalid_strategy' });
  });

  test('buildImportedPlan : E4 importé s’essaie sans navigateur (via fetch), au prix du modèle d’extraction ; sans prix, coût inconnu', () => {
    const networks = [{ mode: 'direct' as const, perGbUsd: 0 }];
    const priced = buildImportedPlan({ execution: 'agent_fetch', spec: AGENT_FETCH_SPEC, networks, browser: false, llmPrice: { in: 1, out: 5 } });
    expect(priced.map((p) => [p.execution, p.network, p.source])).toEqual([['agent_fetch', 'direct', 'import']]);
    expect(priced[0]!.est_cost_usd).toBeGreaterThan(0);
    expect(buildImportedPlan({ execution: 'agent_fetch', spec: AGENT_FETCH_SPEC, networks, browser: false })[0]!.est_cost_usd).toBeNull();
    // Via la page ouverte (fetch_in_page) : il faut Chromium, comme E2.
    const inPage = { ...AGENT_FETCH_SPEC, via: 'fetch_in_page' };
    expect(buildImportedPlan({ execution: 'agent_fetch', spec: inPage, networks, browser: false })).toEqual([]);
    expect(buildImportedPlan({ execution: 'agent_fetch', spec: inPage, networks, browser: true })).toHaveLength(1);
  });
});

describe('tunnel : jamais porté par un fichier (INV5, revue 3.12)', () => {
  test('import : `tunnel` dans network_policy.allow est écarté et listé ; politique vide → direct', () => {
    const both = parse(sealExport(draft({ api: { ...draft().api, network_policy: { allow: ['direct', 'tunnel'] } } })));
    if (!both.ok) throw new Error(`attendu ok : ${both.code}`);
    expect(both.export.api.network_policy).toEqual({ allow: ['direct'] });
    expect(both.ignored).toEqual(['$.api.network_policy.allow[1]']);
    const only = parse(sealExport(draft({ api: { ...draft().api, network_policy: { allow: ['tunnel'] } } })));
    if (!only.ok) throw new Error(`attendu ok : ${only.code}`);
    expect(only.export.api.network_policy).toEqual({ allow: ['direct'] });
    expect(JSON.stringify(only.export.api)).not.toContain('tunnel');
  });

  test('portableNetworkAllow : niveaux exportables seulement, dans l’ordre, sans doublon ; jamais vide', () => {
    expect(portableNetworkAllow(['direct', 'tunnel', 'dc_proxy'])).toEqual(['direct', 'dc_proxy']);
    expect(portableNetworkAllow(['tunnel'])).toEqual(['direct']);
    expect(portableNetworkAllow(['res_proxy', 'res_proxy', 'zz'])).toEqual(['res_proxy']);
    expect(portableNetworkAllow(undefined)).toEqual(['direct']);
  });

  test('buildImportedPlan : une spécification importée ne passe jamais par le tunnel, même si la politique l’admet', () => {
    const networks = [
      { mode: 'direct' as const, perGbUsd: 0 },
      { mode: 'tunnel' as const, perGbUsd: 0 },
    ];
    expect(buildImportedPlan({ execution: 'fetch', spec: SPEC, networks, browser: false }).map((p) => p.network)).toEqual(['direct']);
    // Sans Chromium, E3 importé n'a aucun essai (jamais un repli vers le navigateur de l'utilisateur).
    expect(buildImportedPlan({ execution: 'playwright', spec: SPEC, networks, browser: false })).toEqual([]);
    expect(buildImportedPlan({ execution: 'playwright', spec: SPEC, networks, browser: true }).map((p) => p.network)).toEqual(['direct']);
  });
});
