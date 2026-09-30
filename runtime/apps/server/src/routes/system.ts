// Santé et disponibilité (joignables avant l'initialisation, 13 § 4).
import { currentSchemaVersion } from '@runtime/db';
import { healthResponseSchema } from '@runtime/schemas';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';

export function systemRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/health', { schema: { response: { 200: healthResponseSchema } } }, async () => ({ status: 'ok' as const }));

  app.get('/api/ready', async (_request, reply) => {
    try {
      const version = await currentSchemaVersion(ctx.pool);
      if (version === ctx.expectedSchemaVersion) return { status: 'ready', initialized: await ctx.isInitialized() };
      return reply.code(503).send({ status: 'not_ready', reason: 'schema_version' });
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'database' });
    }
  });
}
