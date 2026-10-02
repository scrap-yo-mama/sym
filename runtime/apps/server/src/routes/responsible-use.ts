// SPDX-License-Identifier: AGPL-3.0-only
// Case « j'ai lu » de la page « Usage responsable » (17 § 11, critère 2 de 4.8 ; tâche 3.1) : `responsible_use_acks`
// garde la version lue par chaque utilisateur. Sans elle, la création d'une API à champ `x-personal` est refusée
// (rest/shared.ts, `responsible_use_ack_required`). Acte humain : session d'interface seulement, jamais une clé d'API.
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { iso, RESPONSIBLE_USE_VERSION } from '../rest/shared.js';
import { audit, sendError } from './guard.js';

export function responsibleUseRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const view = async (userId: string) => {
    const { rows } = await ctx.pool.query<{ at: Date }>('SELECT at FROM responsible_use_acks WHERE user_id = $1 AND version = $2', [userId, RESPONSIBLE_USE_VERSION]);
    const at = rows[0]?.at ?? null;
    return { version: RESPONSIBLE_USE_VERSION, acknowledged_at: iso(at), required: at === null };
  };

  app.get('/api/me/responsible-use', async (request) => view(request.actor!.userId));

  app.post<{ Body: { version: string } }>(
    '/api/me/responsible-use',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['version'], properties: { version: { type: 'string', maxLength: 32 } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      // Seule la version servie se coche : une page relue après une mise à jour exige une nouvelle case.
      if (request.body.version !== RESPONSIBLE_USE_VERSION) return sendError(reply, 409, 'responsible_use_version_mismatch', 'la page « Usage responsable » a changé : relisez-la');
      await ctx.pool.query('INSERT INTO responsible_use_acks (user_id, version) VALUES ($1, $2) ON CONFLICT DO NOTHING', [actor.userId, RESPONSIBLE_USE_VERSION]);
      await audit(ctx, request, actor, { action: 'responsible_use.acknowledged', outcome: 'success', meta: { version: RESPONSIBLE_USE_VERSION } });
      return view(actor.userId);
    },
  );
}
