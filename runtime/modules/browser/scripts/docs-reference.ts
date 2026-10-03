// SPDX-License-Identifier: AGPL-3.0-only
// Référence générée de la documentation de SYM Browser (tâche 3.8) : `docs/<langue>/reference/api.md` depuis l'OpenAPI du
// contrat `@sym/contracts/browser` (opérations, scopes, statuts, champs de création, codes d'erreur, WebSocket) et
// `docs/<langue>/reference/configuration.md` depuis le catalogue d'environnement (packages/core). Ne pas éditer ces fichiers
// à la main : `pnpm --filter @sym-browser/module docs:reference` les réécrit, `--check` échoue s'ils ne sont pas à jour
// (tests/docs.unit.test.ts fait la même vérification).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_ENGINE, BROWSER_PROTOCOL_VERSION, ERROR_CODES, ERROR_STATUS, browserOpenApi } from '@sym/contracts/browser';
import { BROWSER_ENV_CATALOG, BROWSER_ENV_GROUPS, type BrowserEnvGroup } from '../packages/core/src/config/env-catalog.ts';
import type { DocLocale } from './docs-lib.ts';

export const REFERENCE_PAGES = ['reference/api.md', 'reference/configuration.md'] as const;
export type ReferencePage = (typeof REFERENCE_PAGES)[number];

/** Scope exigé par opération (04 § 1 et § 2) : l'OpenAPI déclare le schéma `bearer`, pas les scopes. */
const SCOPES: Record<string, string | null> = {
  createSession: 'sessions:write',
  listSessions: 'sessions:read',
  getSession: 'sessions:read',
  releaseSession: 'sessions:write',
  extendSession: 'sessions:write',
  getVersion: null,
  getOpenApi: null,
};

/** Description anglaise de chaque opération (l'OpenAPI du contrat est rédigée en français). */
const OPERATIONS_EN: Record<string, string> = {
  createSession: 'Creates a session (default type `dedicated`) and waits until it is `running`; `wait=false` returns at once, in `pending`.',
  listSessions: 'Cursor-paginated list, newest `createdAt` first. Metadata filter: `metadata.{key}={value}`.',
  getSession: 'Reads a session; a `running` session gets `connectUrls` with fresh tokens.',
  releaseSession: 'Releases the session (reason `released`); replaying it has no effect.',
  extendSession: 'Adds time, capped by the client’s maximum duration.',
  getVersion: 'Served versions: product, API, contract, Playwright, Chromium, platform, minimum SDK.',
  getOpenApi: 'This OpenAPI 3.1 document.',
};

/** Variables du catalogue décrites en anglais (le catalogue est rédigé en français). Une variable sans traduction fait échouer le test. */
export const ENV_DESCRIPTIONS_EN: Record<string, string> = {
  SYMB_MODE: '`all` (gateway and node in one process, disk storage), `gateway` or `node`: role of the process.',
  PORT: 'Listening port (0 to 65535; 0 lets the system pick a free port, for tests). Honours the value injected by the platform.',
  NODE_ENV: '`production`, `development` or `test`. Only `test` enables the test flags; anywhere else their presence stops the start.',
  SHUTDOWN_GRACE_SECONDS: 'Draining grace period on SIGTERM, 1 to 300 seconds.',
  DATABASE_URL: 'PostgreSQL 16 to 18, `postgres://` or `postgresql://` scheme.',
  MASTER_KEY: 'Exactly 32 bytes in base64 (44 characters), no passphrase. Generate it with `openssl rand -base64 32`. Back it up outside the platform: without it, secrets cannot be read.',
  MASTER_KEY_PREVIOUS: 'Previous key, for the time of a key change; same format as `MASTER_KEY`. Remove it afterwards.',
  NODE_TOKEN: 'Secret shared by the gateway and the node, at least 32 characters. Not needed in `all` mode (the node registers on 127.0.0.1).',
  NODE_PUBLIC_URL: 'Private URL (http or https) announced to the gateway. In `all` mode: `http://127.0.0.1:<PORT>`.',
  NODE_ID: 'Stable node identifier (1 to 63 characters `A-Za-z0-9_.-`).',
  NODE_REGION: 'Region announced to the gateway (`a-z0-9_.-`, 1 to 40 characters).',
  MAX_SESSIONS: 'Node slots, 1 to 64; overrides the value computed from the container memory.',
  WARM_BROWSERS: 'Pre-warmed Chromium instances (0 to 64).',
  CONTEXTS_PER_BROWSER: 'Concurrent contexts per warm Chromium (1 to 64); unset: the constant measured by task 0.6.',
  RECYCLE_AFTER_SESSIONS: 'Sessions served before a Chromium is recycled.',
  RECYCLE_AFTER_MS: 'Age of a Chromium before recycling, in milliseconds.',
  RECYCLE_RSS_PERCENT: 'Memory threshold for recycling, in percent (1 to 100).',
  HEARTBEAT_MS: 'Period of the node heartbeat to the gateway, in milliseconds (at least 100).',
  SYMB_DATA_DIR: 'Session working directories (`sessions/{id}`), absolute path.',
  SYMB_PRIVATE_HOSTS: 'Private hosts reachable by the egress: exact names or CIDR, comma-separated. Empty: every private host is refused.',
  SYMB_IP_ECHO_URL: 'HTTPS echo endpoint of the proxy test at session creation.',
  QUEUE_MAX: 'Global size of the session queue.',
  QUEUE_MAX_PER_TENANT: 'Queue size per client.',
  QUEUE_TIMEOUT_MS: 'Maximum wait in the queue, in milliseconds.',
  OBJECT_STORE: '`disk` or `s3`. `all` mode only accepts `disk`.',
  OBJECT_DIR: 'Directory of the `disk` store, absolute path.',
  S3_ENDPOINT: 'Endpoint of an S3-compatible store (R2, MinIO), http or https URL; empty: AWS S3.',
  S3_BUCKET: 'Bucket; required with `OBJECT_STORE=s3`.',
  S3_REGION: 'Bucket region.',
  S3_ACCESS_KEY_ID: 'S3 access key ID; required with `OBJECT_STORE=s3`.',
  S3_SECRET_ACCESS_KEY: 'S3 secret access key; required with `OBJECT_STORE=s3`.',
  SYMB_PROFILE_MAX_BYTES: 'Maximum size of a persistent profile, in bytes (100 MB, to be confirmed).',
  SYMB_DOWNLOAD_MAX_BYTES: 'Cap per downloaded file, in bytes (500 MB, to be confirmed).',
  SYMB_SESSION_DOWNLOAD_MAX_BYTES: 'Download cap per session, in bytes (2 GB, to be confirmed).',
  SYMB_UPLOAD_MAX_BYTES: 'Cap per file upload, in bytes (100 MB, to be confirmed).',
  SYMB_CDP_MAX_MESSAGE_BYTES: 'Maximum size of a relayed CDP message, in bytes (100 MB, to be confirmed).',
  SYMB_RECORDING_MAX_BYTES: 'Cap per recording, in bytes (200 MB, to be confirmed).',
  SYMB_RETENTION_TRACE_DAYS: 'Retention of Playwright traces, in days.',
  SYMB_RETENTION_HAR_DAYS: 'Retention of HAR files, in days.',
  SYMB_RETENTION_VIDEO_DAYS: 'Retention of videos, in days.',
  SYMB_RETENTION_LOG_DAYS: 'Retention of session logs, in days.',
  SYMB_RETENTION_DOWNLOAD_HOURS: 'Retention of kept downloads, in hours.',
  SYMB_LOG_LEVEL: '`trace`, `debug`, `info`, `warn`, `error` or `fatal`: log threshold (JSON on stdout).',
  SYMB_METRICS_TOKEN: 'Read token of `/metrics`, at least 32 characters.',
  SYMB_BOOTSTRAP_TOKEN: 'Token of `/setup` (first start), at least 32 characters.',
  SYMB_BOOTSTRAP_API_KEY: 'First API key (client `sym`) created when the key table is empty; exchange key with SYM. At least 32 characters.',
  SYMB_TEST_MODE: '`1` under `NODE_ENV=test`: route `/v1/_test/process-info/{id}`. Anywhere else its presence stops the start.',
  SYMB_TEST_ALLOW_PRIVATE: '`1` under `NODE_ENV=test`: the egress reaches the private fixtures. Anywhere else its presence stops the start.',
};

const GROUPS_EN: Record<BrowserEnvGroup, string> = {
  Process: 'Process',
  'Base et clé': 'Database and key',
  Nœud: 'Node',
  Passerelle: 'Gateway',
  Stockage: 'Storage',
  Limites: 'Limits',
  Rétention: 'Retention',
  'Journaux et accès': 'Logs and access',
  Test: 'Test',
};

const T = {
  fr: {
    generated: '<!-- Fichier généré par scripts/docs-reference.ts (`pnpm --filter @sym-browser/module docs:reference`) : ne pas éditer. -->',
    apiTitle: 'Référence de l’API',
    apiIntro: (v: string) =>
      `Contrat \`@sym/contracts/browser\` ${v}, API REST \`/v1\`, Playwright ${BROWSER_ENGINE.playwright}, Chromium ${BROWSER_ENGINE.chromium}. Authentification : \`Authorization: Bearer <clé d’API>\` (scopes ci-dessous). Document OpenAPI 3.1 complet : \`GET /v1/openapi.json\`.`,
    operations: 'Opérations',
    scope: 'Scope',
    none: 'aucun',
    statuses: 'Statuts',
    createFields: 'Champs de `POST /v1/sessions`',
    createIntro: 'Tous facultatifs ; les défauts sont ceux de l’instance.',
    field: 'Champ',
    type: 'Type',
    ws: 'Connexions WebSocket',
    wsIntro:
      'Chaque session `running` porte ses `connectUrls` : URL `ws(s)://` à jeton court (`?token=…`, 5 minutes) que tout client ouvre telle quelle. Le jeton peut aussi passer en `Authorization: Bearer` pour les clients qui envoient des en-têtes. Relire la session (`GET /v1/sessions/{id}`) rend des jetons neufs.',
    wsRows: [
      ['`/v1/sessions/{id}/cdp`', 'CDP, protocole commun (sessions `dedicated`, type par défaut) ; `409 protocol_not_served` sur une session `shared`'],
      ['`/v1/sessions/{id}/playwright`', 'Playwright natif (`chromium.connect`), client 1.63.x exigé (`428 playwright_version_mismatch` sinon)'],
    ],
    endpoint: 'Point',
    role: 'Rôle',
    errors: 'Codes d’erreur',
    errorsIntro: 'Forme de toute erreur : `{ "error": { "code", "message", "retryable", "what_to_do", "requestId" } }`. Le `code` est stable ; `what_to_do` suit `Accept-Language`.',
    code: 'Code',
    status: 'Statut HTTP',
    configTitle: 'Référence de la configuration',
    configIntro:
      'Variables d’environnement lues par l’image (`SYMB_MODE` : `all`, `gateway` ou `node`). Un secret accepte aussi `NOM_FILE=/chemin`. Une configuration invalide arrête le démarrage avec un message qui nomme la variable ; `node dist/main.js --check-config` valide sans écouter.',
    variable: 'Variable',
    default: 'Défaut',
    required: 'Obligatoire en',
    secret: 'Secret',
    yes: 'oui (`_FILE`)',
    no: 'non',
    description: 'Description',
    group: (g: BrowserEnvGroup) => g,
    describe: (name: string) => BROWSER_ENV_CATALOG.find((v) => v.name === name)!.description,
  },
  en: {
    generated: '<!-- File generated by scripts/docs-reference.ts (`pnpm --filter @sym-browser/module docs:reference`): do not edit. -->',
    apiTitle: 'API reference',
    apiIntro: (v: string) =>
      `Contract \`@sym/contracts/browser\` ${v}, REST API \`/v1\`, Playwright ${BROWSER_ENGINE.playwright}, Chromium ${BROWSER_ENGINE.chromium}. Authentication: \`Authorization: Bearer <API key>\` (scopes below). Full OpenAPI 3.1 document: \`GET /v1/openapi.json\`.`,
    operations: 'Operations',
    scope: 'Scope',
    none: 'none',
    statuses: 'Statuses',
    createFields: 'Fields of `POST /v1/sessions`',
    createIntro: 'All optional; defaults are the instance’s.',
    field: 'Field',
    type: 'Type',
    ws: 'WebSocket connections',
    wsIntro:
      'Every `running` session carries its `connectUrls`: `ws(s)://` URLs with a short-lived token (`?token=…`, 5 minutes) that any client opens as is. The token can also go in `Authorization: Bearer` for clients that send headers. Reading the session again (`GET /v1/sessions/{id}`) returns fresh tokens.',
    wsRows: [
      ['`/v1/sessions/{id}/cdp`', 'CDP, the common protocol (`dedicated` sessions, the default type); `409 protocol_not_served` on a `shared` session'],
      ['`/v1/sessions/{id}/playwright`', 'Native Playwright (`chromium.connect`), client 1.63.x required (`428 playwright_version_mismatch` otherwise)'],
    ],
    endpoint: 'Endpoint',
    role: 'Role',
    errors: 'Error codes',
    errorsIntro: 'Shape of every error: `{ "error": { "code", "message", "retryable", "what_to_do", "requestId" } }`. The `code` is stable; `what_to_do` follows `Accept-Language`.',
    code: 'Code',
    status: 'HTTP status',
    configTitle: 'Configuration reference',
    configIntro:
      'Environment variables read by the image (`SYMB_MODE`: `all`, `gateway` or `node`). A secret also accepts `NAME_FILE=/path`. An invalid configuration stops the start with a message that names the variable; `node dist/main.js --check-config` validates without listening.',
    variable: 'Variable',
    default: 'Default',
    required: 'Required in',
    secret: 'Secret',
    yes: 'yes (`_FILE`)',
    no: 'no',
    description: 'Description',
    group: (g: BrowserEnvGroup) => GROUPS_EN[g],
    describe: (name: string) => ENV_DESCRIPTIONS_EN[name] ?? '',
  },
} as const;

type Json = Record<string, unknown>;
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Type lisible d'un schéma JSON (un niveau). */
function typeOf(schema: Json): string {
  if (typeof schema.$ref === 'string') return `\`${schema.$ref.split('/').at(-1)}\``;
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => `\`${String(v)}\``).join(', ');
  if (schema.type === 'array') return `${typeOf((schema.items ?? {}) as Json)} []`;
  if (typeof schema.type === 'string') return `\`${schema.type}\``;
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) return ((schema.anyOf ?? schema.oneOf) as Json[]).map(typeOf).join(' \\| ');
  return '`object`';
}

function renderApi(locale: DocLocale): string {
  const t = T[locale];
  const lines: string[] = [t.generated, '', `# ${t.apiTitle}`, '', t.apiIntro(BROWSER_PROTOCOL_VERSION), '', `## ${t.operations}`, ''];
  for (const [path, operations] of Object.entries(browserOpenApi.paths)) {
    for (const [method, raw] of Object.entries(operations as Record<string, Json>)) {
      const id = String(raw.operationId);
      const scope = SCOPES[id];
      if (scope === undefined) throw new Error(`scope inconnu pour ${id} : compléter SCOPES`);
      const text = locale === 'fr' ? (typeof raw.description === 'string' ? raw.description : OPERATIONS_EN[id]) : OPERATIONS_EN[id];
      if (!text) throw new Error(`description manquante pour ${id} (${locale}) : compléter OPERATIONS_EN`);
      const statuses = Object.keys((raw.responses ?? {}) as Json).sort();
      const colon = locale === 'fr' ? ' :' : ':';
      lines.push(`### \`${method.toUpperCase()} /v1${path}\``, '', text, '', `- ${t.scope}${colon} ${scope ? `\`${scope}\`` : t.none}`);
      lines.push(`- ${t.statuses}${colon} ${statuses.map((s) => `\`${s}\``).join(', ')}`, '');
    }
  }
  const create = (browserOpenApi.components.schemas as unknown as Record<string, Json>).CreateSessionRequest!;
  lines.push(`## ${t.createFields}`, '', t.createIntro, '', `| ${t.field} | ${t.type} |`, '|---|---|');
  for (const [name, schema] of Object.entries(create.properties as Record<string, Json>)) lines.push(`| \`${name}\` | ${cell(typeOf(schema))} |`);
  lines.push('', `## ${t.ws}`, '', t.wsIntro, '', `| ${t.endpoint} | ${t.role} |`, '|---|---|');
  for (const [endpoint, role] of t.wsRows) lines.push(`| ${endpoint} | ${role} |`);
  lines.push('', `## ${t.errors}`, '', t.errorsIntro, '', `| ${t.code} | ${t.status} |`, '|---|---|');
  for (const code of ERROR_CODES) lines.push(`| \`${code}\` | ${ERROR_STATUS[code]} |`);
  return `${lines.join('\n')}\n`;
}

function renderConfig(locale: DocLocale): string {
  const t = T[locale];
  const lines: string[] = [t.generated, '', `# ${t.configTitle}`, '', t.configIntro, ''];
  for (const group of BROWSER_ENV_GROUPS) {
    const variables = BROWSER_ENV_CATALOG.filter((v) => v.group === group);
    if (variables.length === 0) continue;
    lines.push(`## ${t.group(group)}`, '', `| ${t.variable} | ${t.default} | ${t.required} | ${t.secret} | ${t.description} |`, '|---|---|---|---|---|');
    for (const v of variables) {
      const description = t.describe(v.name);
      if (!description) throw new Error(`description anglaise manquante : ${v.name} (ENV_DESCRIPTIONS_EN)`);
      const fallback = v.defaultLabel ?? '—';
      const def = v.default === null || v.default === '' ? fallback : `\`${v.default}\``;
      const required = v.required.length === 0 ? '—' : v.required.map((m) => `\`${m}\``).join(', ');
      lines.push(`| \`${v.name}\` | ${cell(def)} | ${required} | ${v.secret ? t.yes : t.no} | ${cell(description)} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderReference(locale: DocLocale, page: ReferencePage): string {
  return page === 'reference/api.md' ? renderApi(locale) : renderConfig(locale);
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const docs = new URL('../docs/', import.meta.url).pathname;
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  for (const locale of ['fr', 'en'] as const) {
    for (const page of REFERENCE_PAGES) {
      const path = join(docs, locale, page);
      const content = renderReference(locale, page);
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        // absent : à écrire
      }
      if (current === content) continue;
      if (check) stale.push(`${locale}/${page}`);
      else writeFileSync(path, content);
    }
  }
  if (stale.length > 0) {
    console.error(`docs:reference : à régénérer (${stale.join(', ')}) avec \`pnpm --filter @sym-browser/module docs:reference\`.`);
    process.exit(1);
  }
  console.log(check ? 'docs:reference : référence à jour.' : 'docs:reference : référence écrite.');
}
