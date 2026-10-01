// Sondes et métriques (14 § 3), joignables avant l'initialisation (13 § 4).
import { createHash, timingSafeEqual } from 'node:crypto';
import { can } from '@runtime/core';
import { checkReadiness, listWorkers, queueDepth } from '@runtime/db';
import { healthResponseSchema } from '@runtime/schemas';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { opaqueWorkerId, renderMetrics } from '../metrics.js';
import { identify, notFound, sendError } from './guard.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export function systemRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // Vivacité : le processus répond. Aucun accès base, répond pendant une migration.
  app.get('/api/health', { schema: { response: { 200: healthResponseSchema } } }, async () => ({ status: 'ok' as const }));

  // Disponibilité : base joignable, migrations appliquées, `key_check` valide. Les workers sont informatifs (pas dans le code).
  app.get<{ Querystring: { detail?: string } }>('/api/ready', async (request, reply) => {
    const readiness = await checkReadiness(ctx.pool, ctx.keyring, ctx.expectedSchemaVersion);
    const body: Record<string, unknown> = { status: readiness.ready ? 'ready' : 'not_ready', checks: readiness.checks };
    if (readiness.ready) body['initialized'] = await ctx.isInitialized();
    if (request.query.detail === '1') {
      // Détail réservé aux administrateurs : workers vivants, profondeur de file (aucun nom d'hôte, aucune version de dépendance).
      const actor = await identify(ctx, request, reply);
      if (!actor) {
        reply.header('www-authenticate', 'Bearer');
        return sendError(reply, 401, 'unauthorized', 'identifiant absent, expiré ou révoqué');
      }
      if (actor.via === 'apikey' || !can(actor.role, 'audit:read')) return sendError(reply, 403, 'forbidden', 'action non autorisée');
      if (readiness.checks.database) {
        body['workers'] = (await listWorkers(ctx.pool)).map((w) => ({
          id: opaqueWorkerId(w.workerId),
          alive: w.alive,
          age_seconds: Math.round(w.ageSeconds),
          draining: w.draining,
          browser_contexts: w.browserContexts,
          rss_mb: w.rssMb,
        }));
        body['queue'] = await queueDepth(ctx.pool);
      }
    }
    return reply.code(readiness.ready ? 200 : 503).send(body);
  });

  // `/metrics` : fermé par défaut. Sans METRICS_TOKEN : 404 (la route n'existe pas). Avec : jeton porteur exigé, 401 sinon.
  app.get('/metrics', async (request, reply) => {
    if (ctx.metricsToken === null) return notFound(reply);
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
    const expected = sha256(ctx.metricsToken.reveal());
    if (!match?.[1] || !timingSafeEqual(sha256(match[1]), expected)) {
      reply.header('www-authenticate', 'Bearer');
      return sendError(reply, 401, 'unauthorized', 'jeton de métriques absent ou invalide');
    }
    return reply.type(ctx.metrics.contentType).send(await renderMetrics(ctx.metrics));
  });
}
