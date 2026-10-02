// SPDX-License-Identifier: AGPL-3.0-only
// Droits des personnes (tâche 3.1, 05 § 4.2, 17 § 6) : `POST /api/subjects/export` (art. 15) et `POST /api/subjects/erase`
// (art. 17, aperçu `dry_run` imposé, puis effacement confirmé par l'empreinte de l'aperçu). Services de 1.8 (D-26) :
// - un membre agit sur SES données (portée `{ ownerId }`), contenu compris ;
// - l'admin et l'owner agissent sur l'instance (portée `instance`) : l'export ne leur rend que des métadonnées et les
//   valeurs identifiantes du sujet, jamais le contenu d'autrui (INV5) ; ils peuvent aussi viser leurs propres données.
// Tout est tracé dans `audit_events` par les services ; session d'interface seulement.
import { assertUsableSubject, eraseSubject, exportSubject, loadSubjectKey, SubjectErasureIncompleteError, SubjectErasureNotConfirmedError, type SubjectRequest } from '@runtime/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.js';
import { sendError, type Actor } from './guard.js';

const base = {
  identifier: { type: 'string', minLength: 1, maxLength: 512 },
  kind: { type: 'string', enum: ['email', 'phone', 'other'] },
  scope: { type: 'string', enum: ['own', 'instance'] },
} as const;

type Body = { identifier: string; kind?: 'email' | 'phone' | 'other'; scope?: 'own' | 'instance' };

export function subjectRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /** Demande du service ; null si la réponse d'erreur est partie. */
  const requestOf = async (reply: FastifyReply, actor: Actor, body: Body): Promise<SubjectRequest | null> => {
    const admin = actor.role === 'admin' || actor.role === 'owner';
    const scope = body.scope ?? (admin ? 'instance' : 'own');
    if (scope === 'instance' && !admin) {
      await sendError(reply, 403, 'forbidden', 'portée instance réservée à l’administrateur : visez vos données (scope: own)');
      return null;
    }
    try {
      assertUsableSubject([body.identifier]);
    } catch {
      await sendError(reply, 400, 'invalid_subject', 'la valeur doit désigner une personne : e-mail, téléphone, ou nom d’au moins 8 caractères');
      return null;
    }
    if (ctx.keyChecked === null) {
      await sendError(reply, 503, 'not_ready', 'instance en cours de démarrage');
      return null;
    }
    return {
      values: [body.identifier],
      key: await loadSubjectKey(ctx.pool, ctx.keyring, ctx.keyChecked),
      actor: { userId: actor.userId, via: actor.via === 'apikey' ? 'apikey' : 'ui', ref: actor.apiKey?.prefix ?? null, instanceAdmin: admin },
      scope: scope === 'instance' ? { instance: true } : { ownerId: actor.userId },
    };
  };

  app.post<{ Body: Body }>(
    '/api/subjects/export',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['identifier'], properties: base } } },
    async (request, reply) => {
      const req = await requestOf(reply, request.actor!, request.body);
      if (req === null) return reply;
      return { identifier: request.body.identifier, ...(await exportSubject(ctx.pool, req)) };
    },
  );

  app.post<{ Body: Body & { dry_run: boolean; confirmation?: string } }>(
    '/api/subjects/erase',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['identifier', 'dry_run'],
          properties: { ...base, dry_run: { type: 'boolean' }, confirmation: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const req = await requestOf(reply, request.actor!, request.body);
      if (req === null) return reply;
      try {
        const report = await eraseSubject(ctx.pool, req, { dryRun: request.body.dry_run, ...(request.body.confirmation ? { confirm: request.body.confirmation } : {}) });
        const counts: Record<string, number> = request.body.dry_run
          ? { dataset_items: report.dataset_items, ...report.plan.rows }
          : { dataset_items: report.dataset_items, items_scrubbed: report.items_scrubbed, dedup_keys: report.dedup_keys, run_artifacts: report.run_artifacts, ...report.scrubbed };
        return {
          dry_run: report.dry_run,
          counts: Object.fromEntries(Object.entries(counts).filter(([, n]) => typeof n === 'number')),
          excluded: report.exclusions_added > 0,
          ...(report.dry_run ? { confirmation: report.plan.confirmation } : {}),
        };
      } catch (error) {
        if (error instanceof SubjectErasureNotConfirmedError) return sendError(reply, 409, 'confirmation_required', 'lancez d’abord un aperçu (dry_run: true) puis renvoyez sa confirmation, sur le même état');
        if (error instanceof SubjectErasureIncompleteError) return sendError(reply, 500, 'erasure_incomplete', 'effacement incomplet : rien n’a été modifié, réessayez');
        throw error;
      }
    },
  );
}
