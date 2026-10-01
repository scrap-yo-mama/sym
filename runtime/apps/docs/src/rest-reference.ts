// SPDX-License-Identifier: AGPL-3.0-only
// Référence REST (16 § 4 : « généré depuis OpenAPI ») : lit l'OpenAPI spécifiée de packages/client et en tire une page
// Markdown. Aucune route n'est écrite à la main : une opération ajoutée ou livrée change la page à la prochaine construction.

type Json = Record<string, unknown>;
type Schema = Json;
type Operation = {
  operationId?: string;
  summary?: string;
  tags?: string[];
  security?: Record<string, unknown>[];
  parameters?: Json[];
  requestBody?: Json;
  responses?: Record<string, Json>;
  'x-pending'?: string;
};
export type OpenApiDocument = {
  info?: { title?: string; version?: string };
  security?: Record<string, unknown>[];
  tags?: { name: string }[];
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, Schema>; parameters?: Record<string, Json>; responses?: Record<string, Json>; securitySchemes?: Record<string, Json> };
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const AUTH_LABELS: Record<string, string> = {
  sessionCookie: 'session',
  apiKey: 'clé d’API',
  deviceToken: 'jeton d’appareil',
  metricsToken: '`METRICS_TOKEN`',
};

const TAG_TITLES: Record<string, string> = {
  system: 'Système',
  auth: 'Authentification',
  account: 'Compte',
  events: 'Événements',
  apis: 'API du catalogue',
  runs: 'Runs',
  datasets: 'Jeux de données',
  schedules: 'Planifications',
  webhooks: 'Webhooks',
  settings: 'Réglages',
  users: 'Utilisateurs',
  audit: 'Journal d’audit',
  subjects: 'Droits des personnes',
  tunnel: 'Tunnel et extension',
};

/** Texte sûr dans une cellule ou un paragraphe : pas de HTML, pas d'interpolation Vue, pas de renvoi interne au CDC. */
export function plain(text: unknown): string {
  return String(text ?? '')
    .replace(/\s*\((?:[^()]*§[^()]*)\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{\{/g, '{&#8203;{');
}

const code = (text: string): string => `\`${text.replace(/`/g, '')}\``;
const schemaAnchor = (name: string): string => `schema-${name.toLowerCase()}`;
const refName = (ref: string): string => ref.split('/').pop() ?? ref;

function typeOf(schema: Schema | undefined): string {
  if (!schema) return 'inconnu';
  if (typeof schema['$ref'] === 'string') {
    const ref = schema['$ref'];
    if (ref.startsWith('#/components/schemas/')) return `[${refName(ref)}](#${schemaAnchor(refName(ref))})`;
    return code(refName(ref));
  }
  if ('const' in schema) return code(JSON.stringify(schema['const']));
  if (Array.isArray(schema['enum'])) return (schema['enum'] as unknown[]).map((v) => code(JSON.stringify(v))).join(' \\| ');
  for (const key of ['oneOf', 'anyOf'] as const) {
    const variants = schema[key];
    if (Array.isArray(variants)) return (variants as Schema[]).map(typeOf).join(' \\| ');
  }
  if (Array.isArray(schema['allOf'])) return (schema['allOf'] as Schema[]).map(typeOf).join(' + ');
  const type = schema['type'];
  if (type === 'array') return `liste de ${typeOf(schema['items'] as Schema | undefined)}`;
  const base = Array.isArray(type) ? (type as string[]).join(' ou ') : typeof type === 'string' ? type : 'objet';
  const format = typeof schema['format'] === 'string' ? ` (${schema['format']})` : '';
  return code(base + format);
}

function authOf(op: Operation, doc: OpenApiDocument): string {
  const requirement = op.security ?? doc.security ?? [];
  if (requirement.length === 0) return 'publique';
  const names = new Set<string>();
  for (const entry of requirement) for (const name of Object.keys(entry)) names.add(AUTH_LABELS[name] ?? name);
  return [...names].join(' ou ');
}

const authLabel = (op: Operation, doc: OpenApiDocument): string => (op['x-pending'] ? `${authOf(op, doc)} (prévue)` : authOf(op, doc));

const stateOf = (op: Operation): string => (op['x-pending'] ? `en préparation (${op['x-pending']})` : 'disponible');

function resolveParameter(param: Json, doc: OpenApiDocument): Json {
  const ref = param['$ref'];
  if (typeof ref === 'string') return doc.components?.parameters?.[refName(ref)] ?? { name: refName(ref), in: '?' };
  return param;
}

function responseSchemaOf(response: Json, doc: OpenApiDocument): string {
  const resolved = typeof response['$ref'] === 'string' ? (doc.components?.responses?.[refName(response['$ref'])] ?? {}) : response;
  const content = resolved['content'] as Record<string, { schema?: Schema }> | undefined;
  const media = content?.['application/json'] ?? (content ? Object.values(content)[0] : undefined);
  return media?.schema ? typeOf(media.schema) : '';
}

function responseText(response: Json, doc: OpenApiDocument): string {
  const resolved = typeof response['$ref'] === 'string' ? (doc.components?.responses?.[refName(response['$ref'])] ?? {}) : response;
  return plain(resolved['description']);
}

type Entry = { method: string; path: string; op: Operation };

export function listOperations(doc: OpenApiDocument): Entry[] {
  const out: Entry[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (op) out.push({ method: method.toUpperCase(), path, op });
    }
  }
  return out;
}

const anchorOf = (entry: Entry): string => `op-${(entry.op.operationId ?? `${entry.method}-${entry.path}`).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

function renderOperation(entry: Entry, doc: OpenApiDocument): string[] {
  const { op } = entry;
  const lines = [`#### ${entry.method} ${code(entry.path)} {#${anchorOf(entry)}}`, ''];
  lines.push(plain(op.summary), '');
  lines.push(`Authentification : ${authLabel(op, doc)}. État : ${stateOf(op)}.${op.operationId ? ` Identifiant : ${code(op.operationId)}.` : ''}`, '');
  const params = (op.parameters ?? []).map((p) => resolveParameter(p, doc));
  if (params.length > 0) {
    lines.push('| Paramètre | Où | Obligatoire | Type | Description |', '|---|---|---|---|---|');
    for (const p of params) {
      lines.push(`| ${code(String(p['name']))} | ${plain(p['in'])} | ${p['required'] ? 'oui' : 'non'} | ${typeOf(p['schema'] as Schema | undefined)} | ${plain(p['description'])} |`);
    }
    lines.push('');
  }
  const body = op.requestBody as { content?: Record<string, { schema?: Schema }>; required?: boolean } | undefined;
  if (body?.content) {
    const [mediaType, media] = Object.entries(body.content)[0] ?? ['', {}];
    lines.push(`Corps (${code(mediaType)}${body.required ? ', obligatoire' : ''}) : ${typeOf(media.schema)}`, '');
  }
  const responses = Object.entries(op.responses ?? {});
  if (responses.length > 0) {
    lines.push('| Réponse | Description | Corps |', '|---|---|---|');
    for (const [status, response] of responses) lines.push(`| ${code(status)} | ${responseText(response, doc)} | ${responseSchemaOf(response, doc)} |`);
    lines.push('');
  }
  return lines;
}

function renderSchema(name: string, schema: Schema): string[] {
  const lines = [`### ${name} {#${schemaAnchor(name)}}`, ''];
  if (typeof schema['description'] === 'string') lines.push(plain(schema['description']), '');
  const properties = schema['properties'] as Record<string, Schema> | undefined;
  if (properties && Object.keys(properties).length > 0) {
    const required = new Set((schema['required'] as string[] | undefined) ?? []);
    lines.push('| Champ | Obligatoire | Type | Description |', '|---|---|---|---|');
    for (const [field, spec] of Object.entries(properties)) {
      lines.push(`| ${code(field)} | ${required.has(field) ? 'oui' : 'non'} | ${typeOf(spec)} | ${plain(spec['description'])} |`);
    }
    lines.push('');
  } else {
    lines.push(`Type : ${typeOf(schema)}`, '');
  }
  return lines;
}

export function renderRestReference(doc: OpenApiDocument): string {
  const operations = listOperations(doc);
  const delivered = operations.filter((e) => !e.op['x-pending']).length;
  const lines: string[] = [
    '---',
    'title: API REST',
    '---',
    '',
    '# API REST',
    '',
    '<!-- Page générée par scripts/gen-reference.ts depuis packages/client/openapi/openapi.yaml : ne pas la modifier à la main. -->',
    '',
    `Cette page est produite à chaque construction du site à partir de l'OpenAPI 3.1 du dépôt (version ${plain(doc.info?.version)} du document). Elle décrit **${operations.length} opérations**, dont **${delivered} disponibles** dans cette version du serveur ; les autres sont spécifiées pour que la console et les clients avancent, et portent l'état « en préparation ».`,
    '',
    '## Authentification',
    '',
    'Chaque opération indique ce qu\'elle accepte :',
    '',
    ...Object.entries(doc.components?.securitySchemes ?? {}).map(([name, spec]) => `- **${AUTH_LABELS[name] ?? name}** : ${plain(spec['description'])}`),
    '',
    'Sans mention, une route accepte la session d\'interface ou une clé d\'API. Une clé d\'API n\'a jamais de portée d\'administration : les routes d\'administration n\'acceptent que la session. Pour une opération « en préparation », l\'authentification indiquée est celle **prévue** par la spécification ; elle est confirmée à la livraison de la route.',
    '',
    '## Opérations par domaine',
    '',
  ];
  const tags = (doc.tags ?? []).map((t) => t.name);
  for (const entry of operations) for (const t of entry.op.tags ?? []) if (!tags.includes(t)) tags.push(t);
  for (const tag of tags) {
    const inTag = operations.filter((e) => (e.op.tags ?? [])[0] === tag);
    if (inTag.length === 0) continue;
    lines.push(`### ${TAG_TITLES[tag] ?? tag}`, '');
    lines.push('| Méthode | Chemin | Résumé | Authentification | État |', '|---|---|---|---|---|');
    for (const entry of inTag) {
      lines.push(`| ${entry.method} | [${code(entry.path)}](#${anchorOf(entry)}) | ${plain(entry.op.summary)} | ${authLabel(entry.op, doc)} | ${stateOf(entry.op)} |`);
    }
    lines.push('');
  }
  lines.push('## Détail des opérations', '');
  for (const tag of tags) {
    const inTag = operations.filter((e) => (e.op.tags ?? [])[0] === tag);
    if (inTag.length === 0) continue;
    lines.push(`### ${TAG_TITLES[tag] ?? tag} {#detail-${tag}}`, '');
    for (const entry of inTag) lines.push(...renderOperation(entry, doc));
  }
  lines.push('## Schémas', '');
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) lines.push(...renderSchema(name, schema));
  return `${lines.join('\n')}\n`;
}
