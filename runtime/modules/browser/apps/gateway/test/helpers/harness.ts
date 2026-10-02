// SPDX-License-Identifier: AGPL-3.0-only
// Banc des tests de l'API REST de la passerelle (tâche 2.2) : base PostgreSQL jetable et migrée, deux clients (A et B) avec
// leurs clés, un nœud prêt, et la passerelle assemblée sur des doublures des interfaces encore à brancher :
//   - Authenticator : le vrai, de la tâche 2.1 (`ApiKeyAuthenticator` sur `pgApiKeyStore`), clés argon2id créées par `newApiKey` ;
//   - ConnectTokenIssuer : jetons de test numérotés (jetons HMAC de la tâche 2.1) ;
//   - SessionLauncher : nœud simulé, qui écrit `running` comme le superviseur du nœud (tâche 1.2) le ferait.
// Chaque réponse est validée contre l'OpenAPI publiée (statut déclaré, corps conforme au schéma) : « 0 écart schéma/réponse ».
import { randomBytes } from 'node:crypto';
import { ApiKeyAuthenticator, newApiKey, type UsageClosure } from '@sym-browser/core';
import { insertApiKey, migrateUp, pgApiKeyStore, recordHeartbeat, transitionSession } from '@sym-browser/db';
import { browserOpenApi } from '@sym/contracts/browser';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';
import { createGatewayApi, type GatewayDeps, type Scope, type SessionLauncher } from '../../src/api/index.js';

const PUBLIC_URL = 'https://b.example.com';

type LauncherMode = 'ok' | 'fail' | 'hang';
type KeyName = 'a' | 'aRead' | 'b' | 'aAdmin' | 'bAdmin';

export type Harness = {
  app: FastifyInstance;
  pool: pg.Pool;
  tenantA: string;
  tenantB: string;
  keys: Record<KeyName, string>;
  /** `api_keys.id` de chaque clé. */
  keyIds: Record<KeyName, string>;
  launcher: { mode: LauncherMode; launched: string[]; released: string[] };
  call: (options: { method: InjectOptions['method']; url: string; key?: keyof Harness['keys'] | null; body?: unknown; headers?: Record<string, string> }) => Promise<Reply>;
  close: () => Promise<void>;
};

// Corps déjà validé contre l'OpenAPI par `call` : les tests le lisent librement.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; headers: Record<string, unknown>; body: any };

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Validation des réponses contre l'OpenAPI : chemin, méthode et statut déclarés, corps conforme. */
function responseChecker(): (method: string, url: string, status: number, body: unknown) => string | undefined {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  ajv.addFormat('date-time', { validate: (value: string) => !Number.isNaN(Date.parse(value)) && /T.*(Z|[+-]\d\d:\d\d)$/.test(value) });
  ajv.addSchema({ $id: 'https://sym.invalid/openapi.json', ...browserOpenApi });
  const cache = new Map<string, ValidateFunction>();
  const templates = Object.keys(browserOpenApi.paths).map((template) => ({
    template,
    pattern: new RegExp(`^/v1${template.replace(/\{[^}]+\}/g, '[^/]+')}$`),
  }));
  return (method, url, status, body) => {
    const path = url.split('?')[0] ?? '';
    const match = templates.find((t) => t.pattern.test(path));
    if (!match) return `chemin non déclaré : ${path}`;
    const operation = (browserOpenApi.paths as Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>>)[match.template]?.[method.toLowerCase()];
    if (!operation) return `opération non déclarée : ${method} ${match.template}`;
    const response = operation.responses[String(status)];
    if (!response) return `statut ${status} non déclaré pour ${method} ${match.template}`;
    const schema = response.content?.['application/json']?.schema;
    if (!schema) return undefined;
    const key = `${method} ${match.template} ${status}`;
    let validate = cache.get(key);
    if (!validate) {
      const pointer = `#/paths/${match.template.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
      validate = ajv.compile({ $ref: `https://sym.invalid/openapi.json${pointer}` });
      cache.set(key, validate);
    }
    return validate(body) ? undefined : `${key} : ${ajv.errorsText(validate.errors)}`;
  };
}

export async function createHarness(options: { queueTimeoutMs?: number; maxSessionSeconds?: number; usageWal?: () => Promise<UsageClosure[]> } = {}): Promise<Harness> {
  const name = `gw_${randomBytes(5).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = new URL(inject('pgAdminUrl'));
  url.pathname = `/${name}`;
  await migrateUp({ connectionString: url.toString() });
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });

  const one = async (sql: string, params: unknown[] = []): Promise<string> => (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';
  const tenantA = await one('INSERT INTO tenants (name, max_session_seconds) VALUES ($1, $2) RETURNING id', ['a', options.maxSessionSeconds ?? 3600]);
  const tenantB = await one("INSERT INTO tenants (name) VALUES ('b') RETURNING id");
  // Vraies clés d'API (tâche 2.1) : secret rendu une seule fois, seule l'empreinte argon2id est en base.
  const keys = {} as Record<KeyName, string>;
  const keyIds = {} as Record<KeyName, string>;
  const keyRow = async (name: KeyName, tenantId: string, scopes: Scope[]): Promise<void> => {
    const fresh = await newApiKey({ scopes });
    keys[name] = fresh.key.reveal();
    keyIds[name] = (await insertApiKey(pool, { tenantId, prefix: fresh.prefix, keyHash: fresh.keyHash, scopes: fresh.scopes, expiresAt: null })).id;
  };
  await keyRow('a', tenantA, ['sessions:write', 'sessions:read']);
  await keyRow('aRead', tenantA, ['sessions:read']);
  await keyRow('b', tenantB, ['sessions:write', 'sessions:read']);
  // Admins de client (scope `admin` seul) : usage de toutes les clés du client, réconciliation (tâche 2.6).
  await keyRow('aAdmin', tenantA, ['admin']);
  await keyRow('bAdmin', tenantB, ['admin']);

  await recordHeartbeat(pool, {
    nodeId: 'node-a',
    url: 'http://node-a.internal:3000',
    region: 'frankfurt',
    playwrightVersion: '1.63.0',
    chromiumVersion: '153.0.8010.12',
    appVersion: '0.0.0',
    slotsTotal: 64,
    slotsFree: 64,
    rssBytes: null,
    limitBytes: null,
  });

  const state = { mode: 'ok' as LauncherMode, launched: [] as string[], released: [] as string[] };
  const launcher: SessionLauncher = {
    async launch({ sessionId }) {
      state.launched.push(sessionId);
      if (state.mode === 'fail') return { ok: false, code: 'launch_failed' };
      if (state.mode === 'hang') return new Promise(() => undefined);
      const outcome = await transitionSession(pool, { sessionId, to: 'running', reason: null, nodeId: 'node-a' });
      return outcome.ok ? { ok: true } : { ok: false, code: 'launch_failed' };
    },
    async release(sessionId) {
      // Le nœud simulé détruit la session puis écrit l'état final (ordre de 04c § 3.2), comme le superviseur de la 1.2.
      const outcome = await transitionSession(pool, { sessionId, to: 'ended', reason: 'released' });
      if (!outcome.ok) return 'not_held';
      state.released.push(sessionId);
      return 'released';
    },
    async extend() {
      return 'not_held';
    },
  };

  let tokenCounter = 0;
  const deps: GatewayDeps = {
    db: pool,
    auth: new ApiKeyAuthenticator(pgApiKeyStore(pool)),
    tokens: { issue: ({ protocol }) => `tok_${protocol}_${++tokenCounter}` },
    launcher,
    publicUrl: PUBLIC_URL,
    queueTimeoutMs: options.queueTimeoutMs ?? 2_000,
    ...(options.usageWal === undefined ? {} : { usageWal: options.usageWal }),
  };
  const app = await createGatewayApi(deps);
  await app.ready();

  const check = responseChecker();
  const call: Harness['call'] = async ({ method, url, key = 'a', body, headers = {} }) => {
    const res = await app.inject({
      method,
      url,
      headers: { ...(key ? { authorization: `Bearer ${keys[key]}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { payload: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const parsed = res.headers['content-type']?.toString().includes('application/json') ? res.json() : res.body;
    const problem = check(method ?? 'GET', url, res.statusCode, parsed);
    if (problem) throw new Error(`écart schéma/réponse : ${problem}\n${JSON.stringify(parsed)}`);
    return { status: res.statusCode, headers: res.headers, body: parsed };
  };

  return {
    app,
    pool,
    tenantA,
    tenantB,
    keys,
    keyIds,
    launcher: state,
    call,
    close: async () => {
      await app.close();
      await pool.end();
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name}`));
    },
  };
}
