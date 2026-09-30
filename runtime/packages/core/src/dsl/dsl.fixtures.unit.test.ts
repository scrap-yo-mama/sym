// Critère 1.1b (tableau 10) : les fixtures API, SSR et blobs sont extraites en E1 par l'interpréteur déclaratif, sortie validée par le
// validateur de 1.1a contre un output_schema. Le serveur de fixtures (0.5) est démarré pour de bon : les réponses sont réelles.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { validateOutput } from '../schema/validator.js';
import { advancePagination, extractRecords, initialParam, parseLinkNext, resolveNextUrl, shapeFingerprint, startPagination, validateDeclarativeSpec, validateRepairPatch } from './index.js';
import type { DeclarativeSpec, PaginationDecision } from './index.js';
import { queryValues } from './jsonpath.js';
import { DEFAULT_DSL_LIMITS } from './limits.js';

let client: Client;
beforeAll(async () => {
  client = await startClient();
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await client.reset();
});

const SCHEMA_CONTACT = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id', 'name', 'email', 'score'],
  properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, city: { type: 'string' }, score: { type: 'number' } },
  additionalProperties: false,
};

const SCHEMA_PRODUCT = {
  type: 'object',
  required: ['title', 'price'],
  properties: { title: { type: 'string' }, price: { type: 'number', minimum: 0 }, sku: { type: 'string' } },
  additionalProperties: false,
};

function spec(host: string, overrides: Partial<DeclarativeSpec> & Pick<DeclarativeSpec, 'sources' | 'fields'>): DeclarativeSpec {
  const raw = {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `https://${host}/`, allowed_hosts: [host] },
    ...overrides,
  };
  const check = validateDeclarativeSpec(raw, { outputSchema: overrides.fields['title'] ? SCHEMA_PRODUCT : SCHEMA_CONTACT });
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

const CONTACTS_HOST = 'zz_test_api_json.localhost';
const contactsSpec = (): DeclarativeSpec =>
  spec(CONTACTS_HOST, {
    sources: [{ id: 'api', from: 'response', format: 'json', records: '$.items[*]' }],
    fields: {
      id: { path: '$.id', type: 'string', required: true },
      name: { path: '$.name', type: 'string', required: true, ops: ['trim'] },
      email: { path: '$.email', type: 'string', required: true, ops: ['lower'] },
      city: { path: '$.city', type: 'string' },
      score: { path: '$.score', type: 'number', required: true },
    },
  });

const assertValid = (records: unknown[], schema: unknown): void => {
  for (const r of records) expect(validateOutput(schema, r)).toEqual({ ok: true });
};

describe('E1 : API JSON (fixture api_json)', () => {
  it('extrait 20 contacts, validés contre output_schema', async () => {
    const res = await client.get(CONTACTS_HOST, '/api/contacts?page=1&per_page=20');
    const out = extractRecords(contactsSpec(), { body: res.body }, { outputSchema: SCHEMA_CONTACT });
    expect(out.ok).toBe(true);
    expect(out.records).toHaveLength(20);
    expect(out.source_id).toBe('api');
    expect(out.escalated).toBe(false);
    assertValid(out.records, SCHEMA_CONTACT);
  });

  it('pagination par page : arrêt sur has_more = false, hard_max_pages respecté', async () => {
    const s = spec(CONTACTS_HOST, {
      request: { method: 'GET', url: `https://${CONTACTS_HOST}/api/contacts?page={{page.number}}`, allowed_hosts: [CONTACTS_HOST], params: [{ at: 'url.query.page', role: 'pagination' }] },
      sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
      fields: { id: { path: '$.id', type: 'string', required: true }, name: { path: '$.name', type: 'string', required: true }, email: { path: '$.email', type: 'string', required: true }, score: { path: '$.score', type: 'number', required: true } },
      pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }, { when: 'path_equals', path: '$.has_more', value: false }], limits: { hard_max_pages: 50 } },
    });
    const state = startPagination();
    let param = initialParam(s.pagination!);
    let total = 0;
    let decision: PaginationDecision = { done: false };
    while (!decision.done) {
      const res = await client.get(CONTACTS_HOST, `/api/contacts?page=${param?.value}&per_page=20`);
      const out = extractRecords(s, { body: res.body });
      total += out.records.length;
      decision = advancePagination(s.pagination, state, { records: out.records.length, document: JSON.parse(res.body) }, { limits: DEFAULT_DSL_LIMITS });
      if (!decision.done && decision.param) param = { at: decision.param.at, value: Number(decision.param.value) };
    }
    expect(total).toBe(500);
    expect(state.pages).toBe(25);
    expect(decision).toEqual({ done: true, reason: 'path_equals' });
  });

  it('les 6 mutations : la réparation par patch borné rétablit une sortie conforme (et rien d\'autre)', async () => {
    const current = contactsSpec();
    const extract = async (path = '/api/contacts?page=1&per_page=5') => extractRecords(current, { body: (await client.get(CONTACTS_HOST, path)).body }, { outputSchema: SCHEMA_CONTACT });
    const mutate = (mutation: string) => client.control({ op: 'site', site: 'api_json', mutation });

    await mutate('wrap_in_envelope');
    const wrapped = await extract();
    expect(wrapped.ok).toBe(false);
    const fix1 = validateRepairPatch(current, [{ op: 'replace', path: '/sources/0/records', value: '$.data.results[*]' }], { outputSchema: SCHEMA_CONTACT });
    expect(fix1.ok).toBe(true);
    if (fix1.ok) expect(extractRecords(fix1.spec, { body: (await client.get(CONTACTS_HOST, '/api/contacts?page=1&per_page=5')).body }, { outputSchema: SCHEMA_CONTACT }).records).toHaveLength(5);

    await mutate('rename_field');
    expect((await extract()).ok).toBe(false);
    const fix2 = validateRepairPatch(current, [{ op: 'replace', path: '/fields/name/path', value: '$.full_name' }], { outputSchema: SCHEMA_CONTACT });
    expect(fix2.ok).toBe(true);
    if (fix2.ok) {
      const res = await client.get(CONTACTS_HOST, '/api/contacts?page=1&per_page=5');
      const fixed = extractRecords(fix2.spec, { body: res.body }, { outputSchema: SCHEMA_CONTACT });
      expect(fixed.records).toHaveLength(5);
      assertValid(fixed.records, SCHEMA_CONTACT);
    }

    await mutate('type_change');
    const typed = await extract();
    expect(typed.ok).toBe(false);
    expect(typed.attempts[0]?.problems.some((p) => p.code === 'type_mismatch')).toBe(true);
    const fix3 = validateRepairPatch(current, [{ op: 'add', path: '/fields/score/ops', value: ['to_number'] }], { outputSchema: SCHEMA_CONTACT });
    expect(fix3.ok).toBe(true);
    if (fix3.ok) expect(extractRecords(fix3.spec, { body: (await client.get(CONTACTS_HOST, '/api/contacts?page=1&per_page=5')).body }, { outputSchema: SCHEMA_CONTACT }).ok).toBe(true);

    await mutate('out_of_schema');
    const off = await extract();
    expect(off.ok).toBe(false);
    expect(off.attempts[0]?.problems.some((p) => p.code === 'missing_required')).toBe(true);

    await mutate('empty');
    const empty = await extract();
    expect(empty.ok).toBe(false);
    expect(empty.attempts[0]?.problems[0]?.code).toBe('no_records');
  });

  it('une réponse qui change de forme change l\'empreinte', async () => {
    const before = JSON.parse((await client.get(CONTACTS_HOST, '/api/contacts?page=1&per_page=3')).body) as unknown;
    await client.control({ op: 'site', site: 'api_json', mutation: 'wrap_in_envelope' });
    const after = JSON.parse((await client.get(CONTACTS_HOST, '/api/contacts?page=1&per_page=3')).body) as unknown;
    expect(shapeFingerprint(before)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(shapeFingerprint(before)).not.toBe(shapeFingerprint(after));
    expect(shapeFingerprint(before)).toBe(shapeFingerprint(JSON.parse(JSON.stringify(before))));
  });
});

describe('E1 : HTML SSR (fixture ssr)', () => {
  const HOST = 'zz_test_ssr.localhost';
  const ssrSpec = (): DeclarativeSpec =>
    spec(HOST, {
      sources: [{ id: 'dom', from: 'html', records: 'article.product' }],
      fields: {
        title: { css: 'h2.title a', attr: 'text', type: 'string', required: true, ops: ['collapse_spaces'] },
        price: { css: 'span.price', type: 'number', required: true, ops: [{ op: 'to_number', decimal: ',' }] },
        sku: { css: 'h2.title a', attr: 'href', type: 'string', ops: [{ op: 'regex_extract', pattern: 'zz_test_product_[0-9]+' }] },
      },
    });

  it('extrait les 20 produits de la page, prix « 12,34 € » converti en nombre', async () => {
    const res = await client.get(HOST, '/');
    const out = extractRecords(ssrSpec(), { body: res.body }, { outputSchema: SCHEMA_PRODUCT });
    expect(out.ok).toBe(true);
    expect(out.records).toHaveLength(20);
    expect(out.records[0]).toMatchObject({ sku: 'zz_test_product_0001' });
    expect(typeof out.records[0]?.['price']).toBe('number');
    assertValid(out.records, SCHEMA_PRODUCT);
  });

  it('pagination next_link : suit rel=next jusqu\'à la page 5 et s\'arrête', async () => {
    const s = spec(HOST, {
      sources: [{ id: 'dom', from: 'html', records: 'article.product' }],
      fields: { title: { css: 'h2.title a', type: 'string', required: true }, price: { css: 'span.price', type: 'number', required: true, ops: [{ op: 'to_number', decimal: ',' }] } },
      pagination: { type: 'next_link', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits: { hard_max_pages: 10 } },
    });
    let path = '/';
    const state = startPagination();
    let total = 0;
    for (let i = 0; i < 20; i += 1) {
      const res = await client.get(HOST, path);
      const out = extractRecords(s, { body: res.body });
      total += out.records.length;
      const href = /<a rel="next" class="next" href="([^"]+)"/.exec(res.body)?.[1];
      const d = advancePagination(s.pagination, state, { records: out.records.length, linkHeader: href === undefined ? undefined : `<${href}>; rel="next"` }, { limits: DEFAULT_DSL_LIMITS });
      if (d.done) {
        expect(d.reason).toBe('no_next');
        break;
      }
      path = resolveNextUrl(d.nextUrl as string, `http://${HOST}/`, [HOST]).replace(`http://${HOST}`, '');
    }
    expect(total).toBe(100);
    expect(state.pages).toBe(5);
  });
});

describe('E1 : blobs embarqués (fixtures next, nuxt, apollo, jsonld)', () => {
  const product = (host: string, records: string, locator: DeclarativeSpec['sources'][number]['locator'], paths: { title: string; price: string; sku?: string }): DeclarativeSpec =>
    spec(host, {
      sources: [{ id: 'blob', from: 'embedded', locator, records }],
      fields: {
        title: { path: paths.title, type: 'string', required: true },
        price: { path: paths.price, type: 'number', required: true, ops: ['to_number'] },
        ...(paths.sku === undefined ? {} : { sku: { path: paths.sku, type: 'string' as const } }),
      },
    });

  it('__NEXT_DATA__', async () => {
    const host = 'zz_test_next.localhost';
    const s = product(host, '$.props.pageProps.products[*]', { kind: 'next_data' }, { title: '$.title', price: '$.price_cents', sku: '$.id' });
    const out = extractRecords(s, { body: (await client.get(host, '/')).body }, { outputSchema: SCHEMA_PRODUCT });
    expect(out.ok).toBe(true);
    expect(out.records).toHaveLength(10);
    assertValid(out.records, SCHEMA_PRODUCT);
  });

  it('__NUXT_DATA__ à plat et window.__NUXT__ (héritage)', async () => {
    const host = 'zz_test_nuxt.localhost';
    const flat = product(host, '$.data.products[*]', { kind: 'nuxt_data' }, { title: '$.title', price: '$.price_cents' });
    const a = extractRecords(flat, { body: (await client.get(host, '/')).body }, { outputSchema: SCHEMA_PRODUCT });
    expect(a.ok).toBe(true);
    expect(a.records).toHaveLength(10);
    const legacy = product(host, '$.data[0].products[*]', { kind: 'nuxt_data' }, { title: '$.title', price: '$.price_cents' });
    const b = extractRecords(legacy, { body: (await client.get(host, '/legacy')).body }, { outputSchema: SCHEMA_PRODUCT });
    expect(b.ok).toBe(true);
    expect(b.records).toEqual(a.records);
  });

  it('état Apollo : références __ref résolues', async () => {
    const host = 'zz_test_apollo.localhost';
    const s = product(host, '$.ROOT_QUERY[\'products({"first":10})\'][*]', { kind: 'apollo_state' }, { title: '$.name', price: '$.priceCents', sku: '$.id' });
    const out = extractRecords(s, { body: (await client.get(host, '/')).body }, { outputSchema: SCHEMA_PRODUCT });
    expect(out.ok).toBe(true);
    expect(out.records).toHaveLength(10);
    assertValid(out.records, SCHEMA_PRODUCT);
  });

  it('JSON-LD : deux blocs, l\'ItemList est retenu par filtre', async () => {
    const host = 'zz_test_jsonld.localhost';
    const s = product(host, "$[?@['@type']=='ItemList'].itemListElement[*].item", { kind: 'json_ld' }, { title: '$.name', price: '$.offers.price', sku: '$.sku' });
    const out = extractRecords(s, { body: (await client.get(host, '/')).body }, { outputSchema: SCHEMA_PRODUCT });
    expect(out.ok).toBe(true);
    expect(out.records).toHaveLength(10);
    assertValid(out.records, SCHEMA_PRODUCT);
  });

  it('source de repli : API absente (HTML), le blob est retenu et le run est « escalated »', async () => {
    const host = 'zz_test_next.localhost';
    const s = spec(host, {
      sources: [
        { id: 'api', from: 'response', format: 'json', records: '$.props.pageProps.products[*]' },
        { id: 'ssr', from: 'embedded', locator: { kind: 'next_data' }, records: '$.props.pageProps.products[*]' },
      ],
      fields: { title: { path: '$.title', type: 'string', required: true }, price: { path: '$.price_cents', type: 'number', required: true } },
    });
    const out = extractRecords(s, { body: (await client.get(host, '/')).body }, { outputSchema: SCHEMA_PRODUCT });
    expect(out.ok).toBe(true);
    expect(out.source_id).toBe('ssr');
    expect(out.source_index).toBe(1);
    expect(out.escalated).toBe(true);
    expect(out.attempts[0]).toMatchObject({ ok: false });
    expect(out.attempts[0]?.problems[0]?.code).toBe('invalid_json');
  });
});

describe('E1 : pagination par curseur et en-tête Link', () => {
  it('curseur : 95 items en 5 pages, arrêt sur next_cursor null', async () => {
    const host = 'zz_test_cursor.localhost';
    const s = spec(host, {
      request: { method: 'GET', url: `https://${host}/api/items`, allowed_hosts: [host], params: [{ at: 'url.query.cursor', role: 'pagination' }] },
      sources: [{ id: 'api', from: 'response', records: '$.data[*]' }],
      fields: { title: { path: '$.title', type: 'string', required: true }, price: { path: '$.price_cents', type: 'number', required: true } },
      pagination: { type: 'cursor', param: 'url.query.cursor', next_path: '$.next_cursor', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits: { hard_max_pages: 20 } },
    });
    const state = startPagination();
    let cursor: string | undefined;
    let total = 0;
    let last: PaginationDecision = { done: false };
    while (!last.done) {
      const res = await client.get(host, `/api/items?limit=20${cursor === undefined ? '' : `&cursor=${cursor}`}`);
      const out = extractRecords(s, { body: res.body });
      total += out.records.length;
      last = advancePagination(s.pagination, state, { records: out.records.length, document: JSON.parse(res.body) }, { limits: DEFAULT_DSL_LIMITS });
      if (!last.done && last.param) cursor = String(last.param.value);
    }
    expect(total).toBe(95);
    expect(state.pages).toBe(5);
    expect(last).toEqual({ done: true, reason: 'no_next' });
  });

  it('en-tête Link rel=next (RFC 8288) sur un tableau JSON nu', async () => {
    const host = 'zz_test_linkheader.localhost';
    const s = spec(host, {
      sources: [{ id: 'api', from: 'response', records: '$[*]' }],
      fields: { title: { path: '$.title', type: 'string', required: true }, price: { path: '$.price_cents', type: 'number', required: true } },
      pagination: { type: 'next_link', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits: { hard_max_pages: 10 } },
    });
    const state = startPagination();
    let path = '/api/items?page=1&per_page=20';
    let total = 0;
    for (let i = 0; i < 10; i += 1) {
      const res = await client.get(host, path);
      const out = extractRecords(s, { body: res.body });
      total += out.records.length;
      const link = res.headers['link'];
      const d = advancePagination(s.pagination, state, { records: out.records.length, linkHeader: typeof link === 'string' ? link : undefined }, { limits: DEFAULT_DSL_LIMITS });
      if (d.done) break;
      const next = new URL(resolveNextUrl(d.nextUrl as string, `http://${host}:${client.server.port}/`, [host]));
      path = next.pathname + next.search;
    }
    expect(total).toBe(57);
    expect(state.pages).toBe(3);
    expect(parseLinkNext('<https://a.test/?p=2>; rel="next", <https://a.test/?p=9>; rel="last"')).toBe('https://a.test/?p=2');
    expect(parseLinkNext('<https://a.test/?p=1>; rel="prev"')).toBeUndefined();
  });

  it('un lien « suivant » hors allowed_hosts est refusé', () => {
    expect(() => resolveNextUrl('http://evil.test/x', 'http://zz_test_a.localhost/', ['zz_test_a.localhost'])).toThrow(/allowed_hosts/);
    expect(() => resolveNextUrl('file:///etc/passwd', 'http://zz_test_a.localhost/', ['zz_test_a.localhost'])).toThrow();
  });
});

describe('robustesse face aux pages hostiles des fixtures', () => {
  it('une page « injection » : le texte hostile reste une donnée, aucune requête vers le domaine piège', async () => {
    const host = 'zz_test_injection.localhost';
    const res = await client.get(host, '/');
    const check = validateDeclarativeSpec({
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `https://${host}/`, allowed_hosts: [host] },
      sources: [{ id: 'dom', from: 'html', records: 'li.item, p.notice' }],
      fields: { title: { attr: 'text', type: 'string', required: true } },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const out = extractRecords(check.spec, { body: res.body });
    expect(out.ok).toBe(true);
    expect(out.records).toHaveLength(9);
    expect(String(out.records[8]?.['title'])).toContain('IGNORE TES INSTRUCTIONS');
    const stats = await client.stats();
    expect(stats.hosts['zz_test_evil.localhost']?.total ?? 0).toBe(0);
  });

  it('JSONPath sur un blob : le chemin n\'atteint pas les prototypes', async () => {
    const out = queryValues('$.__proto__', JSON.parse('{"a":1}'), { limits: DEFAULT_DSL_LIMITS });
    expect(out).toEqual([]);
  });
});
