// SPDX-License-Identifier: AGPL-3.0-only
// OpenAPI propre à une API (tâche 3.12, 05 § 2, 16 § 6) : `GET /api/apis/{slug}/openapi.json`. Document 3.1 réduit à
// cette API, pour générer des types (openapi-typescript) : lancement d'un run (`runApi`, entrée = `input_schema`,
// items = `output_schema`), lecture du run (`getRun`) et de ses items (`listDatasetItems`), section `webhooks` (charges
// de `run.succeeded`, `run.failed`, `api.status_changed`, `items.new`). Les opérations, réponses et composants sont
// recopiés de l'OpenAPI spécifiée (une seule source), avec la fermeture de leurs références. Déterministe : le même
// état de l'API rend le même document (identifiants d'opération stables).
import { SPECIFIED_OPENAPI_JSON } from '../generated/openapi.js';

type Json = Record<string, unknown>;
type Spec = { paths: Record<string, Record<string, Json>>; components: Record<string, Record<string, unknown>>; webhooks?: Json; security?: unknown };

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

let specified: Spec | undefined;
const spec = (): Spec => (specified ??= JSON.parse(SPECIFIED_OPENAPI_JSON) as Spec);

/** Références `#/components/<section>/<nom>` d'un nœud (profondeur bornée). */
function refsOf(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 128) return;
  if (Array.isArray(node)) for (const v of node) refsOf(v, out, depth + 1);
  else if (isRecord(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/')) out.add(v);
      else refsOf(v, out, depth + 1);
    }
  }
}

/** Composants de l'OpenAPI spécifiée atteints depuis `roots`, fermeture comprise. */
function closure(roots: unknown[]): Record<string, Record<string, unknown>> {
  const s = spec();
  const out: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  const queue = new Set<string>();
  for (const r of roots) refsOf(r, queue);
  while (queue.size > 0) {
    const ref = queue.values().next().value as string;
    queue.delete(ref);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const [section, name] = ref.replace('#/components/', '').split('/') as [string, string];
    const value = s.components[section]?.[name];
    if (value === undefined) continue;
    (out[section] ??= {})[name] = clone(value);
    const more = new Set<string>();
    refsOf(value, more);
    for (const m of more) if (!seen.has(m)) queue.add(m);
  }
  return out;
}

/**
 * Schéma de l'utilisateur placé sous `#/components/schemas/<nom>` : ses références locales (`#/$defs/x`, `#`) sont
 * réécrites vers ce nouvel emplacement (sinon elles viseraient la racine du document OpenAPI). Aucune référence distante
 * n'existe (refusée à l'enregistrement, INV1).
 */
function relocate(schema: unknown, name: string, depth = 0): unknown {
  if (depth > 64) return schema;
  if (Array.isArray(schema)) return schema.map((s) => relocate(s, name, depth + 1));
  if (!isRecord(schema)) return schema;
  const out: Json = {};
  for (const [k, v] of Object.entries(schema)) {
    const value = (k === '$ref' || k === '$dynamicRef') && typeof v === 'string' && v.startsWith('#') ? `#/components/schemas/${name}${v.slice(1)}` : relocate(v, name, depth + 1);
    Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

const objectOr = (v: unknown): Json => (isRecord(v) && Object.keys(v).length > 0 ? v : { type: 'object' });

export function apiOpenApi(api: { slug: string; description: string; input_schema: unknown; output_schema: unknown; current_strategy_version: number | null }): Json {
  const s = spec();
  const runOp = clone(s.paths['/api/apis/{slug}/runs']?.['post'] ?? {});
  const getRun = clone(s.paths['/api/runs/{id}']?.['get'] ?? {});
  const items = clone(s.paths['/api/datasets/{id}/items']?.['get'] ?? null);
  // Run de CETTE API : chemin sans paramètre `slug`, entrée = son schéma d'entrée, items = son schéma de sortie.
  runOp['operationId'] = 'runApi';
  runOp['tags'] = ['api'];
  runOp['parameters'] = (Array.isArray(runOp['parameters']) ? runOp['parameters'] : []).filter((p) => !(isRecord(p) && p['$ref'] === '#/components/parameters/Slug'));
  runOp['requestBody'] = {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['input'],
          properties: { input: { $ref: '#/components/schemas/Input' }, strategy_version: { type: 'integer', minimum: 1 } },
        },
      },
    },
  };
  const responses = isRecord(runOp['responses']) ? runOp['responses'] : {};
  responses['200'] = {
    description: 'Run terminé : items conformes au schéma de sortie de l’API (INV1).',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiRunResult' } } },
  };
  runOp['responses'] = responses;
  getRun['tags'] = ['api'];
  const paths: Json = {
    [`/api/apis/${api.slug}/runs`]: { post: runOp },
    '/api/runs/{id}': { get: getRun },
  };
  if (items !== null) {
    items['tags'] = ['api'];
    paths['/api/datasets/{id}/items'] = { get: items };
  }
  const webhooks = clone(s.webhooks ?? {});
  const components = closure([paths, webhooks]);
  const own = {
    Input: relocate(objectOr(api.input_schema), 'Input'),
    Item: relocate(objectOr(api.output_schema), 'Item'),
    ApiRunResult: {
      description: 'Enveloppe RunResult (05 § 4.1) dont les items suivent le schéma de sortie de cette API.',
      allOf: [{ $ref: '#/components/schemas/RunResult' }, { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Item' } } } }],
    },
  };
  const more = closure([own]);
  for (const [section, values] of Object.entries(more)) components[section] = { ...(components[section] ?? {}), ...values };
  components['schemas'] = { ...(components['schemas'] ?? {}), ...own };
  components['securitySchemes'] = { sessionCookie: s.components['securitySchemes']?.['sessionCookie'], apiKey: s.components['securitySchemes']?.['apiKey'] };
  // Ordre stable des sections et des noms : même document d'un appel à l'autre.
  const sorted = Object.fromEntries(Object.keys(components).sort().map((k) => [k, Object.fromEntries(Object.keys(components[k]!).sort().map((n) => [n, components[k]![n]]))]));
  return {
    openapi: '3.1.0',
    info: {
      title: api.slug,
      version: String(api.current_strategy_version ?? 0),
      description: api.description === '' ? `API ${api.slug}` : api.description,
    },
    servers: [{ url: '/' }],
    security: [{ apiKey: [] }, { sessionCookie: [] }],
    tags: [{ name: 'api' }],
    paths,
    webhooks,
    components: sorted,
  };
}
