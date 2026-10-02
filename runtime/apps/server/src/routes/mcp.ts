// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée MCP (tâche 3.2, 05 § 1 et § 3) : Streamable HTTP SANS ÉTAT sur `POST /mcp`, révision 2026-07-28 et
// repli sans état pour les clients 2025 (SDK v2, `createMcpHandler`), monté sur Fastify. Avant toute authentification,
// l'adaptateur `@modelcontextprotocol/fastify` contrôle l'en-tête Host (hôtes admis) et l'en-tête Origin (présente et non
// admise : 403), contre le rebinding DNS et les requêtes de navigateur. Puis la garde exige une clé d'API (401 avec
// `WWW-Authenticate` vers les métadonnées RFC 9728 sinon) ; chaque outil exige son scope (403 `insufficient_scope`, défi
// `WWW-Authenticate` du SDK, complété de `resource_metadata`). GET et DELETE : 405 (aucun flux de session, aucune session).
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/fastify';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { buildMcpServer, type McpCaller } from '../mcp/server.js';
import { parseToolsets } from '../mcp/tools.js';
import { GRANTABLE_SCOPES } from '@runtime/core';

/** Période de relecture de l'empreinte d'exposition (signal « liste d'outils changée »). */
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

/** Contrôles Host puis Origin des routes /mcp (crochet `onRequest` placé AVANT la garde par app.ts). */
export function mcpTransportGuard(ctx: ServerContext) {
  const mcp = ctx.mcp;
  const host = mcp ? hostHeaderValidation(mcp.allowedHosts) : null;
  const origin = mcp ? originValidation(mcp.allowedOrigins) : null;
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.routeOptions.url !== '/mcp' || host === null || origin === null) return;
    await host(request, reply);
    if (reply.sent) return;
    await origin(request, reply);
  };
}

export function mcpRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const runtime = ctx.mcp;
  if (runtime === null) return;
  const resourceMetadata = `${ctx.publicUrl}/.well-known/oauth-protected-resource`;

  const handler = createMcpHandler(
    async ({ authInfo }) => {
      const caller = authInfo?.extra?.['caller'] as McpCaller;
      return buildMcpServer(ctx, caller, ctx.appVersion);
    },
    { onerror: (error) => app.log.warn({ err: { name: error.name, message: error.message } }, 'mcp : requête refusée ou erreur hors bande') },
  );
  const stop = runtime.onToolsChanged(() => handler.notify.toolsChanged());
  const timer = setInterval(() => void runtime.checkToolsChanged().catch((error: unknown) => app.log.warn({ err: error }, 'mcp : empreinte des outils illisible')), LIST_CHECK_MS);
  timer.unref();
  // preClose : les flux `subscriptions/listen` ouverts sont fermés AVANT l'arrêt du serveur HTTP, qui sinon les attendrait.
  app.addHook('preClose', async () => {
    clearInterval(timer);
    stop();
    await handler.close();
  });

  app.post('/mcp', { schema: { body: BODY } }, async (request, reply) => {
    const actor = request.actor!;
    const caller: McpCaller = { actor, request, app, toolsets: parseToolsets((request.query as Record<string, unknown>)['toolsets']) };
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
    const webRequest = new Request(`${ctx.publicUrl}/mcp${query}`, { method: 'POST', headers, signal: controller.signal });
    const response = await handler.fetch(webRequest, {
      parsedBody: request.body,
      authInfo: { token: 'apikey', clientId: actor.apiKey?.prefix ?? 'apikey', scopes: [...(actor.scopes ?? [])], extra: { caller } },
    });
    reply.code(response.status);
    response.headers.forEach((value, name) => {
      // Défi de scope (403) : le SDK nomme le scope manquant ; on ajoute les métadonnées de ressource protégée (RFC 9728).
      if (name === 'www-authenticate' && !value.includes('resource_metadata=')) value = `${value}, resource_metadata="${resourceMetadata}"`;
      void reply.header(name, value);
    });
    if (response.body === null) return reply.send('');
    return reply.send(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>));
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
