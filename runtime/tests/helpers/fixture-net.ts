// SPDX-License-Identifier: AGPL-3.0-only
// Garde SSRF des tests d'exécuteurs (tâche 1.6) : les fixtures (0.5) tournent sur 127.0.0.1, sous des noms
// `zz_test_*.localhost` (le tiret bas est refusé par ALLOWED_PRIVATE_HOSTS). Drapeau de test « autoriser le privé »
// (NODE_ENV=test, 15 §7) et résolveur injecté qui ne connaît QUE les hôtes listés : tout autre nom est irrésoluble,
// donc refusé par la garde (`ssrf_blocked`). Aucune autre adresse que 127.0.0.1 n'est jamais contactée.
import * as srcNet from '../../packages/core/src/net/index.ts';
import type { Resolver } from '../../packages/core/src/net/index.ts';

/** Module de la garde : les sources (tests du noyau) ou le paquet construit `@runtime/core/net` (tests qui passent par le
 * worker, pour que les classes d'erreur soient les mêmes des deux côtés). */
type NetModule<G, P> = {
  SsrfGuard: new (options: { policy: P; resolver: Resolver }) => G;
  createSsrfPolicy: (input: { allowedPorts: number[]; testAllowPrivate: boolean }) => P;
};

/**
 * Hôte piège du dossier d'enquête (2.14, recette 12i) : le résolveur du harnais le résout vers une adresse PRIVÉE. Un indice
 * qui le vise doit être écarté AVANT toute résolution (`brief_host_ignored`) : `resolverLog` le prouve (aucune entrée).
 */
export const EVIL_EXAMPLE = 'evil.example';
export const resolverLog: string[] = [];

/** Résolveur qui ne connaît que `hosts` (vers 127.0.0.1) ; `evil.example` vers une adresse privée jamais contactée. */
function fixtureResolver(hosts: readonly string[]): Resolver {
  const known = new Set(hosts);
  return async (hostname) => {
    resolverLog.push(hostname);
    if (hostname === EVIL_EXAMPLE) return [{ address: '10.255.255.66', family: 4 }];
    if (known.has(hostname)) return [{ address: '127.0.0.1', family: 4 }];
    throw new Error(`zz_test : résolution refusée pour ${hostname}`);
  };
}

/** Garde qui n'atteint que `hosts` (noms exacts, résolus en 127.0.0.1) sur `port`. */
export function fixtureGuard(port: number, hosts: readonly string[]): srcNet.SsrfGuard;
export function fixtureGuard<G, P>(port: number, hosts: readonly string[], net: NetModule<G, P>): G;
export function fixtureGuard(port: number, hosts: readonly string[], net: NetModule<unknown, unknown> = srcNet as unknown as NetModule<unknown, unknown>): unknown {
  return new net.SsrfGuard({ policy: net.createSsrfPolicy({ allowedPorts: [port], testAllowPrivate: true }), resolver: fixtureResolver(hosts) });
}

export const SCHEMA_CONTACT = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id', 'name', 'email', 'score'],
  properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, city: { type: 'string' }, score: { type: 'number' } },
  additionalProperties: false,
};

export const SCHEMA_PRODUCT = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['title', 'price'],
  properties: { title: { type: 'string', minLength: 1 }, price: { type: 'number', minimum: 0 }, sku: { type: 'string' } },
  additionalProperties: false,
};

/** Stratégie déclarative brute (avant `validateDeclarativeSpec`) pour l'API JSON de contacts, paginée par page. */
export function contactsSpecInput(base: string, host: string, perPage = 50): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: 'declarative',
    request: {
      method: 'GET',
      url: `${base}/api/contacts?per_page=${perPage}`,
      allowed_hosts: [host],
      params: [{ at: 'url.query.page', role: 'pagination' }],
    },
    sources: [{ id: 'api', from: 'response', format: 'json', records: '$.items[*]' }],
    fields: {
      id: { path: '$.id', type: 'string', required: true },
      name: { path: '$.name', type: 'string', required: true, ops: ['trim'] },
      email: { path: '$.email', type: 'string', required: true, ops: ['lower'] },
      city: { path: '$.city', type: 'string' },
      score: { path: '$.score', type: 'number', required: true },
    },
    pagination: {
      type: 'page_param',
      param: 'url.query.page',
      start: 1,
      stop: [{ when: 'records_empty' }, { when: 'path_equals', path: '$.has_more', value: false }],
      limits: { max_pages_input: 'input.max_pages', hard_max_pages: 50 },
    },
  };
}

/** Catalogue SSR (rendu serveur) : 100 produits en 5 pages liées par rel=next. */
export function ssrSpecInput(base: string, host: string): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `${base}/`, allowed_hosts: [host] },
    sources: [{ id: 'dom', from: 'html', records: 'article.product' }],
    fields: {
      title: { css: 'h2.title a', attr: 'text', type: 'string', required: true, ops: ['collapse_spaces'] },
      price: { css: 'span.price', type: 'number', required: true, ops: [{ op: 'to_number', decimal: ',' }] },
      sku: { css: 'h2.title a', attr: 'href', type: 'string', ops: [{ op: 'regex_extract', pattern: 'zz_test_product_[0-9]+' }] },
    },
    pagination: { type: 'next_link', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits: { hard_max_pages: 10 } },
  };
}

/** Application monopage : coquille vide, items rendus par JavaScript (`div.spa-item`, « titre - 12.34 EUR »). */
export function spaSpecInput(base: string, host: string): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `${base}/`, allowed_hosts: [host] },
    sources: [{ id: 'dom', from: 'html', records: 'div.spa-item' }],
    fields: {
      title: { attr: 'text', type: 'string', required: true, ops: [{ op: 'regex_extract', pattern: '(.+) - [0-9]', group: 1 }] },
      price: { attr: 'text', type: 'number', required: true, ops: [{ op: 'regex_extract', pattern: '[0-9]+\\.[0-9]{2}' }, 'to_number'] },
    },
  };
}

/** API JSON appelée par l'application monopage (`/api/items.json`) : ce qu'E1 et E2 visent sur la fixture SPA. */
export function spaApiSpecInput(base: string, host: string): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `${base}/api/items.json`, allowed_hosts: [host] },
    sources: [{ id: 'api', from: 'response', format: 'json', records: '$.items[*]' }],
    fields: {
      title: { path: '$.title', type: 'string', required: true },
      price: { path: '$.price_cents', type: 'number', required: true },
      sku: { path: '$.id', type: 'string' },
    },
  };
}
