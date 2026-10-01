// SPDX-License-Identifier: AGPL-3.0-only
// Application Fastify : registre des routes obligatoire (INV12), garde unique, 404 uniforme.
import { createLogger, startDetachedSpan, type LogLevel } from '@runtime/core';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { ServerContext } from './context.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { authRoutes } from './routes/auth.js';
import { guard, notFound, sendError } from './routes/guard.js';
import { meRoutes } from './routes/me.js';
import { findRoute } from './routes/registry.js';
import { setupRoutes } from './routes/setup.js';
import { systemRoutes } from './routes/system.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Routes enregistrées (« MÉTHODE url »), toutes présentes dans le registre. */
    registeredRoutes: string[];
  }
}

export class UnregisteredRouteError extends Error {
  override name = 'UnregisteredRouteError';
}

export function buildServer(ctx: ServerContext, options: { logger?: boolean; loggerInstance?: FastifyBaseLogger; logLevel?: LogLevel; trustProxy?: boolean | number | string } = {}): FastifyInstance {
  const serverOptions: FastifyServerOptions = {
    // request.ip : seule source d’IP (limites, audit, auth_sessions.ip) ; voir TRUST_PROXY (config.ts).
    // Un nombre n = faire confiance aux n premiers sauts (sémantique proxy-addr), exprimé en fonction pour les types.
    trustProxy: typeof options.trustProxy === 'number' ? ((_addr: string, hop: number) => hop < (options.trustProxy as number)) : (options.trustProxy ?? false),
    // Journal pino partagé avec `worker` (masquage INV8, `run_id` par AsyncLocalStorage) ; coupé sans `logger`.
    ...(options.loggerInstance || options.logger
      ? { loggerInstance: options.loggerInstance ?? (createLogger({ name: 'server', level: options.logLevel ?? 'info' }) as FastifyBaseLogger) }
      : { logger: false as const }),
    exposeHeadRoutes: false,
    bodyLimit: 64 * 1024,
    // additionalProperties: false refuse (400) au lieu de retirer en silence (08b § 4, cas 4).
    ajv: { customOptions: { removeAdditional: false } },
  };
  const app = Fastify(serverOptions);

  app.decorateRequest('actor', null);
  app.decorateRequest('routeSpec', null);
  const registered: string[] = [];
  app.decorate('registeredRoutes', registered);

  // Une route absente du registre ne peut pas être enregistrée (INV12 : chaque route a son cas d'autorisation).
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (!findRoute(method, route.url)) throw new UnregisteredRouteError(`route ${method} ${route.url} absente de routes/registry.ts`);
      registered.push(`${method} ${route.url}`);
    }
  });
  // Span de requête (OTel opt-in, sinon rien) : route déclarée seulement, jamais l'URL ni la requête. Avant le garde.
  app.addHook('onRequest', (request, reply, done) => {
    const span = startDetachedSpan('http.request', { 'http.request.method': request.method, 'http.route': request.routeOptions.url ?? 'unmatched' });
    if (!span) return done();
    reply.raw.once('close', () => span.end());
    span.run(done);
  });
  app.addHook('onRequest', guard(ctx));

  app.setNotFoundHandler((_request, reply) => notFound(reply));
  app.setErrorHandler((error: { validation?: unknown; statusCode?: number }, request, reply) => {
    if (error.validation) return sendError(reply, 400, 'invalid_request', 'requête invalide');
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return sendError(reply, error.statusCode, 'invalid_request', 'requête invalide');
    }
    request.log.error({ err: error }, 'erreur interne');
    return sendError(reply, 500, 'internal', 'erreur interne');
  });

  systemRoutes(app, ctx);
  setupRoutes(app, ctx);
  authRoutes(app, ctx);
  meRoutes(app, ctx);
  apiKeyRoutes(app, ctx);
  return app;
}
