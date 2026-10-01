// SPDX-License-Identifier: AGPL-3.0-only
// Boucle déclarative commune à E1-E3 (tâche 1.6) avec un transport simulé : placement des paramètres, étapes
// préalables, classement avant extraction, cadence, plafond de requêtes, sortie hors schéma (INV1).
import { describe, expect, it } from 'vitest';
import { DslError } from '../dsl/errors.js';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import type { RenderedRequest } from '../dsl/template.js';
import { SsrfBlockedError } from '../net/guard.js';
import { UpstreamProxyError } from '../net/modes/upstream.js';
import { applyParamAt, classifyStatus, classifyTransportError, runDeclarative, type HttpExchange, type RequestPacer } from './index.js';

const HOST = 'zz_test_api.localhost';
const SCHEMA = { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false };

function spec(extra: Record<string, unknown> = {}): DeclarativeSpec {
  const raw: Record<string, unknown> = {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `http://${HOST}/items`, allowed_hosts: [HOST], params: [{ at: 'url.query.page', role: 'pagination' }] },
    sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
    fields: { name: { path: '$.name', type: 'string', required: true } },
    pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 10 } },
    ...extra,
  };
  for (const [k, v] of Object.entries(raw)) if (v === undefined) delete raw[k];
  const check = validateDeclarativeSpec(raw, { outputSchema: SCHEMA });
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpExchange => ({ status, headers, body: JSON.stringify(body), url: `http://${HOST}/items` });

function scripted(pages: Record<string, HttpExchange>): { transport: (r: RenderedRequest) => Promise<HttpExchange>; seen: RenderedRequest[] } {
  const seen: RenderedRequest[] = [];
  return {
    seen,
    transport: async (r) => {
      seen.push(r);
      const page = new URL(r.url).searchParams.get('page') ?? 'step';
      const out = pages[page];
      if (out === undefined) return json(200, { items: [] });
      return out;
    },
  };
}

const signal = new AbortController().signal;

describe('applyParamAt', () => {
  const base: RenderedRequest = { method: 'POST', url: `http://${HOST}/s?x=1`, headers: {}, body: { kind: 'json', value: { q: 'a', page: { n: 0 } } } };
  it('place un paramètre en query, en JSON imbriqué et en formulaire', () => {
    expect(applyParamAt(base, 'url.query.page', 3).url).toBe(`http://${HOST}/s?x=1&page=3`);
    expect(applyParamAt(base, 'body.json.page.n', 40).body).toEqual({ kind: 'json', value: { q: 'a', page: { n: 40 } } });
    expect(applyParamAt(base, 'body.json.list[0]', 'c').body).toEqual({ kind: 'json', value: { q: 'a', page: { n: 0 }, list: ['c'] } });
    expect(() => applyParamAt(base, 'body.json.list[2]', 'c')).toThrow(DslError);
    const form: RenderedRequest = { method: 'POST', url: `http://${HOST}/s`, headers: {}, body: { kind: 'form', value: { q: 'a' } } };
    expect(applyParamAt(form, 'body.form.offset', 20).body).toEqual({ kind: 'form', value: { q: 'a', offset: '20' } });
  });
  it('refuse un emplacement inconnu, un hôte ou une clé de prototype', () => {
    expect(() => applyParamAt(base, 'url.host', 'evil.test')).toThrow(DslError);
    expect(() => applyParamAt(base, 'headers.authorization', 'x')).toThrow(DslError);
    expect(() => applyParamAt(base, 'body.json.__proto__.polluted', 1)).toThrow(DslError);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('classement (socle de 1.7)', () => {
  it('401, 402, 403, 404, 429, 451, 5xx : jamais `network` pour 401, 403 ou 429 (X4)', () => {
    expect(classifyStatus(200)).toBeNull();
    expect(classifyStatus(401)?.failure_class).toBe('auth_required');
    expect(classifyStatus(402)?.failure_class).toBe('payment_required');
    expect(classifyStatus(403)?.failure_class).toBe('forbidden');
    expect(classifyStatus(404)?.failure_class).toBe('not_found');
    expect(classifyStatus(429)).toMatchObject({ failure_class: 'rate_limited', retryable: true });
    expect(classifyStatus(451)?.failure_class).toBe('network');
    expect(classifyStatus(503)).toMatchObject({ failure_class: 'transient', retryable: true });
  });
  it('erreurs de transport : SSRF → forbidden, proxy injoignable → network, 407 → code_error, Chromium net::ERR_*', () => {
    expect(classifyTransportError(new SsrfBlockedError({ reason: 'loopback', host: 'x' }))).toMatchObject({ failure_class: 'forbidden', detail: 'ssrf_blocked' });
    expect(classifyTransportError(new TypeError('fetch failed', { cause: new SsrfBlockedError({ reason: 'private', host: 'x' }) })).detail).toBe('ssrf_blocked');
    expect(classifyTransportError(new UpstreamProxyError('proxy_refused', 'x', 502)).failure_class).toBe('network');
    expect(classifyTransportError(new UpstreamProxyError('proxy_auth_failed', 'x', 407)).failure_class).toBe('code_error');
    expect(classifyTransportError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).failure_class).toBe('network');
    expect(classifyTransportError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).failure_class).toBe('transient');
    expect(classifyTransportError(new Error('page.goto: net::ERR_TIMED_OUT at http://x/')).failure_class).toBe('transient');
    expect(classifyTransportError(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED')).failure_class).toBe('network');
    expect(classifyTransportError(new Error('net::ERR_BLOCKED_BY_CLIENT')).detail).toBe('domain_not_allowed');
    expect(classifyTransportError(new Error('inattendu'))).toMatchObject({ failure_class: 'code_error', detail: 'executor_error' });
  });
});

describe('runDeclarative', () => {
  it('pagine jusqu’à la page vide, valide chaque enregistrement contre output_schema', async () => {
    const t = scripted({ '1': json(200, { items: [{ name: 'a' }, { name: 'b' }] }), '2': json(200, { items: [{ name: 'c' }] }) });
    const out = await runDeclarative({ spec: spec(), input: {}, outputSchema: SCHEMA, transport: t.transport, signal });
    expect(out).toMatchObject({ ok: true, pages: 3, requests: 3, stop: 'records_empty', truncated: false, escalated: false });
    if (out.ok) expect(out.records.map((r) => r['name'])).toEqual(['a', 'b', 'c']);
    expect(t.seen.map((r) => new URL(r.url).searchParams.get('page'))).toEqual(['1', '2', '3']);
  });

  it('une réponse refusée (401, 403, 429) n’est jamais extraite : classe rendue, aucun enregistrement', async () => {
    for (const [status, cls] of [[401, 'auth_required'], [403, 'forbidden'], [429, 'rate_limited']] as const) {
      const t = scripted({ '1': json(status, { items: [{ name: 'piège' }] }) });
      const out = await runDeclarative({ spec: spec(), input: {}, outputSchema: SCHEMA, transport: t.transport, signal });
      expect(out).toMatchObject({ ok: false, failure: { failure_class: cls }, requests: 1 });
    }
  });

  it('la garde de classification injectée (1.7) passe avant l’extraction', async () => {
    const t = scripted({ '1': json(200, { items: [{ name: 'a' }] }) });
    const out = await runDeclarative({
      spec: spec(),
      input: {},
      transport: t.transport,
      signal,
      classify: () => ({ failure_class: 'blocked_by_protection', retryable: false, detail: 'challenge' }),
    });
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection' } });
  });

  it('sortie hors schéma → extraction (schema_mismatch), jamais un succès (INV1)', async () => {
    const t = scripted({ '1': json(200, { items: [{ name: 42 }] }) });
    const out = await runDeclarative({ spec: spec({ fields: { name: { path: '$.name', type: 'string', required: true } } }), input: {}, outputSchema: SCHEMA, transport: t.transport, signal });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.failure_class).toBe('extraction');
  });

  it('étapes préalables : capture par JSONPath, réutilisée dans la requête', async () => {
    const s = spec({
      request: { method: 'GET', url: `http://${HOST}/items?token={{steps.boot.token}}`, allowed_hosts: [HOST] },
      steps: [{ id: 'boot', request: { method: 'GET', url: `http://${HOST}/boot` }, capture: { token: '$.token' } }],
      pagination: undefined,
    });
    const seen: string[] = [];
    const out = await runDeclarative({
      spec: s,
      input: {},
      signal,
      transport: async (r) => {
        seen.push(r.url);
        return r.url.endsWith('/boot') ? json(200, { token: 'zz_t1' }) : json(200, { items: [{ name: 'a' }] });
      },
    });
    expect(out.ok).toBe(true);
    expect(seen).toEqual([`http://${HOST}/boot`, `http://${HOST}/items?token=zz_t1`]);
  });

  it('max_pages en entrée et plafond de requêtes par run (sortie tronquée)', async () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), json(200, { items: [{ name: `n${i}` }] })]));
    const s = spec({ pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }], limits: { max_pages_input: 'input.max_pages', hard_max_pages: 10 } } });
    const capped = await runDeclarative({ spec: s, input: { max_pages: 3 }, transport: scripted(many).transport, signal });
    expect(capped).toMatchObject({ ok: true, pages: 3, stop: 'max_pages_input', truncated: false });
    const limited = await runDeclarative({ spec: s, input: {}, transport: scripted(many).transport, signal, maxRequests: 4 });
    expect(limited).toMatchObject({ ok: true, pages: 4, requests: 4, stop: 'max_requests_per_run', truncated: true });
  });

  it('cadence : réservation avant chaque requête, compte rendu après ; refus → rate_limited sans requête', async () => {
    const log: string[] = [];
    const pacer: RequestPacer = {
      acquire: async (url) => {
        log.push(`acquire ${new URL(url).searchParams.get('page')}`);
        return { granted: true };
      },
      report: async (_url, r) => {
        log.push(`report ${r.status} ${r.retryAfter ?? '-'}`);
      },
    };
    await runDeclarative({ spec: spec(), input: {}, transport: scripted({ '1': json(200, { items: [{ name: 'a' }] }, { 'retry-after': '3' }) }).transport, signal, pacer });
    expect(log).toEqual(['acquire 1', 'report 200 3', 'acquire 2', 'report 200 -']);
    const t = scripted({});
    const refused = await runDeclarative({
      spec: spec(),
      input: {},
      transport: t.transport,
      signal,
      pacer: { acquire: async () => ({ granted: false, reason: 'circuit_open', retryAt: new Date() }), report: async () => undefined },
    });
    expect(refused).toMatchObject({ ok: false, requests: 0, failure: { failure_class: 'rate_limited', retryable: true, detail: 'pacing_circuit_open' } });
    expect(t.seen).toHaveLength(0);
  });

  it('un lien « suivant » hors allowed_hosts arrête l’exécution (code_error), sans requête vers l’hôte étranger', async () => {
    const s = spec({ request: { method: 'GET', url: `http://${HOST}/items`, allowed_hosts: [HOST] }, pagination: { type: 'next_link', stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 5 } } });
    const seen: string[] = [];
    const out = await runDeclarative({
      spec: s,
      input: {},
      signal,
      transport: async (r) => {
        seen.push(r.url);
        return json(200, { items: [{ name: 'a' }] }, { link: '<http://zz_test_evil.localhost/next>; rel="next"' });
      },
    });
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'code_error', detail: 'host_not_allowed' } });
    expect(seen).toEqual([`http://${HOST}/items`]);
  });

  it('une interruption (annulation, bail perdu) est relancée telle quelle', async () => {
    const controller = new AbortController();
    controller.abort(new Error('lease_lost'));
    await expect(runDeclarative({ spec: spec(), input: {}, transport: scripted({}).transport, signal: controller.signal })).rejects.toThrow('lease_lost');
  });
});
