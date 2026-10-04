// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée MCP (tâche 3.2, 05 § 1 et § 3) : Streamable HTTP SANS ÉTAT sur `POST /mcp`, révision 2026-07-28 et
// repli sans état pour les clients 2025 (SDK v2, `createMcpHandler`), monté sur Fastify. Avant toute authentification,
// l'en-tête Host est contrôlé (hôtes admis, `@modelcontextprotocol/fastify`) puis l'en-tête Origin : présent, il doit être
// EXACTEMENT l'origine de PUBLIC_URL (schéma, hôte, port) ou une entrée de `MCP_ALLOWED_ORIGINS`, sinon 403, contre le
// rebinding DNS et les requêtes de navigateur. Puis la garde exige une clé d'API (401 avec `WWW-Authenticate` vers les
// métadonnées RFC 9728 sinon) ; chaque outil exige son scope (403 `insufficient_scope`, défi `WWW-Authenticate` du SDK,
// complété de `resource_metadata`). GET et DELETE : 405 (aucun flux de session, aucune session).
//
// Flux `subscriptions/listen` (signal « liste d'outils changée ») : plafonnés par clé et par utilisateur (une clé ne prend
// pas tous les abonnements du processus), relus périodiquement comme le flux SSE REST (clé révoquée ou expirée, compte
// désactivé : flux fermé), et rattachés à leur utilisateur : seul celui dont la liste change reçoit le signal.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { hostHeaderValidation } from '@modelcontextprotocol/fastify';
import { createMcpHandler, type ServerEvent, type ServerEventBus } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { buildMcpServer, type McpCaller } from '../mcp/server.js';
import type { McpRuntime } from '../mcp/runtime.js';
import { parseToolsets } from '../mcp/tools.js';
import { GRANTABLE_SCOPES } from '@runtime/core';
import { revalidateActor } from './guard.js';

/** Période de relecture des empreintes d'exposition (signal « liste d'outils changée »). */
const LIST_CHECK_MS = 10_000;

/** Corps JSON-RPC accepté (message ou lot) : aucun champ étranger (un `owner_id` ne choisit jamais l'identité). */
const MESSAGE = {
  type: 'object',
  additionalProperties: false,
  required: ['jsonrpc'],
  properties: {
    jsonrpc: { const: '2.0' },
    id: { type: ['string', 'integer', 'null'] },
    method: { type: 'string', maxLength: 256 },
    params: { type: 'object' },
    result: {},
    error: { type: 'object' },
  },
} as const;
const BODY = { anyOf: [MESSAGE, { type: 'array', minItems: 1, maxItems: 32, items: MESSAGE }] } as const;

const METHOD_NOT_ALLOWED = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null };
/** Refus d'Origin : jamais l'origine reçue recopiée dans la réponse. */
const ORIGIN_REFUSED = { jsonrpc: '2.0', error: { code: -32000, message: 'Origin not allowed.' }, id: null };

/** Origin admise : absente (client non navigateur), égale à une origine admise, ou d'un nom d'hôte admis sans schéma. */
function originAllowed(origin: string | undefined, mcp: Pick<McpRuntime, 'allowedOrigins' | 'allowedOriginHosts'>): boolean {
  if (origin === undefined || origin === '') return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin === 'null' || !['http:', 'https:'].includes(url.protocol)) return false;
  return mcp.allowedOrigins.includes(url.origin) || mcp.allowedOriginHosts.includes(url.hostname.toLowerCase());
}

/** Contrôles Host puis Origin des routes /mcp (crochet `onRequest` placé AVANT la garde par app.ts). */
export function mcpTransportGuard(ctx: ServerContext) {
  const mcp = ctx.mcp;
  const host = mcp ? hostHeaderValidation(mcp.allowedHosts) : null;
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.routeOptions.url !== '/mcp' || host === null || mcp === null) return;
    await host(request, reply);
    if (reply.sent) return;
    const origin = request.headers.origin;
    if (!originAllowed(typeof origin === 'string' ? origin : undefined, mcp)) await reply.code(403).send(ORIGIN_REFUSED);
  };
}

/**
 * Bus des flux `subscriptions/listen` rattaché aux utilisateurs : le routeur du SDK abonne chaque flux pendant le
 * traitement de sa requête, l'utilisateur est lu dans le contexte asynchrone de cette requête. `publishTo` ne réveille que
 * ses flux ; `publish` (événement d'instance) les réveille tous.
 */
class UserEventBus implements ServerEventBus {
  readonly scope = new AsyncLocalStorage<string>();
  private readonly byUser = new Map<string, Set<(event: ServerEvent) => void>>();
  private readonly runtime: McpRuntime;

  constructor(runtime: McpRuntime) {
    this.runtime = runtime;
  }

  publish(event: ServerEvent): void {
    for (const set of this.byUser.values()) for (const listener of [...set]) listener(event);
  }

  publishTo(userId: string, event: ServerEvent): void {
    for (const listener of [...(this.byUser.get(userId) ?? [])]) listener(event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    const userId = this.scope.getStore();
    if (userId === undefined) return () => undefined;
    const set = this.byUser.get(userId) ?? new Set();
    set.add(listener);
    this.byUser.set(userId, set);
    const unwatch = this.runtime.watch(userId);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      unwatch();
      set.delete(listener);
      if (set.size === 0 && this.byUser.get(userId) === set) this.byUser.delete(userId);
    };
  }
}

/** Requête `subscriptions/listen` (message seul, jamais dans un lot). */
const isListen = (body: unknown): boolean => body !== null && typeof body === 'object' && !Array.isArray(body) && (body as { method?: unknown }).method === 'subscriptions/listen';

export function mcpRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const runtime = ctx.mcp;
  if (runtime === null) return;
  const resourceMetadata = `${ctx.publicUrl}/.well-known/oauth-protected-resource`;
  const bus = new UserEventBus(runtime);

  const handler = createMcpHandler(
    async ({ authInfo }) => {
      const caller = authInfo?.extra?.['caller'] as McpCaller;
      return buildMcpServer(ctx, caller, ctx.appVersion);
    },
    { bus, onerror: (error) => app.log.warn({ err: { name: error.name, message: error.message } }, 'mcp : requête refusée ou erreur hors bande') },
  );
  const stop = runtime.onToolsChanged((userId) => bus.publishTo(userId, { kind: 'tools_list_changed' }));
  const timer = setInterval(() => void runtime.checkToolsChanged().catch((error: unknown) => app.log.warn({ err: error }, 'mcp : empreinte des outils illisible')), LIST_CHECK_MS);
  timer.unref();
  // preClose : les flux `subscriptions/listen` ouverts sont fermés AVANT l'arrêt du serveur HTTP, qui sinon les attendrait.
  app.addHook('preClose', async () => {
    clearInterval(timer);
    stop();
    await handler.close();
  });

  /** Flux listen ouverts par clé et par utilisateur. */
  const perKey = new Map<string, number>();
  const perUser = new Map<string, number>();
  const bump = (map: Map<string, number>, id: string, delta: number) => {
    const next = (map.get(id) ?? 0) + delta;
    if (next <= 0) map.delete(id);
    else map.set(id, next);
  };

  app.post('/mcp', { schema: { body: BODY } }, async (request, reply) => {
    const actor = request.actor!;
    const lang = (request.query as Record<string, unknown>)['lang'];
    const caller: McpCaller = { actor, request, app, toolsets: parseToolsets((request.query as Record<string, unknown>)['toolsets']), lang: typeof lang === 'string' ? lang : null };
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());

    let release: () => void = () => undefined;
    if (isListen(request.body)) {
      const keyId = actor.apiKey?.id ?? actor.userId;
      if ((perKey.get(keyId) ?? 0) >= runtime.maxListenPerKey || (perUser.get(actor.userId) ?? 0) >= runtime.maxListenPerUser) {
        const id = (request.body as { id?: unknown }).id ?? null;
        return reply
          .code(429)
          .header('retry-after', '30')
          .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many open subscriptions for this key or account: close one, then listen again.' }, id });
      }
      bump(perKey, keyId, 1);
      bump(perUser, actor.userId, 1);
      // Relecture périodique de la clé et du compte (comme le flux SSE REST) : révoqués ou désactivés, le flux se ferme.
      const revalidate = setInterval(() => {
        void revalidateActor(ctx, actor, request.routeSpec)
          .then((current) => {
            if (current === null) controller.abort();
          })
          .catch(() => controller.abort());
      }, runtime.listenRevalidateMs);
      revalidate.unref();
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        clearInterval(revalidate);
        bump(perKey, keyId, -1);
        bump(perUser, actor.userId, -1);
      };
      reply.raw.once('close', release);
      controller.signal.addEventListener('abort', release, { once: true });
    }

    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
      }
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const webRequest = new Request(`${ctx.publicUrl}/mcp${query}`, { method: 'POST', headers, signal: controller.signal });
      const response = await bus.scope.run(actor.userId, () =>
        handler.fetch(webRequest, {
          parsedBody: request.body,
          authInfo: { token: 'apikey', clientId: actor.apiKey?.prefix ?? 'apikey', scopes: [...(actor.scopes ?? [])], extra: { caller } },
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, name) => {
        // Défi de scope (403) : le SDK nomme le scope manquant ; on ajoute les métadonnées de ressource protégée (RFC 9728).
        if (name === 'www-authenticate' && !value.includes('resource_metadata=')) value = `${value}, resource_metadata="${resourceMetadata}"`;
        void reply.header(name, value);
      });
      if (response.body === null) {
        release();
        return reply.send('');
      }
      return reply.send(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>));
    } catch (error) {
      release();
      throw error;
    }
  });

  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: '/mcp', handler: async (_request, reply) => reply.code(405).header('allow', 'POST').send(METHOD_NOT_ALLOWED) });
  }

  // RFC 9728 § 3.1 : métadonnées de la ressource `<PUBLIC_URL>/mcp` aussi à l'adresse suffixée par son chemin (clients qui
  // la calculent sans lire `WWW-Authenticate`) ; même document que /.well-known/oauth-protected-resource.
  app.get('/.well-known/oauth-protected-resource/mcp', async () => ({
    resource: `${ctx.publicUrl}/mcp`,
    authorization_servers: [],
    bearer_methods_supported: ['header'],
    scopes_supported: [...GRANTABLE_SCOPES],
  }));
}
