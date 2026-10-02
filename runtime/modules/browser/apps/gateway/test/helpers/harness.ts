// SPDX-License-Identifier: AGPL-3.0-only
// Banc des tests de l'API REST de la passerelle (tâche 2.2) : base PostgreSQL jetable et migrée, deux clients (A et B) avec
// leurs clés, un nœud prêt, et la passerelle assemblée sur les implémentations réelles de la tâche 2.1 :
//   - clés d'API générées par `newApiKey` (argon2id), insérées par `insertApiKey`, vérifiées par `ApiKeyAuthenticator`
//     sur `pgApiKeyStore` ;
//   - jetons de connexion `ConnectTokens` sous une MASTER_KEY jetable ;
// et une seule doublure : SessionLauncher, nœud simulé qui écrit `running` comme le superviseur du nœud (tâche 1.2).
// Quotas (tâche 2.4) : sessions simultanées des clients A et B à 1 000 sauf demande, file et nœuds réglables ; le nœud
// simulé écrit `running` sur le nœud choisi par l'admission.
// Chaque réponse est validée contre l'OpenAPI publiée (statut déclaré, corps conforme au schéma) : « 0 écart schéma/réponse ».
import { randomBytes } from 'node:crypto';
import { ApiKeyAuthenticator, ConnectTokens, generateMasterKey, MasterKey, newApiKey } from '@sym-browser/core';
import { insertApiKey, migrateUp, pgApiKeyStore, recordHeartbeat, transitionSession } from '@sym-browser/db';
import { browserOpenApi } from '@sym/contracts/browser';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';
import { createGatewayApi, type GatewayDeps, type LaunchRequest, type Scope, type SessionLauncher } from '../../src/api/index.js';

const PUBLIC_URL = 'https://b.example.com';

type LauncherMode = 'ok' | 'fail' | 'hang';

export type Harness = {
  app: FastifyInstance;
  pool: pg.Pool;
  tenantA: string;
  tenantB: string;
  keys: Record<'a' | 'aRead' | 'b', string>;
  launcher: { mode: LauncherMode; launched: string[]; released: string[]; nodes: Map<string, string>; requests: Map<string, LaunchRequest> };
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

export type HarnessNode = { id: string; region: string; slotsTotal: number };

export type HarnessOptions = {
  queueTimeoutMs?: number;
  maxSessionSeconds?: number;
  maxConcurrentSessions?: number;
  queue?: GatewayDeps['queue'];
  /** Nœuds enregistrés (tâche 2.4) ; défaut : un nœud `node-a` à Francfort. */
  nodes?: HarnessNode[];
  /** URL privée du premier nœud enregistré (relais WSS, tâche 2.3) ; défaut : nœud fictif injoignable. */
  nodeUrl?: string;
  /** Jetons de connexion réels (HMAC) au lieu des jetons de test numérotés. */
  tokens?: GatewayDeps['tokens'];
  /** Relais WSS `/playwright` et `/cdp` (tâche 2.3). */
  relay?: GatewayDeps['relay'];
};

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const name = `gw_${randomBytes(5).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = new URL(inject('pgAdminUrl'));
  url.pathname = `/${name}`;
  await migrateUp({ connectionString: url.toString() });
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });

  const one = async (sql: string, params: unknown[] = []): Promise<string> => (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';
  const tenantA = await one('INSERT INTO tenants (name, max_session_seconds, max_concurrent_sessions) VALUES ($1, $2, $3) RETURNING id', ['a', options.maxSessionSeconds ?? 3600, options.maxConcurrentSessions ?? 1000]);
  const tenantB = await one("INSERT INTO tenants (name, max_concurrent_sessions) VALUES ('b', 1000) RETURNING id");
  /** Clé réelle (argon2id) : la valeur en clair n'existe que dans ce banc, jamais en base. */
  const apiKey = async (tenantId: string, scopes: Scope[]): Promise<string> => {
    const created = await newApiKey({ scopes });
    await insertApiKey(pool, { tenantId, prefix: created.prefix, keyHash: created.keyHash, scopes: created.scopes, expiresAt: null });
    return created.key.reveal();
  };
  const keys = {
    a: await apiKey(tenantA, ['sessions:write', 'sessions:read']),
    aRead: await apiKey(tenantA, ['sessions:read']),
    b: await apiKey(tenantB, ['sessions:write', 'sessions:read']),
  };

  for (const [index, n] of (options.nodes ?? [{ id: 'node-a', region: 'frankfurt', slotsTotal: 4096 }]).entries()) {
    await recordHeartbeat(pool, {
      nodeId: n.id,
      url: index === 0 && options.nodeUrl !== undefined ? options.nodeUrl : `http://${n.id}.internal:3000`,
      region: n.region,
      playwrightVersion: '1.63.0',
      chromiumVersion: '153.0.8010.12',
      appVersion: '0.0.0',
      slotsTotal: n.slotsTotal,
      slotsFree: n.slotsTotal,
      rssBytes: null,
      limitBytes: null,
    });
  }

  const state = { mode: 'ok' as LauncherMode, launched: [] as string[], released: [] as string[], nodes: new Map<string, string>(), requests: new Map<string, LaunchRequest>() };
  const launcher: SessionLauncher = {
    async launch(request) {
      const { sessionId } = request;
      state.launched.push(sessionId);
      state.nodes.set(sessionId, request.nodeId);
      state.requests.set(sessionId, request);
      if (state.mode === 'fail') return { ok: false, code: 'launch_failed' };
      if (state.mode === 'hang') return new Promise(() => undefined);
      const outcome = await transitionSession(pool, { sessionId, to: 'running', reason: null, nodeId: request.nodeId });
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

  const deps: GatewayDeps = {
    db: pool,
    auth: new ApiKeyAuthenticator(pgApiKeyStore(pool)),
    tokens: options.tokens ?? new ConnectTokens({ current: MasterKey.parse(generateMasterKey()) }),
    ...(options.relay === undefined ? {} : { relay: options.relay }),
    launcher,
    publicUrl: PUBLIC_URL,
    queueTimeoutMs: options.queueTimeoutMs ?? 2_000,
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    queuePollMs: 25,
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
    launcher: state,
    call,
    close: async () => {
      await app.close();
      await pool.end();
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name}`));
    },
  };
}
