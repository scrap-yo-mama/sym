// SPDX-License-Identifier: AGPL-3.0-only
// Interpréteur déclaratif : opérateurs fermés, motifs bornés, limites, blobs, validation à l'enregistrement, gabarits.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { decodeFlatData, resolveApolloRefs } from './blobs.js';
import { DslError } from './errors.js';
import { extractRecords } from './extract.js';
import { DEFAULT_DSL_LIMITS, resolveLimits } from './limits.js';
import { applyOperators, compileOperators, OPERATOR_NAMES } from './operators.js';
import { advancePagination, startPagination } from './pagination.js';
import { assertBoundedRegex, compileBoundedRegex, regexExtract } from './regex.js';
import { renderRequest, type TemplateContext } from './template.js';
import { validateDeclarativeSpec, type DeclarativeSpec } from './spec.js';

const run = (ops: unknown[], value: unknown): unknown => applyOperators(compileOperators(ops), value);
const throwsCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DslError);
    expect((e as DslError).code).toBe(code);
    return;
  }
  throw new Error(`aucune erreur levée (attendu ${code})`);
};

describe('opérateurs : liste fermée', () => {
  it('la liste est exactement celle de 04b § 2', () => {
    expect([...OPERATOR_NAMES]).toEqual(['trim', 'lower', 'upper', 'collapse_spaces', 'to_number', 'to_integer', 'to_boolean', 'parse_date', 'abs_url', 'regex_extract', 'default', 'map_value', 'join', 'first', 'count']);
  });

  it('nettoyage de texte', () => {
    expect(run(['trim', 'lower'], '  AbC ')).toBe('abc');
    expect(run(['upper'], 'abc')).toBe('ABC');
    expect(run(['collapse_spaces'], ' a \n\t b  c ')).toBe('a b c');
  });

  it('conversions, avec refus si non convertible', () => {
    expect(run(['to_number'], '1,234.50')).toBe(1234.5);
    expect(run([{ op: 'to_number', decimal: ',' }], '1 234,50 €')).toBe(1234.5);
    expect(run(['to_integer'], '42')).toBe(42);
    throwsCode(() => run(['to_integer'], '4.2'), 'operator_failed');
    throwsCode(() => run(['to_number'], 'abc'), 'operator_failed');
    throwsCode(() => run(['to_number'], '1e999'), 'operator_failed');
    expect(run(['to_boolean'], 'Oui')).toBe(true);
    expect(run(['to_boolean'], 'false')).toBe(false);
    throwsCode(() => run(['to_boolean'], 'peut-être'), 'operator_failed');
  });

  it('dates normalisées ISO 8601', () => {
    expect(run([{ op: 'parse_date', format: 'dmy' }], '31/12/2025')).toBe('2025-12-31');
    expect(run([{ op: 'parse_date', format: 'mdy' }], '12/31/2025')).toBe('2025-12-31');
    expect(run(['parse_date'], '2026-02-03')).toBe('2026-02-03');
    expect(run(['parse_date'], '2026-02-03T10:00:00+02:00')).toBe('2026-02-03T08:00:00.000Z');
    expect(run([{ op: 'parse_date', format: 'epoch_s' }], 1_767_225_600)).toBe('2026-01-01T00:00:00.000Z');
    throwsCode(() => run([{ op: 'parse_date', format: 'dmy' }], '31/02/2025'), 'operator_failed');
    throwsCode(() => run(['parse_date'], 'hier'), 'operator_failed');
  });

  it('URL absolue : http et https seulement', () => {
    expect(run([{ op: 'abs_url', base: 'https://www.exemple.test/a/' }], '../p?x=1')).toBe('https://www.exemple.test/p?x=1');
    throwsCode(() => run([{ op: 'abs_url', base: 'https://www.exemple.test/' }], 'javascript:alert(1)'), 'operator_failed');
    throwsCode(() => compileOperators([{ op: 'abs_url', base: 'javascript:alert(1)' }]), 'invalid_spec');
    throwsCode(() => compileOperators([{ op: 'abs_url' }]), 'invalid_spec');
  });

  it('default, map_value, join, first, count', () => {
    expect(run([{ op: 'default', value: 'n/a' }], undefined)).toBe('n/a');
    expect(run([{ op: 'default', value: 'n/a' }], '')).toBe('n/a');
    expect(run([{ op: 'default', value: 'n/a' }], 'x')).toBe('x');
    expect(run([{ op: 'map_value', table: { in: true, out: false } }], 'in')).toBe(true);
    expect(run([{ op: 'map_value', table: { a: 1 }, default: 0 }], 'z')).toBe(0);
    throwsCode(() => run([{ op: 'map_value', table: { a: 1 } }], 'z'), 'operator_failed');
    throwsCode(() => run([{ op: 'map_value', table: { a: 1 } }], '__proto__'), 'operator_failed');
    expect(run([{ op: 'join', separator: ', ' }], ['a', 'b', 3])).toBe('a, b, 3');
    expect(run(['first'], ['x', 'y'])).toBe('x');
    expect(run(['count'], [1, 2, 3])).toBe(3);
    expect(run(['count'], undefined)).toBe(0);
    expect(run(['trim'], [' a ', ' b '])).toEqual(['a', 'b']);
  });

  it('regex_extract : I-Regexp, groupe', () => {
    expect(run([{ op: 'regex_extract', pattern: '[0-9]+' }], 'réf 4512 bis')).toBe('4512');
    expect(run([{ op: 'regex_extract', pattern: 'id-([0-9]+)', group: 1 }], 'id-77')).toBe('77');
    throwsCode(() => run([{ op: 'regex_extract', pattern: '[0-9]+' }], 'rien'), 'operator_failed');
  });

  it('refuse tout ce qui n\'est pas un opérateur nommé de la liste', () => {
    throwsCode(() => compileOperators(['x => x.trim()']), 'unknown_operator');
    throwsCode(() => compileOperators(['eval']), 'unknown_operator');
    throwsCode(() => compileOperators([{ op: 'constructor' }]), 'unknown_operator');
    throwsCode(() => compileOperators([{ op: 'trim', code: '1' }]), 'invalid_spec');
    throwsCode(() => compileOperators([42]), 'unknown_operator');
    throwsCode(() => compileOperators(Array.from({ length: 17 }, () => 'trim')), 'invalid_spec');
  });
});

describe('motifs I-Regexp bornés', () => {
  it('accepte les motifs ordinaires', () => {
    for (const p of ['a.*b', '[a-z0-9_-]+', '\\p{Lu}+', '(ab|cd)?x{2,5}', '[^\\]\\\\]', '\\(x\\)', 'é+', '^a$']) expect(() => assertBoundedRegex(p), p).not.toThrow();
  });

  it('`.` exclut les retours à la ligne, `^` et `$` sont des caractères', () => {
    expect(compileBoundedRegex('a.b').re.test('a\nb')).toBe(false);
    expect(compileBoundedRegex('a.b').re.test('axb')).toBe(true);
    expect(compileBoundedRegex('^a').re.test('^a')).toBe(true);
    expect(compileBoundedRegex('^a').re.test('a')).toBe(false);
  });

  it('refuse ce qui n\'est pas I-Regexp (retours arrière, assertions, groupes nommés)', () => {
    for (const p of ['(?=a)', '(?:a)', '\\1', '\\d', '\\w+', '(?<n>a)', 'a{', 'a{2,1}', '[z-a]', '[abc', '(a', 'a)', '\\p{Foo}', '*a', '']) {
      if (p === '') continue; // motif vide : valide (I-Regexp)
      expect(() => assertBoundedRegex(p), p).toThrow(DslError);
    }
  });

  it('refuse le retour arrière catastrophique et les motifs démesurés', () => {
    for (const p of ['(a+)+$', '(a*)*', '(a|a)*', '(a|aa)+', '(a+)*b', '((a+)b)*', 'a*a*a*', 'a{1000}', 'a{1,101}', 'x'.repeat(257)]) {
      throwsCode(() => assertBoundedRegex(p), 'regex_not_bounded');
    }
  });

  it('un motif adverse résiduel reste rapide sur le texte maximal', () => {
    const t0 = performance.now();
    expect(regexExtract(`${'a'.repeat(4_000)}b`, 'a*c', 0)).toBeUndefined(); // un quantificateur non borné : 4 096 caractères
    expect(regexExtract(`${'a'.repeat(270)}b`, 'a*a*c', 0)).toBeUndefined(); // deux : 271 caractères
    expect(performance.now() - t0).toBeLessThan(1000);
    throwsCode(() => regexExtract(`${'a'.repeat(4_000)}b`, 'a*a*c', 0), 'value_too_large');
    throwsCode(() => regexExtract('a'.repeat(5_000), 'a', 0), 'value_too_large');
  });
});

const baseSpec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: 'https://api.exemple.test/items', allowed_hosts: ['api.exemple.test'] },
  sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
  fields: { titre: { path: '$.t', type: 'string', required: true } },
  ...over,
});

describe('validation à l\'enregistrement', () => {
  const errors = (raw: unknown, schema?: unknown): string[] => {
    const r = validateDeclarativeSpec(raw, schema === undefined ? {} : { outputSchema: schema });
    return r.ok ? [] : r.errors.map((e) => e.code);
  };

  it('accepte le document de référence', () => {
    expect(validateDeclarativeSpec(baseSpec()).ok).toBe(true);
  });

  it('JSON Schema : propriétés inconnues, version, genre', () => {
    expect(errors(baseSpec({ extra: 1 }))).toContain('schema_additionalProperties');
    expect(errors(baseSpec({ schema_version: 2 }))).toContain('schema_const');
    expect(errors(baseSpec({ kind: 'script' }))).toContain('schema_const');
    expect(errors('nope')).toContain('schema_type');
  });

  it('JSONPath : rejet hors RFC 9535 (expressions de script, syntaxe jsonpath-plus)', () => {
    for (const path of ['$.a[(@.length-1)]', '$..[?(@.price < 10 && require("fs"))]', '$.a.b..', '$[?@.a == ]', 'items', '$.a[?@.b=~/x/]']) {
      expect(errors(baseSpec({ fields: { titre: { path, type: 'string' } } })), path).toContain('invalid_jsonpath');
    }
    expect(errors(baseSpec({ sources: [{ id: 'api', from: 'response', records: '$..[?@.a ==]' }] }))).toContain('invalid_jsonpath');
    expect(errors(baseSpec({ sources: [{ id: 'api', from: 'response', records: '$..[?(@.a)]' }] }))).toEqual([]); // filtre parenthésé : valide (RFC 9535)
  });

  it('sélecteur CSS invalide ou non pris en charge', () => {
    const html = (css: string): unknown => baseSpec({ sources: [{ id: 'd', from: 'html', records: 'article' }], fields: { titre: { css, type: 'string' } } });
    expect(errors(html('div >> a'))).toContain('invalid_css');
    expect(errors(html('a:frobnicate'))).toContain('invalid_css');
    expect(errors(html('a'.repeat(400)))).toContain('schema_maxLength');
    expect(errors(html(Array.from({ length: 13 }, () => 'a').join(' > ')))).toContain('invalid_css');
    expect(errors(html('h2.title'))).toEqual([]);
  });

  it('XPath non pris en charge (écart documenté)', () => {
    expect(errors(baseSpec({ fields: { titre: { path: '$.t', xpath: '//h1', type: 'string' } } }))).toContain('unsupported');
  });

  it('allowed_hosts : URL hors liste, hôte en gabarit, identifiants dans l\'URL, secret constant', () => {
    const req = (url: string, extra: Record<string, unknown> = {}): unknown => baseSpec({ request: { method: 'GET', url, allowed_hosts: ['api.exemple.test'], ...extra } });
    expect(errors(req('https://evil.test/x'))).toContain('host_not_allowed');
    expect(errors(req('https://{{input.host}}/x'))).toContain('host_not_static');
    expect(errors(req('https://api.exemple.test@evil.test/x'))).toContain('host_not_allowed');
    expect(errors(req('https://u:p@api.exemple.test/x'))).toContain('secret_in_spec');
    expect(errors(req('https://api.exemple.test/x?api_key=abc123'))).toContain('secret_in_spec');
    expect(errors(req('https://api.exemple.test/x?api_key={{input.key}}'))).toEqual([]);
    expect(errors(req('https://api.exemple.test/x', { allowed_hosts: ['*.exemple.test'] }))).toContain('schema_pattern');
    expect(errors(req('https://api.exemple.test/x', { allowed_hosts: ['api.exemple.test/x'] }))).toContain('schema_pattern');
    expect(errors(req('ftp://api.exemple.test/x'))).toContain('schema_pattern');
  });

  it('aucun secret : en-têtes Authorization, Cookie interdits', () => {
    const h = (headers: Record<string, string>): unknown => baseSpec({ request: { method: 'GET', url: 'https://api.exemple.test/x', allowed_hosts: ['api.exemple.test'], headers } });
    expect(errors(h({ Authorization: 'Bearer abc' }))).toContain('secret_in_spec');
    expect(errors(h({ cookie: 'a=b' }))).toContain('secret_in_spec');
    expect(errors(h({ accept: 'application/json' }))).toEqual([]);
  });

  it('gabarits : seules les formes input.x, page.x, steps.id.nom', () => {
    const b = (json: unknown): unknown => baseSpec({ request: { method: 'POST', url: 'https://api.exemple.test/x', allowed_hosts: ['api.exemple.test'], body: { json } } });
    expect(errors(b({ q: '{{input.q}}', o: '{{page.offset}}' }))).toEqual([]);
    expect(errors(b({ q: '{{ process.env.SECRET }}' }))).toContain('invalid_template');
    expect(errors(b({ q: '{{input.a.b}}' }))).toContain('invalid_template');
    expect(errors(b({ q: '{{steps.nope.x}}' }))).toContain('invalid_template');
    expect(errors(b({ q: '{{input.a' }))).toContain('invalid_template');
  });

  it('champs : un chemin par source, `required` de output_schema couverts', () => {
    expect(errors(baseSpec({ sources: [{ id: 'd', from: 'html', records: 'li' }] }))).toContain('field_missing_locator');
    const schema = { type: 'object', required: ['titre', 'prix'] };
    expect(errors(baseSpec(), schema)).toContain('required_not_covered');
    expect(errors(baseSpec({ fields: { titre: { path: '$.t', type: 'string' }, prix: { path: '$.p', type: 'number' } } }), schema)).toEqual([]);
  });

  it('pagination : stop[] et hard_max_pages obligatoires, param déclaré', () => {
    const p = (pagination: unknown): unknown => baseSpec({ pagination, request: { method: 'GET', url: 'https://api.exemple.test/x', allowed_hosts: ['api.exemple.test'], params: [{ at: 'url.query.page', role: 'pagination' }] } });
    expect(errors(p({ type: 'page_param', param: 'url.query.page' }))).toEqual(expect.arrayContaining(['stop_required', 'hard_max_pages_required']));
    expect(errors(p({ type: 'page_param', param: 'url.query.page', stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 10 } }))).toEqual([]);
    expect(errors(p({ type: 'page_param', param: 'url.query.autre', stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 10 } }))).toContain('param_not_declared');
    expect(errors(p({ type: 'none' }))).toEqual([]);
    expect(errors(p({ type: 'cursor', param: 'url.query.page', stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 1500 } }))).toContain('schema_maximum');
  });
});

describe('limites : taille, profondeur, items, temps', () => {
  const spec = (over: Record<string, unknown> = {}): DeclarativeSpec => {
    const r = validateDeclarativeSpec(baseSpec(over));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.spec;
  };

  it('réponse trop grande : refus avant toute analyse', () => {
    throwsCode(() => extractRecords(spec({ limits: { max_response_bytes: 100 } }), { body: `{"items":[${'{"t":"x"},'.repeat(50)}{"t":"y"}]}` }), 'response_too_large');
  });

  it('profondeur JSON : refus', () => {
    const deep = `{"items":[{"t":"x","d":${'['.repeat(40)}${']'.repeat(40)}}]}`;
    const out = extractRecords(spec({ limits: { max_depth: 32 } }), { body: deep });
    expect(out.ok).toBe(false);
    expect(out.attempts[0]?.problems[0]?.code).toBe('depth_exceeded');
    expect(extractRecords(spec({ limits: { max_depth: 64 } }), { body: deep }).ok).toBe(true);
  });

  it('profondeur HTML : refus', () => {
    const s = spec({ sources: [{ id: 'd', from: 'html', records: 'div' }], fields: { titre: { attr: 'text', type: 'string' } } });
    const out = extractRecords(s, { body: '<div>'.repeat(300) });
    expect(out.ok).toBe(false);
    expect(out.attempts[0]?.problems[0]?.code).toBe('depth_exceeded');
  });

  it('nombre d\'items : refus au-delà du plafond', () => {
    const body = JSON.stringify({ items: Array.from({ length: 20 }, () => ({ t: 'x' })) });
    const out = extractRecords(spec(), { body }, { limits: { maxItems: 10 } });
    expect(out.ok).toBe(false);
    expect(out.attempts[0]?.problems[0]?.code).toBe('too_many_items');
    expect(extractRecords(spec(), { body }).records).toHaveLength(20);
  });

  it('longueur de tableau et de chaîne', () => {
    const body = JSON.stringify({ items: Array.from({ length: 30 }, () => ({ t: 'x' })) });
    expect(extractRecords(spec(), { body }, { limits: { maxArrayLength: 20 } }).attempts[0]?.problems[0]?.code).toBe('too_many_items');
    const long = JSON.stringify({ items: [{ t: 'x'.repeat(200) }] });
    expect(extractRecords(spec(), { body: long }, { limits: { maxStringLength: 100 } }).attempts[0]?.problems[0]?.code).toBe('value_too_large');
  });

  it('temps : échéance contrôlée, erreur timeout', () => {
    let t = 0;
    const body = JSON.stringify({ items: Array.from({ length: 50 }, () => ({ t: 'x' })) });
    throwsCode(() => extractRecords(spec({ limits: { timeout_ms: 1000 } }), { body }, { now: () => (t += 400) }), 'timeout');
  });

  it('les limites de la stratégie ne dépassent jamais les plafonds durs', () => {
    const l = resolveLimits({ max_response_bytes: 10 ** 12, max_depth: 10 ** 6, timeout_ms: 10 ** 9 });
    expect(l.maxResponseBytes).toBeLessThanOrEqual(20_000_000);
    expect(l.maxDepth).toBeLessThanOrEqual(64);
    expect(l.timeoutMs).toBeLessThanOrEqual(60_000);
    expect(resolveLimits(undefined, { maxItems: Number.NaN }).maxItems).toBe(DEFAULT_DSL_LIMITS.maxItems);
  });

  it('JSONPath adverse : chemin trop long, trop de `..`, filtre imbriqué borné', () => {
    const s = (records: string): unknown => baseSpec({ sources: [{ id: 'api', from: 'response', records }] });
    expect(validateDeclarativeSpec(s(`$${'.a'.repeat(600)}`)).ok).toBe(false);
    expect(validateDeclarativeSpec(s('$' + '..a'.repeat(7))).ok).toBe(false);
    expect(validateDeclarativeSpec(s('$' + '[?@'.repeat(7) + ']'.repeat(7))).ok).toBe(false);
  });

  it('une expression match() hostile dans un filtre est refusée à l\'exécution', () => {
    const s = spec({ sources: [{ id: 'api', from: 'response', records: "$.items[?match(@.t, '(a+)+$')]" }] });
    const out = extractRecords(s, { body: JSON.stringify({ items: [{ t: `${'a'.repeat(30)}!` }] }) });
    expect(out.ok).toBe(false);
    expect(out.attempts[0]?.problems[0]?.code).toBe('regex_not_bounded');
  });
});

describe('blobs : décodeurs', () => {
  const L = DEFAULT_DSL_LIMITS;
  it('Nuxt à plat : valeurs spéciales, Reactive, Set, Date', () => {
    const flat = [{ a: 1, b: 2, c: 3, d: 4, e: 5 }, 'x', [-1, 1], ['Reactive', 6], ['Set', 1], ['Date', '2026-01-01T00:00:00.000Z'], { k: 1 }];
    const out = decodeFlatData(flat, L) as Record<string, unknown>;
    expect(out['a']).toBe('x');
    expect(out['b']).toEqual([null, 'x']);
    expect(out['c']).toEqual({ k: 'x' });
    expect(out['d']).toEqual(['x']);
    expect(out['e']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('Nuxt : cycle, indice hors tableau, bombe d\'expansion', () => {
    throwsCode(() => decodeFlatData([{ a: 1 }, { b: 0 }], L), 'invalid_blob');
    throwsCode(() => decodeFlatData([{ a: 9 }], L), 'invalid_blob');
    const bomb: unknown[] = [];
    for (let i = 0; i < 40; i += 1) bomb.push([i + 1, i + 1]);
    bomb.push('feuille');
    throwsCode(() => decodeFlatData(bomb, { ...L, maxDepth: 64 }), 'too_many_nodes');
    throwsCode(() => decodeFlatData([['Inconnu', 1], 1], L), 'invalid_blob');
  });

  it('Apollo : références résolues, cycles conservés, bombe bornée', () => {
    const state = { ROOT_QUERY: { items: [{ __ref: 'P:1' }, { __ref: 'P:2' }] }, 'P:1': { id: 1, next: { __ref: 'P:2' } }, 'P:2': { id: 2, prev: { __ref: 'P:1' } } };
    const out = resolveApolloRefs(state, L) as { ROOT_QUERY: { items: { id: number; next?: { id: number } }[] } };
    expect(out.ROOT_QUERY.items[0]?.next?.id).toBe(2);
    const bomb: Record<string, unknown> = { ROOT_QUERY: { a: { __ref: 'N:0' } } };
    for (let i = 0; i < 40; i += 1) bomb[`N:${i}`] = { x: { __ref: `N:${i + 1}` }, y: { __ref: `N:${i + 1}` } };
    bomb['N:40'] = { leaf: true };
    throwsCode(() => resolveApolloRefs(bomb, { ...L, maxDepth: 64 }), 'too_many_nodes');
  });

  it('balise non JSON (script exécutable) : aucune exécution, erreur propre', () => {
    const spec = validateDeclarativeSpec(baseSpec({ sources: [{ id: 's', from: 'embedded', locator: { kind: 'apollo_state' }, records: '$.a[*]' }] }));
    if (!spec.ok) throw new Error('spec');
    const page = '<script>window.__APOLLO_STATE__=(function(){globalThis.PWNED=1;return {a:[1]}})()</script>';
    const out = extractRecords(spec.spec, { body: page });
    expect(out.ok).toBe(false);
    expect(out.attempts[0]?.problems[0]?.code).toBe('invalid_blob');
    expect((globalThis as Record<string, unknown>)['PWNED']).toBeUndefined();
  });
});

describe('gabarits de requête', () => {
  const ctx: TemplateContext = { input: { query: 'a b&c', n: 5 }, page: { offset: 40 }, steps: { s1: { uid: 'u/1' } } };
  it('rend corps JSON (types conservés), URL (encodée) et en-têtes', () => {
    const r = renderRequest(
      { method: 'POST', url: 'https://api.exemple.test/s?q={{input.query}}&u={{steps.s1.uid}}', headers: { 'x-a': '{{input.n}}' }, body: { json: { o: '{{page.offset}}', q: 'x-{{input.query}}' } } },
      ['api.exemple.test'],
      ctx,
    );
    expect(r.url).toBe('https://api.exemple.test/s?q=a%20b%26c&u=u%2F1');
    expect(r.headers).toEqual({ 'x-a': '5' });
    expect(r.body).toEqual({ kind: 'json', value: { o: 40, q: 'x-a b&c' } });
  });

  it('valeur absente, hôte hors liste, injection d\'en-tête : refus', () => {
    const ok = { method: 'GET' as const, url: 'https://api.exemple.test/s' };
    throwsCode(() => renderRequest({ ...ok, url: 'https://api.exemple.test/{{input.zzz}}' }, ['api.exemple.test'], ctx), 'invalid_template');
    throwsCode(() => renderRequest(ok, ['autre.test'], ctx), 'host_not_allowed');
    throwsCode(() => renderRequest({ ...ok, headers: { a: '{{input.query}}' } }, ['api.exemple.test'], { ...ctx, input: { query: 'x\r\nSet-Cookie: a' } }), 'invalid_template');
    // une valeur ne peut pas changer l'hôte : elle est encodée dans le chemin ou la requête
    const r = renderRequest({ ...ok, url: 'https://api.exemple.test/{{input.query}}' }, ['api.exemple.test'], { ...ctx, input: { query: '@evil.test/x' } });
    expect(new URL(r.url).hostname).toBe('api.exemple.test');
  });
});

describe('pagination : arrêt certain', () => {
  const p = validateDeclarativeSpec(baseSpec({
    request: { method: 'GET', url: 'https://api.exemple.test/x', allowed_hosts: ['api.exemple.test'], params: [{ at: 'url.query.c', role: 'pagination' }] },
    pagination: { type: 'cursor', param: 'url.query.c', next_path: '$.next', stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 3 } },
  }));
  it('curseur répété : arrêt même sans règle explicite ; hard_max_pages ; max_pages_input', () => {
    if (!p.ok) throw new Error('spec');
    const limits = { limits: DEFAULT_DSL_LIMITS };
    const st = startPagination();
    expect(advancePagination(p.spec.pagination, st, { records: 2, document: { next: 'A' } }, limits)).toMatchObject({ done: false });
    expect(advancePagination(p.spec.pagination, st, { records: 2, document: { next: 'A' } }, limits)).toEqual({ done: true, reason: 'repeated_cursor' });
    const st2 = startPagination();
    advancePagination(p.spec.pagination, st2, { records: 1, document: { next: 'A' } }, limits);
    advancePagination(p.spec.pagination, st2, { records: 1, document: { next: 'B' } }, limits);
    expect(advancePagination(p.spec.pagination, st2, { records: 1, document: { next: 'C' } }, limits)).toEqual({ done: true, reason: 'hard_max_pages' });
    const st3 = startPagination();
    expect(advancePagination(p.spec.pagination, st3, { records: 1, document: { next: 'A' } }, limits, 1)).toEqual({ done: true, reason: 'max_pages_input' });
  });
});

describe('aucun eval, aucun Function, aucune regex utilisateur non bornée', () => {
  const require_ = createRequire(import.meta.url);
  const forbidden = /(^|[^\w.$])eval\s*\(|new\s+Function\s*\(|(^|[^\w.$])Function\s*\(\s*['"`]|require\(['"]vm['"]\)|from\s+['"](node:)?vm['"]|from\s+['"](node:)?child_process['"]/;

  it('le code de src/dsl ne contient ni eval, ni Function, ni vm', () => {
    const dir = new URL('./', import.meta.url);
    for (const file of ['blobs', 'css', 'errors', 'extract', 'fingerprint', 'jsonpath', 'limits', 'operators', 'pagination', 'patch', 'regex', 'spec', 'template']) {
      const src = readFileSync(new URL(`${file}.ts`, dir), 'utf8').replace(/\/\/.*$/gm, '');
      expect(forbidden.test(src), file).toBe(false);
    }
  });

  it('les bibliothèques installées et leurs dépendances n\x27évaluent pas de code', () => {
    const roots = [require_.resolve('json-p3/dist/json-p3.esm.js'), require_.resolve('css-select'), require_.resolve('htmlparser2')];
    const dirs = new Set<string>();
    const visit = (packageDir: string, depth: number): void => {
      if (dirs.has(packageDir) || depth > 4) return;
      dirs.add(packageDir);
      const pkg = JSON.parse(readFileSync(`${packageDir}/package.json`, 'utf8')) as { dependencies?: Record<string, string> };
      for (const dep of Object.keys(pkg.dependencies ?? {})) visit(packageDirOf(packageDir, dep), depth + 1);
    };
    for (const file of roots) visit(packageRoot(file), 0);
    expect([...dirs].map((d) => d.split('/node_modules/').pop())).toEqual(expect.arrayContaining(['json-p3', 'css-select', 'htmlparser2', 'css-what', 'nth-check', 'domutils', 'domhandler', 'entities']));
    for (const dir of dirs) {
      const files = collect(dir);
      expect(files.length, dir).toBeGreaterThan(0);
      for (const f of files) expect(forbidden.test(readFileSync(f, 'utf8')), f).toBe(false);
    }
  });
});

function collect(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.endsWith('.min.js') || name.includes('browser') || name.includes('iife') || name.includes('cjs')) continue;
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) collect(full, out, depth + 1);
    else if (/\.(js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/** Dossier racine du paquet qui contient `file`. */
function packageRoot(file: string): string {
  let dir = realpathSync(file).replace(/\/[^/]+$/, '');
  while (!existsSync(`${dir}/package.json`)) dir = dir.replace(/\/[^/]+$/, '');
  return dir;
}

/** Dossier du paquet `dep` tel que le voit le paquet `fromDir` (disposition pnpm : dossiers frères dans node_modules). */
function packageDirOf(fromDir: string, dep: string): string {
  let dir = fromDir;
  for (;;) {
    const candidate = `${dir}/node_modules/${dep}`;
    if (existsSync(`${candidate}/package.json`)) return realpathSync(candidate);
    const sibling = `${dir.replace(/\/[^/]+$/, '')}/${dep}`;
    if (existsSync(`${sibling}/package.json`)) return realpathSync(sibling);
    const up = dir.replace(/\/[^/]+$/, '');
    if (up === dir || up === '') throw new Error(`dépendance introuvable : ${dep}`);
    dir = up;
  }
}
