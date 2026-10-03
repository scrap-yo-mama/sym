// SPDX-License-Identifier: AGPL-3.0-only
// Réglages d'instance de l'admin (tâche 3.1, 05 § 4.2, 08 § 1, § 2, § 7) : modèles IA, proxys, relais SMTP, avec leurs
// boutons « Tester ». Session d'interface seulement, permission `settings:*:write` (admin et owner, 13 § 2) ; jamais une
// clé d'API (13 § 8). Les secrets sont en ÉCRITURE SEULE (INV8) : chiffrés dans `secrets` avant toute écriture, jamais
// relus ni renvoyés ; un secret absent d'une écriture est conservé, un secret fourni le remplace (l'ancien est supprimé).
// Un secret est LIÉ À SA DESTINATION : si la `base_url` (LLM), l'URL du proxy ou l'hôte et le port SMTP changent, il est
// exigé dans la même requête (400 `api_key_required`, `credentials_required`, `password_required`), jamais réutilisé.
// Tout test sort par la garde SSRF en politique `operator-config` (08b § 1) et ne contacte que la cible réglée (INV9).
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { Secret } from '@runtime/core';
import { createOperatorConfigDispatcher, findSsrfBlocked, operatorConfigFetch, parseProxyDefinitions } from '@runtime/core/net';
import { AlertConfigError, saveSmtpSettings, testSmtp, type SecretStore, type SmtpSettings } from '@runtime/db';
import { KNOWN_PRICES, LlmError, OpenAICompatTransport, probeCapabilities } from '@runtime/llm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.js';
import { reasonMessage } from '../rest/shared.js';
import { readValidatedModels } from '../validated-models.js';
import { iso, UUID } from './account-helpers.js';
import { audit, notFound, sendError } from './guard.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readSetting<T>(ctx: ServerContext, key: string): Promise<T | null> {
  const { rows } = await ctx.pool.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function writeSetting(ctx: ServerContext, key: string, value: unknown): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/**
 * Lecture puis écriture conditionnelle d'un réglage : l'écriture n'a lieu que si la valeur n'a pas changé depuis la
 * relecture (comparaison jsonb) ; une écriture concurrente l'emporte. `undefined` : rien n'est écrit.
 */
async function updateSetting<T>(ctx: ServerContext, key: string, update: (current: T | null) => T | undefined): Promise<void> {
  const current = await readSetting<T>(ctx, key);
  const next = update(current);
  if (next === undefined || current === null) return;
  await ctx.pool.query('UPDATE settings SET value = $2::jsonb, updated_at = now() WHERE key = $1 AND value = $3::jsonb', [key, JSON.stringify(next), JSON.stringify(current)]);
}

async function deleteInstanceSecrets(ctx: ServerContext, ids: readonly (string | null | undefined)[]): Promise<void> {
  const list = ids.filter((id): id is string => typeof id === 'string');
  if (list.length > 0) await ctx.pool.query('DELETE FROM secrets WHERE id = ANY($1::uuid[]) AND owner_id IS NULL', [list]);
}

/** Secrets illisibles (« À ressaisir », 06 § 4.2 `secret_unreadable`). */
async function unreadable(ctx: ServerContext, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await ctx.pool.query<{ id: string }>("SELECT id FROM secrets WHERE id = ANY($1::uuid[]) AND owner_id IS NULL AND state = 'unreadable'", [ids]);
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------------------------------------------
// Modèles IA (`settings.llm`, 08 § 7)
// ---------------------------------------------------------------------------------------------------------------

type StoredProvider = {
  id: string;
  preset: string;
  base_url: string;
  timeout_ms?: number;
  max_retries?: number;
  models?: Record<string, Record<string, unknown>>;
  api_key_secret_id: string;
  headers_secret_id?: string;
};
type StoredLlm = { providers: StoredProvider[]; roles?: Record<string, unknown>; redact?: unknown; log_prompts?: unknown };

const PRESETS = ['zai', 'openrouter', 'vllm', 'ollama', 'deepseek', 'qwen', 'openai', 'custom'];
const ROLE_NAMES = ['investigate', 'repair', 'extract', 'agent'];
const roleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'model'],
  properties: {
    provider: { type: 'string', maxLength: 32 },
    model: { type: 'string', maxLength: 200 },
    fallback: { type: ['object', 'null'], additionalProperties: false, required: ['provider', 'model'], properties: { provider: { type: 'string', maxLength: 32 }, model: { type: 'string', maxLength: 200 } } },
    provider_routing: { type: 'object' },
  },
} as const;
const llmWriteSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['providers'],
  properties: {
    providers: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'preset', 'base_url'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' },
          preset: { type: 'string', enum: PRESETS },
          base_url: { type: 'string', minLength: 1, maxLength: 2048 },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
          max_retries: { type: 'integer', minimum: 0, maximum: 3 },
          models: { type: 'object', maxProperties: 50, additionalProperties: { type: 'object', additionalProperties: false, properties: { profile: { type: ['object', 'null'] }, price: { type: ['object', 'null'] }, extra_body: { type: 'object' } } } },
          api_key: { type: 'string', minLength: 1, maxLength: 4096 },
          headers: { type: 'object', maxProperties: 20, additionalProperties: { type: 'string', maxLength: 4096 } },
        },
      },
    },
    roles: { type: 'object', additionalProperties: false, properties: Object.fromEntries(ROLE_NAMES.map((r) => [r, roleSchema])) },
    redact: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' }, patterns: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 } } } },
    log_prompts: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' }, retention_days: { type: 'integer', minimum: 1, maximum: 365 } } },
  },
} as const;

type LlmWrite = {
  providers: (Omit<StoredProvider, 'api_key_secret_id' | 'headers_secret_id'> & { api_key?: string; headers?: Record<string, string> })[];
  roles?: Record<string, { provider: string; model: string; fallback?: { provider: string; model: string } | null }>;
  redact?: unknown;
  log_prompts?: unknown;
};

/** URL d'un fournisseur ou d'un proxy : http(s) sans identifiants ni fragment. */
function plainUrl(raw: string, schemes = ['http:', 'https:']): URL | null {
  try {
    const url = new URL(raw);
    return schemes.includes(url.protocol) && url.username === '' && url.password === '' && url.hash === '' ? url : null;
  } catch {
    return null;
  }
}

/** Même destination : URL normalisée identique (schéma, hôte, port, chemin ; barre finale ignorée). */
function sameDestination(a: string, b: string): boolean {
  const x = plainUrl(a);
  const y = plainUrl(b);
  return x !== null && y !== null && x.href.replace(/\/+$/, '') === y.href.replace(/\/+$/, '');
}

async function llmView(ctx: ServerContext) {
  const stored = (await readSetting<StoredLlm>(ctx, 'llm')) ?? { providers: [] };
  const bad = await unreadable(ctx, stored.providers.flatMap((p) => [p.api_key_secret_id, p.headers_secret_id ?? null].filter((v): v is string => typeof v === 'string' && UUID.test(v))));
  return {
    ...(stored.roles ? { roles: stored.roles } : {}),
    ...(isRecord(stored.redact) ? { redact: stored.redact } : {}),
    ...(isRecord(stored.log_prompts) ? { log_prompts: stored.log_prompts } : {}),
    providers: stored.providers.map((p) => ({
      id: p.id,
      preset: p.preset,
      base_url: p.base_url,
      ...(p.timeout_ms === undefined ? {} : { timeout_ms: p.timeout_ms }),
      ...(p.max_retries === undefined ? {} : { max_retries: p.max_retries }),
      // Profil relevé servi sans sa date de sonde (gardée pour le client LLM).
      models: Object.fromEntries(Object.entries(p.models ?? {}).map(([id, m]) => [id, isRecord(m['profile']) ? { ...m, profile: Object.fromEntries(Object.entries(m['profile']).filter(([k]) => k !== 'probed_at')) } : m])),
      api_key_set: typeof p.api_key_secret_id === 'string',
      headers_set: typeof p.headers_secret_id === 'string',
      api_key_unreadable: bad.has(p.api_key_secret_id),
    })),
    // Statut « modèle validé » du banc (15 § 11), lecture seule : dernière mesure N2 de chaque modèle.
    validated_models: readValidatedModels(ctx.validatedModelsFile),
    // Prix connus (UX-11), lecture seule : pré-remplissent le prix d'un modèle reconnu par son nom ; `price` du réglage fait foi.
    known_prices: KNOWN_PRICES.map((entry) => ({ ...entry, price: entry.price === null ? null : { ...entry.price } })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Proxys (`settings.proxies`, 08 § 2) : forme de `parseProxyDefinition` + libellé, paramètres, date du dernier test
// ---------------------------------------------------------------------------------------------------------------

type StoredProxy = {
  id: string;
  label: string;
  type: 'dc' | 'res';
  url: string;
  credentials_secret_id?: string;
  username_set?: boolean;
  password_set?: boolean;
  username_template?: string;
  params?: Record<string, string>;
  price?: { per_gb_usd?: number | null; per_request_usd?: number | null };
  tested_at?: string | null;
};

const proxyView = (p: StoredProxy) => ({
  id: p.id,
  label: p.label,
  type: p.type,
  url: p.url,
  username_set: p.username_set === true,
  password_set: p.password_set === true,
  params: p.params ?? {},
  username_template: p.username_template ?? null,
  price: { per_gb_usd: p.price?.per_gb_usd ?? null, per_request_usd: p.price?.per_request_usd ?? null },
  tested_at: p.tested_at ?? null,
});

const proxyFields = {
  label: { type: 'string', minLength: 1, maxLength: 100 },
  url: { type: 'string', minLength: 1, maxLength: 2048 },
  username: { type: 'string', minLength: 1, maxLength: 1024 },
  password: { type: 'string', minLength: 1, maxLength: 1024 },
  params: { type: 'object', maxProperties: 20, additionalProperties: { type: 'string', maxLength: 200 } },
  username_template: { type: ['string', 'null'], maxLength: 512 },
  price: { type: 'object', additionalProperties: false, properties: { per_gb_usd: { type: ['number', 'null'], minimum: 0 }, per_request_usd: { type: ['number', 'null'], minimum: 0 } } },
} as const;

type ProxyBody = { label?: string; type?: 'dc' | 'res'; url?: string; username?: string; password?: string; params?: Record<string, string>; username_template?: string | null; price?: { per_gb_usd?: number | null; per_request_usd?: number | null } };

// ---------------------------------------------------------------------------------------------------------------

export function settingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const store = (reply: FastifyReply): SecretStore | null => {
    if (ctx.secrets === null) {
      void sendError(reply, 503, 'not_ready', 'instance en cours de démarrage');
      return null;
    }
    return ctx.secrets;
  };

  // ——— Modèles IA ———
  app.get('/api/settings/llm', async () => llmView(ctx));

  app.put<{ Body: LlmWrite }>('/api/settings/llm', { schema: { body: llmWriteSchema } }, async (request, reply) => {
    const actor = request.actor!;
    const secrets = store(reply);
    if (secrets === null) return reply;
    const body = request.body;
    const ids = body.providers.map((p) => p.id);
    if (new Set(ids).size !== ids.length) return sendError(reply, 400, 'invalid_llm_settings', 'identifiants de fournisseurs en double');
    if (body.providers.some((p) => plainUrl(p.base_url) === null)) return sendError(reply, 400, 'invalid_llm_settings', 'base_url : URL http(s) sans identifiants');
    for (const [role, target] of Object.entries(body.roles ?? {})) {
      for (const t of [target, target.fallback ?? null]) {
        if (t !== null && !ids.includes(t.provider)) return sendError(reply, 400, 'invalid_llm_settings', `rôle ${role} : fournisseur ${t.provider} inconnu`);
      }
    }
    // Écritures SÉRIALISÉES (verrou consultatif de transaction sur `llm`, ligne relue sous FOR UPDATE) : deux PUT
    // concurrents se suivent, le second part de l'état écrit par le premier. Sans cela, A (clé k0 remplacée par kA)
    // supprimerait k0 pendant que B, parti de l'état d'avant, réécrirait un réglage qui pointe vers k0 (« clé illisible »,
    // runs en échec). Les secrets abandonnés ne sont supprimés qu'avec l'écriture, au même COMMIT ; une écriture refusée
    // ou en échec supprime les secrets qu'elle venait de créer.
    class Refused extends Error {
      readonly code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
      }
    }
    const created: string[] = [];
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('runtime.settings.llm'))");
      const previous = (await client.query<{ value: StoredLlm }>("SELECT value FROM settings WHERE key = 'llm' FOR UPDATE")).rows[0]?.value ?? { providers: [] };
      const before = new Map(previous.providers.map((p) => [p.id, p]));
      // Un secret est lié à sa destination : une clé gardée ne part jamais vers une autre `base_url` que celle pour laquelle
      // elle a été saisie (INV8 : un admin ne la ferait pas sortir par « Tester » vers un serveur à lui). Destination
      // changée → la clé est exigée dans la même requête ; les en-têtes secrets d'avant sont abandonnés (à ressaisir).
      const moved = (p: LlmWrite['providers'][number]) => {
        const old = before.get(p.id);
        return old !== undefined && !sameDestination(old.base_url, p.base_url);
      };
      const missingKey = body.providers.find((p) => p.api_key === undefined && (!before.get(p.id)?.api_key_secret_id || moved(p)));
      if (missingKey) {
        throw new Refused('api_key_required', moved(missingKey) ? `fournisseur ${missingKey.id} : base_url changée, ressaisissez la clé d'API` : `fournisseur ${missingKey.id} : clé d'API requise`);
      }
      const put = async (kind: string, label: string, value: string) => {
        const id = await secrets.put({ ownerId: null, kind, label, value });
        created.push(id);
        return id;
      };
      const providers: StoredProvider[] = [];
      const dropped: (string | undefined)[] = [];
      for (const p of body.providers) {
        const old = before.get(p.id);
        let keyId = old?.api_key_secret_id;
        if (p.api_key !== undefined) {
          keyId = await put('llm_api_key', `llm ${p.id}`, p.api_key);
          dropped.push(old?.api_key_secret_id);
        }
        let headersId = old?.headers_secret_id;
        if (p.headers === undefined && moved(p) && headersId !== undefined) {
          headersId = undefined;
          dropped.push(old?.headers_secret_id);
        }
        if (p.headers !== undefined) {
          headersId = Object.keys(p.headers).length === 0 ? undefined : await put('llm_headers', `llm ${p.id} headers`, JSON.stringify(p.headers));
          dropped.push(old?.headers_secret_id);
        }
        providers.push({
          id: p.id,
          preset: p.preset,
          base_url: p.base_url,
          ...(p.timeout_ms === undefined ? {} : { timeout_ms: p.timeout_ms }),
          ...(p.max_retries === undefined ? {} : { max_retries: p.max_retries }),
          models: p.models ?? old?.models ?? {},
          api_key_secret_id: keyId!,
          ...(headersId === undefined ? {} : { headers_secret_id: headersId }),
        });
      }
      for (const old of previous.providers) if (!ids.includes(old.id)) dropped.push(old.api_key_secret_id, old.headers_secret_id);
      const value = {
        providers,
        ...(body.roles ? { roles: Object.fromEntries(Object.entries(body.roles).map(([k, v]) => [k, { provider: v.provider, model: v.model, ...(v.fallback ? { fallback: v.fallback } : {}) }])) } : {}),
        ...(body.redact === undefined ? {} : { redact: body.redact }),
        ...(body.log_prompts === undefined ? {} : { log_prompts: body.log_prompts }),
      };
      await client.query(`INSERT INTO settings (key, value) VALUES ('llm', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(value)]);
      const gone = dropped.filter((id): id is string => typeof id === 'string');
      if (gone.length > 0) await client.query('DELETE FROM secrets WHERE id = ANY($1::uuid[]) AND owner_id IS NULL', [gone]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      await deleteInstanceSecrets(ctx, created);
      if (error instanceof Refused) return sendError(reply, 400, error.code, error.message);
      throw error;
    } finally {
      client.release();
    }
    await audit(ctx, request, actor, { action: 'settings.llm.updated', targetType: 'settings', targetId: 'llm', outcome: 'success', meta: { providers: ids } });
    return llmView(ctx);
  });

  app.post<{ Body: { provider: string; model: string } }>(
    '/api/settings/llm/test',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['provider', 'model'], properties: { provider: { type: 'string', maxLength: 32 }, model: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      const secrets = store(reply);
      if (secrets === null) return reply;
      const stored = (await readSetting<StoredLlm>(ctx, 'llm')) ?? { providers: [] };
      const provider = stored.providers.find((p) => p.id === request.body.provider);
      if (!provider) return notFound(reply);
      const testedAt = new Date().toISOString();
      let result: { ok: boolean; tested_at: string; error: ReturnType<typeof reasonMessage>; profile: Record<string, unknown> | null };
      try {
        const dispatcher = createOperatorConfigDispatcher(ctx.guard, ctx.extraCa ? { ca: ctx.extraCa } : {});
        const headers = provider.headers_secret_id ? (JSON.parse((await secrets.get(provider.headers_secret_id)).reveal()) as Record<string, string>) : undefined;
        const transport = new OpenAICompatTransport({
          baseUrl: provider.base_url,
          apiKey: await secrets.get(provider.api_key_secret_id),
          ...(headers ? { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, new Secret(v)])) } : {}),
          timeoutMs: Math.min(provider.timeout_ms ?? 30_000, 60_000),
          fetch: ((input: string | URL | Request, init?: RequestInit) => operatorConfigFetch(input instanceof Request ? input.url : input, (init ?? {}) as never, dispatcher)) as unknown as typeof fetch,
        });
        // Sonde de 08 § 1 : quelques appels minuscules au seul fournisseur réglé (INV9).
        const p = await probeCapabilities(transport, request.body.model);
        const profile = {
          tools: p.tools,
          tool_choice: p.tool_choice,
          structured: p.structured,
          stream_tools: p.stream_tools ?? false,
          stream_usage: p.stream_usage ?? false,
          cache: p.cache,
          reasoning_field: p.reasoning_field,
          ...(p.sampling ? { sampling: p.sampling } : {}),
        };
        // Profil relevé gardé sur le modèle (le client LLM l'applique : paramètres refusés jamais envoyés).
        // Relu après la sonde (jusqu'à 60 s) et écrit sous condition : un PUT concurrent n'est jamais écrasé, et le profil
        // n'est gardé que si le fournisseur vise toujours la destination sondée avec la même clé.
        await updateSetting<StoredLlm>(ctx, 'llm', (current) => {
          const now = current?.providers.find((x) => x.id === provider.id);
          if (current === null || now === undefined || now.base_url !== provider.base_url || now.api_key_secret_id !== provider.api_key_secret_id) return undefined;
          const models = { ...(now.models ?? {}) };
          models[request.body.model] = { ...(models[request.body.model] ?? {}), profile: { ...profile, probed_at: p.probed_at } };
          return { ...current, providers: current.providers.map((x) => (x.id === provider.id ? { ...x, models } : x)) };
        });
        result = { ok: true, tested_at: testedAt, error: null, profile };
      } catch (error) {
        const code = error instanceof LlmError ? `llm_${error.class}` : findSsrfBlocked(error) ? 'ssrf_blocked' : 'llm_network';
        result = { ok: false, tested_at: testedAt, error: reasonMessage(code), profile: null };
      }
      await audit(ctx, request, actor, { action: 'settings.llm.tested', targetType: 'settings', targetId: 'llm', outcome: result.ok ? 'success' : 'error', meta: { provider: provider.id } });
      return result;
    },
  );

  // ——— Proxys ———
  const proxies = async () => (await readSetting<StoredProxy[]>(ctx, 'proxies')) ?? [];

  app.get('/api/settings/proxies', async () => ({ proxies: (await proxies()).map(proxyView) }));

  /** Écrit un proxy après contrôle par le cœur (`parseProxyDefinition` : schéma, aucune identité dans l'URL, gabarit). */
  const saveProxy = async (reply: FastifyReply, secrets: SecretStore, current: StoredProxy | null, body: ProxyBody & { type: 'dc' | 'res'; label: string; url: string }): Promise<{ proxy: StoredProxy } | { sent: FastifyReply }> => {
    const url = plainUrl(body.url, ['http:', 'https:', 'socks5:']);
    if (url === null || (url.pathname !== '' && url.pathname !== '/') || url.search !== '') return { sent: await sendError(reply, 400, 'invalid_proxy', 'url : http, https ou socks5, hôte et port seulement, sans identifiants') };
    const id = current?.id ?? randomUUID();
    // Identifiants liés à leur proxy (INV8) : une URL changée (schéma, hôte ou port) sans identifiants ressaisis est
    // refusée, jamais servie avec les identifiants de l'ancien proxy.
    if (current?.credentials_secret_id !== undefined && body.username === undefined && body.password === undefined && `${url.protocol}//${url.host}` !== current.url) {
      return { sent: await sendError(reply, 400, 'credentials_required', 'url changée : ressaisissez username et password de ce proxy') };
    }
    let credentialsId = current?.credentials_secret_id;
    let usernameSet = current?.username_set === true;
    let passwordSet = current?.password_set === true;
    const dropped: (string | undefined)[] = [];
    if (body.username !== undefined || body.password !== undefined) {
      if (body.username === undefined || body.password === undefined) return { sent: await sendError(reply, 400, 'invalid_proxy', 'username et password vont ensemble') };
      credentialsId = await secrets.put({ ownerId: null, kind: 'proxy', label: `proxy ${body.label}`, value: JSON.stringify({ username: body.username, password: body.password }) });
      dropped.push(current?.credentials_secret_id);
      usernameSet = true;
      passwordSet = true;
    }
    const next: StoredProxy = {
      id,
      label: body.label,
      type: body.type,
      url: `${url.protocol}//${url.host}`,
      ...(credentialsId === undefined ? {} : { credentials_secret_id: credentialsId }),
      username_set: usernameSet,
      password_set: passwordSet,
      ...(body.username_template ? { username_template: body.username_template } : {}),
      params: body.params ?? {},
      price: { per_gb_usd: body.price?.per_gb_usd ?? 0, per_request_usd: body.price?.per_request_usd ?? 0 },
      tested_at: current?.tested_at ?? null,
    };
    const list = (await proxies()).filter((p) => p.id !== id);
    list.push(next);
    try {
      parseProxyDefinitions(list);
    } catch (error) {
      await deleteInstanceSecrets(ctx, credentialsId !== current?.credentials_secret_id ? [credentialsId] : []);
      return { sent: await sendError(reply, 400, 'invalid_proxy', (error as Error).message) };
    }
    await writeSetting(ctx, 'proxies', list);
    await deleteInstanceSecrets(ctx, dropped);
    return { proxy: next };
  };

  app.post<{ Body: ProxyBody & { type: 'dc' | 'res'; label: string; url: string } }>(
    '/api/settings/proxies',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['label', 'type', 'url'], properties: { ...proxyFields, type: { type: 'string', enum: ['dc', 'res'] } } } } },
    async (request, reply) => {
      const secrets = store(reply);
      if (secrets === null) return reply;
      const saved = await saveProxy(reply, secrets, null, request.body);
      if ('sent' in saved) return saved.sent;
      await audit(ctx, request, request.actor!, { action: 'settings.proxy.created', targetType: 'proxy', targetId: saved.proxy.id, outcome: 'success' });
      return reply.code(201).send(proxyView(saved.proxy));
    },
  );

  const findProxy = async (id: string) => (UUID.test(id) || /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) ? ((await proxies()).find((p) => p.id === id) ?? null) : null);

  app.get<{ Params: { id: string } }>('/api/settings/proxies/:id', async (request, reply) => {
    const p = await findProxy(request.params.id);
    return p === null ? notFound(reply) : proxyView(p);
  });

  app.patch<{ Params: { id: string }; Body: ProxyBody }>(
    '/api/settings/proxies/:id',
    { schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: proxyFields } } },
    async (request, reply) => {
      const current = await findProxy(request.params.id);
      if (current === null) return notFound(reply);
      const secrets = store(reply);
      if (secrets === null) return reply;
      const b = request.body;
      const saved = await saveProxy(reply, secrets, current, {
        ...b,
        type: current.type,
        label: b.label ?? current.label,
        url: b.url ?? current.url,
        params: b.params ?? current.params ?? {},
        username_template: b.username_template === undefined ? (current.username_template ?? null) : b.username_template,
        price: b.price ?? current.price ?? {},
      });
      if ('sent' in saved) return saved.sent;
      await audit(ctx, request, request.actor!, { action: 'settings.proxy.updated', targetType: 'proxy', targetId: saved.proxy.id, outcome: 'success', meta: { fields: Object.keys(b).filter((k) => k !== 'password' && k !== 'username') } });
      return proxyView(saved.proxy);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/settings/proxies/:id', async (request, reply) => {
    const current = await findProxy(request.params.id);
    if (current === null) return notFound(reply);
    // Un proxy choisi par une API (politique réseau) ne disparaît pas sous elle : 409.
    const { rowCount } = await ctx.pool.query("SELECT 1 FROM apis WHERE network_policy -> 'proxy_ids' ->> 'dc_proxy' = $1 OR network_policy -> 'proxy_ids' ->> 'res_proxy' = $1 LIMIT 1", [current.id]);
    if (rowCount) return sendError(reply, 409, 'proxy_in_use', 'ce proxy est choisi par au moins une API : retirez-le de leur politique réseau d’abord');
    await writeSetting(ctx, 'proxies', (await proxies()).filter((p) => p.id !== current.id));
    await deleteInstanceSecrets(ctx, [current.credentials_secret_id]);
    await audit(ctx, request, request.actor!, { action: 'settings.proxy.deleted', targetType: 'proxy', targetId: current.id, outcome: 'success' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/settings/proxies/:id/test', async (request, reply) => {
    const current = await findProxy(request.params.id);
    if (current === null) return notFound(reply);
    const url = new URL(current.url);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'socks5:' ? 1080 : 80));
    const testedAt = new Date().toISOString();
    let error: string | null = null;
    try {
      // Joignabilité du proxy (TCP, garde `operator-config`) : aucune requête vers un service tiers d'écho d'IP (INV9) ;
      // l'IP et le pays de sortie ne sont donc pas relevés (null).
      const target = await ctx.guard.resolveOperatorConfig(url.hostname.replace(/^\[|\]$/g, ''), port);
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: target.address, port, family: target.family });
        socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
        socket.once('connect', () => {
          socket.end();
          resolve();
        });
        socket.once('error', reject);
      });
    } catch (failure) {
      error = findSsrfBlocked(failure) ? 'ssrf_blocked' : 'proxy_unreachable';
    }
    if (error === null) await writeSetting(ctx, 'proxies', (await proxies()).map((p) => (p.id === current.id ? { ...p, tested_at: testedAt } : p)));
    await audit(ctx, request, request.actor!, { action: 'settings.proxy.tested', targetType: 'proxy', targetId: current.id, outcome: error === null ? 'success' : 'error' });
    return { ok: error === null, tested_at: testedAt, error: reasonMessage(error), exit_ip: null, exit_country: null };
  });

  // ——— SMTP ———
  const smtpView = (s: SmtpSettings | null) =>
    s === null ? null : { host: s.host, port: s.port, security: s.security, from: s.from, username_set: s.username !== null, password_set: s.password_secret_id !== null, tested_at: iso(s.tested_at ? new Date(s.tested_at) : null) };

  app.get('/api/settings/smtp', async () => smtpView(await readSetting<SmtpSettings>(ctx, 'smtp')));

  app.put<{ Body: { host: string; port: number; security: 'tls' | 'starttls' | 'none'; from: string; username?: string; password?: string } }>(
    '/api/settings/smtp',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['host', 'port', 'security', 'from'],
          properties: {
            host: { type: 'string', minLength: 1, maxLength: 255 },
            port: { type: 'integer', minimum: 1, maximum: 65535 },
            security: { type: 'string', enum: ['tls', 'starttls', 'none'] },
            from: { type: 'string', minLength: 3, maxLength: 254 },
            username: { type: 'string', minLength: 1, maxLength: 1024 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = request.actor!;
      const secrets = store(reply);
      if (secrets === null) return reply;
      try {
        // Auteur du changement (INV5) : un relais réglé par un admin suspend 24 h les liens de réinitialisation sans 2FA.
        const saved = await saveSmtpSettings(ctx.pool, secrets, { ...request.body, keepPassword: true }, { userId: actor.userId, role: actor.role === 'owner' ? 'owner' : 'admin' });
        await audit(ctx, request, actor, { action: 'settings.smtp.updated', targetType: 'settings', targetId: 'smtp', outcome: 'success', meta: { host: saved.host } });
        return smtpView(saved);
      } catch (error) {
        if (error instanceof AlertConfigError) return sendError(reply, 400, error.code, error.message);
        throw error;
      }
    },
  );

  app.post<{ Body: { to: string } }>(
    '/api/settings/smtp/test',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['to'], properties: { to: { type: 'string', minLength: 3, maxLength: 254 } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      const secrets = store(reply);
      if (secrets === null) return reply;
      const result = await testSmtp({ pool: ctx.pool, queue: await ctx.jobs(), store: secrets, guard: ctx.guard, ...(ctx.extraCa ? { smtpCa: ctx.extraCa } : {}) }, request.body.to);
      await audit(ctx, request, actor, { action: 'settings.smtp.tested', targetType: 'settings', targetId: 'smtp', outcome: result.ok ? 'success' : 'error' });
      return { ok: result.ok, tested_at: new Date().toISOString(), error: result.ok ? null : reasonMessage(`smtp_${result.code}`.replace(/[^a-z0-9_]/g, '_')) };
    },
  );
}
