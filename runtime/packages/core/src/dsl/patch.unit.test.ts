// SPDX-License-Identifier: AGPL-3.0-only
// Patch de réparation RFC 6902 borné (04b § 2, 04 § 5) : critère 1.1b « patch sur allowed_hosts rejeté ».
import { describe, expect, it } from 'vitest';
import { patchKey, validateRepairPatch, type PatchRejectionCode } from './patch.js';
import { validateDeclarativeSpec, type DeclarativeSpec } from './spec.js';

const OUTPUT_SCHEMA = { type: 'object', required: ['titre', 'prix'], properties: { titre: { type: 'string' }, prix: { type: 'number' } } };

function base(): DeclarativeSpec {
  const check = validateDeclarativeSpec(
    {
      schema_version: 1,
      kind: 'declarative',
      request: {
        method: 'POST',
        url: 'https://api.exemple.test/search',
        allowed_hosts: ['api.exemple.test'],
        headers: { 'content-type': 'application/json' },
        session: { mode: 'session_cookie', domain: 'exemple.test', inject: ['cookie'] },
        body: { json: { q: '{{input.query}}', offset: '{{page.offset}}' } },
        params: [
          { at: 'body.json.q', role: 'input', name: 'query' },
          { at: 'body.json.offset', role: 'pagination' },
        ],
      },
      sources: [
        { id: 'api', from: 'response', format: 'json', records: '$.ads[*]' },
        { id: 'ssr', from: 'embedded', locator: { kind: 'next_data' }, records: '$.props.pageProps.ads[*]' },
      ],
      fields: {
        titre: { path: '$.subject', type: 'string', required: true, ops: ['trim'] },
        prix: { path: '$.price[0]', type: 'number', required: true, ops: ['to_number'] },
      },
      pagination: {
        type: 'offset',
        param: 'body.json.offset',
        start: 0,
        step: 'items_received',
        stop: [{ when: 'records_empty' }, { when: 'path_equals', path: '$.has_more', value: false }],
        limits: { hard_max_pages: 50 },
      },
      expect: { min_records: 1 },
      limits: { max_response_bytes: 5_000_000, max_depth: 32, timeout_ms: 15_000 },
    },
    { outputSchema: OUTPUT_SCHEMA },
  );
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

const codes = (r: ReturnType<typeof validateRepairPatch>): PatchRejectionCode[] => (r.ok ? [] : r.rejections.map((x) => x.code));

describe('patch de réparation : chemins interdits', () => {
  it.each([
    ['remplacer un hôte autorisé', [{ op: 'replace', path: '/request/allowed_hosts/0', value: 'evil.test' }]],
    ['ajouter un hôte autorisé', [{ op: 'add', path: '/request/allowed_hosts/-', value: 'evil.test' }]],
    ['remplacer la liste entière', [{ op: 'replace', path: '/request/allowed_hosts', value: ['evil.test'] }]],
    ['supprimer la liste', [{ op: 'remove', path: '/request/allowed_hosts' }]],
    ['déplacer depuis allowed_hosts', [{ op: 'move', from: '/request/allowed_hosts', path: '/fields/x' }]],
    ['copier vers allowed_hosts', [{ op: 'copy', from: '/fields/titre', path: '/request/allowed_hosts' }]],
    ['segment unique « request/allowed_hosts » (~1) : pas de contournement', [{ op: 'replace', path: '/request~1allowed_hosts', value: ['x'] }]],
  ])('allowed_hosts : %s → rejeté', (_name, patch) => {
    const r = validateRepairPatch(base(), patch);
    expect(r.ok).toBe(false);
    expect(codes(r).some((c) => c === 'forbidden_allowed_hosts' || c === 'forbidden_path')).toBe(true);
  });

  it('un patch qui modifie request.allowed_hosts est rejeté avec le code forbidden_allowed_hosts', () => {
    const r = validateRepairPatch(base(), [{ op: 'add', path: '/request/allowed_hosts/-', value: 'evil.test' }], { outputSchema: OUTPUT_SCHEMA });
    expect(r).toMatchObject({ ok: false, rejections: [{ index: 0, code: 'forbidden_allowed_hosts' }] });
  });

  it('session, output_schema, url, limites, expect : rejetés', () => {
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '/request/session/domain', value: 'evil.test' }]))).toEqual(['forbidden_session']);
    expect(codes(validateRepairPatch(base(), [{ op: 'remove', path: '/request/session' }]))).toEqual(['forbidden_session']);
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '/output_schema/required', value: [] }]))).toEqual(['forbidden_output_schema']);
    expect(codes(validateRepairPatch(base(), [{ op: 'remove', path: '/output_schema/required/1' }]))).toEqual(['forbidden_output_schema']);
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '/request/url', value: 'https://evil.test/' }]))).toEqual(['forbidden_path']);
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '/limits/timeout_ms', value: 60_000 }]))).toEqual(['forbidden_path']);
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '/expect/min_records', value: 0 }]))).toEqual(['forbidden_path']);
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '/steps', value: [] }]))).toEqual(['forbidden_path']);
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '', value: {} }]))).toEqual(['forbidden_path']);
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '/kind', value: 'script' }]))).toEqual(['forbidden_path']);
  });

  it('pointeurs piégés : prototype, échappement invalide, profondeur', () => {
    expect(codes(validateRepairPatch(base(), [{ op: 'add', path: '/fields/__proto__/polluted', value: true }]))).toEqual(['forbidden_path']);
    expect(codes(validateRepairPatch(base(), [{ op: 'add', path: '/fields/constructor', value: {} }]))).toEqual(['forbidden_path']);
    expect(codes(validateRepairPatch(base(), [{ op: 'add', path: '/fields/a~2b', value: {} }]))).toEqual(['invalid_patch']);
    expect(codes(validateRepairPatch(base(), [{ op: 'add', path: 'fields/a', value: {} }]))).toEqual(['invalid_patch']);
    expect(codes(validateRepairPatch(base(), [{ op: 'add', path: `/fields${'/a'.repeat(20)}`, value: {} }]))).toEqual(['forbidden_path']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('structure : opération inconnue, clé inconnue, from/value mal placés, trop d\'opérations, trop gros', () => {
    expect(codes(validateRepairPatch(base(), 'oops'))).toEqual(['invalid_patch']);
    expect(codes(validateRepairPatch(base(), []))).toEqual(['invalid_patch']);
    expect(codes(validateRepairPatch(base(), [{ op: 'eval', path: '/fields/x' }]))).toEqual(['invalid_patch']);
    expect(codes(validateRepairPatch(base(), [{ op: 'remove', path: '/fields/prix', script: 'x' }]))).toEqual(['invalid_patch']);
    expect(codes(validateRepairPatch(base(), [{ op: 'add', path: '/fields/x' }]))).toEqual(['invalid_patch']);
    expect(codes(validateRepairPatch(base(), [{ op: 'move', path: '/fields/x' }]))).toEqual(['invalid_patch']);
    const many = Array.from({ length: 21 }, (_, i) => ({ op: 'add', path: `/fields/f${i}`, value: { type: 'string', path: '$.a' } }));
    expect(codes(validateRepairPatch(base(), many))).toEqual(['too_many_operations']);
    expect(codes(validateRepairPatch(base(), [{ op: 'add', path: '/fields/x', value: { type: 'string', path: `$.${'a'.repeat(70_000)}` } }]))).toEqual(['patch_too_large']);
  });
});

describe('patch de réparation : réparations admises', () => {
  it('remplacer un chemin, ajouter un repli, ajouter un opérateur', () => {
    const r = validateRepairPatch(
      base(),
      [
        { op: 'replace', path: '/fields/titre/path', value: '$.title' },
        { op: 'add', path: '/fields/titre/fallback_paths', value: ['$.subject'] },
        { op: 'add', path: '/fields/prix/ops/-', value: { op: 'default', value: 0 } },
      ],
      { outputSchema: OUTPUT_SCHEMA },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.fields['titre']?.path).toBe('$.title');
      expect(r.key).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('ne modifie jamais la stratégie d\'origine', () => {
    const current = base();
    const before = JSON.stringify(current);
    validateRepairPatch(current, [{ op: 'replace', path: '/sources/0/records', value: '$.data[*]' }]);
    expect(JSON.stringify(current)).toBe(before);
  });

  it('la clé d\'un patch est stable (même correctif proposé deux fois = même clé)', () => {
    const a = [{ op: 'replace', path: '/fields/titre/path', value: '$.title' }] as const;
    expect(patchKey([...a])).toBe(patchKey([{ value: '$.title', path: '/fields/titre/path', op: 'replace' }]));
    expect(patchKey([...a])).not.toBe(patchKey([{ op: 'replace', path: '/fields/titre/path', value: '$.name' }]));
  });

  it('test puis remplacement', () => {
    const r = validateRepairPatch(base(), [
      { op: 'test', path: '/fields/titre/path', value: '$.subject' },
      { op: 'replace', path: '/fields/titre/path', value: '$.name' },
    ]);
    expect(r.ok).toBe(true);
    const failed = validateRepairPatch(base(), [
      { op: 'test', path: '/fields/titre/path', value: '$.autre' },
      { op: 'replace', path: '/fields/titre/path', value: '$.name' },
    ]);
    expect(codes(failed)).toEqual(['patch_not_applicable']);
  });
});

describe('patch de réparation : le résultat est revalidé en entier', () => {
  it('assouplir le schéma en retirant un champ requis est rejeté (output_schema inchangé)', () => {
    const r = validateRepairPatch(base(), [{ op: 'remove', path: '/fields/prix' }], { outputSchema: OUTPUT_SCHEMA });
    expect(r).toMatchObject({ ok: false, rejections: [{ code: 'patched_spec_invalid' }] });
    if (!r.ok) expect(r.rejections[0]?.issues?.some((i) => i.code === 'required_not_covered')).toBe(true);
  });

  it('JSONPath hors RFC 9535, opérateur inconnu, expression libre : rejetés', () => {
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '/fields/titre/path', value: '$.a[(@.length-1)]' }]))).toEqual(['patched_spec_invalid']);
    expect(codes(validateRepairPatch(base(), [{ op: 'add', path: '/fields/titre/ops/-', value: 'x => x.trim()' }]))).toEqual(['patched_spec_invalid']);
    expect(codes(validateRepairPatch(base(), [{ op: 'add', path: '/fields/titre/ops/-', value: { op: 'eval', code: '1' } }]))).toEqual(['patched_spec_invalid']);
  });

  it('retirer toutes les sources, pagination sans arrêt, champ sans chemin : rejetés', () => {
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '/sources', value: [] }]))).toEqual(['patched_spec_invalid']);
    expect(codes(validateRepairPatch(base(), [{ op: 'remove', path: '/pagination/stop' }]))).toEqual(['patched_spec_invalid']);
    expect(codes(validateRepairPatch(base(), [{ op: 'remove', path: '/fields/titre/path' }]))).toEqual(['patched_spec_invalid']);
  });

  it('une source ne peut pas pointer hors allowed_hosts par un champ d\'URL : les URL ne sont pas patchables', () => {
    expect(codes(validateRepairPatch(base(), [{ op: 'add', path: '/sources/0/url', value: 'https://evil.test/' }]))).toEqual(['patched_spec_invalid']);
  });

  it('patch sans effet : rejeté', () => {
    expect(codes(validateRepairPatch(base(), [{ op: 'replace', path: '/fields/titre/path', value: '$.subject' }]))).toEqual(['noop_patch']);
  });

  it('opération impossible (chemin inexistant) : rejet propre, pas d\'exception', () => {
    expect(codes(validateRepairPatch(base(), [{ op: 'remove', path: '/fields/inconnu/path' }]))).toEqual(['patch_not_applicable']);
  });
});
