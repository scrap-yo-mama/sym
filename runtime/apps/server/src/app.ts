import Fastify, { type FastifyInstance } from 'fastify';
import { healthResponseSchema } from '@runtime/schemas';

export function buildServer(options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get(
    '/api/health',
    { schema: { response: { 200: healthResponseSchema } } },
    async () => ({ status: 'ok' as const }),
  );

  return app;
}
