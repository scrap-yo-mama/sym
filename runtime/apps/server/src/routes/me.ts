// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/me : l'identité de l'appelant, relue en base (session d'interface ou clé d'API).
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';

export function meRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/me', async (request) => {
    const actor = request.actor!;
    const { rows } = await ctx.pool.query<{ display_name: string; locale: string; theme: string }>(
      'SELECT display_name, locale, theme FROM users WHERE id = $1',
      [actor.userId],
    );
    return {
      id: actor.userId,
      email: actor.email,
      displayName: rows[0]?.display_name ?? '',
      role: actor.role,
      locale: rows[0]?.locale ?? 'en',
      theme: rows[0]?.theme ?? 'system',
      via: actor.via,
      scopes: actor.scopes,
    };
  });
}
