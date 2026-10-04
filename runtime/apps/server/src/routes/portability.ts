// SPDX-License-Identifier: AGPL-3.0-only
// Portabilité (tâche 3.12, 05 § 4.2, 16 § 6) : export JSON d'une API, import (aperçu puis confirmation), OpenAPI par API.
//
// Export : propriétaire seulement (404 uniforme pour l'API d'autrui, même `instance` : la demande d'enquête n'est servie
// qu'à son propriétaire), fichier `<slug>.api.json` à clés triées ; ni session, ni cookie, ni secret, ni donnée de run
// (`assert_export_no_secret`). Import : relu par `parseApiExport` (champs inconnus ignorés, tunnel écarté de la politique,
// `$ref` distant refusé, INV1),
// aperçu sans écriture, puis `confirm=true` : API privée en `enquete`, enquête en file au stade `access_check` (rapport
// d'accès) puis `testing` de la stratégie importée — aucun nouvel état (INV3). Le journal et l'audit ne
// reçoivent que des compteurs et des codes, jamais le contenu du fichier.
import { formatExport, parseApiExport, schemaHasPersonalFields, type ApiExport } from '@runtime/core';
import { exportApi, importApi, InvestigationStateError, PortabilityError, schemaColumns, StorageFullError, withActor } from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { apiOpenApi } from '../rest/api-openapi.js';
import { ApiInputError, checkNetworkPolicy, freeSlug, readApiBySlug, readOwnApi } from '../rest/apis.js';
import { rejectIfKeyRateLimited, rejectWithoutAck, reserveRunSlot, responsibleUseAcked, RunSlotError, sendRunSlotError, triggerOf } from '../rest/shared.js';
import { createdView, investigationError } from './apis.js';
import { audit, notFound, sendError } from './guard.js';
import { rejectWithoutInstanceContact } from './identity.js';

/** Un export tient largement sous 1 Mio (schémas bornés à 256 Kio chacun, stratégie, planifications) : au-delà, 413. */
const IMPORT_BODY_LIMIT = 1024 * 1024;

/** Données personnelles déclarées : un champ `x-personal` ou l'API qui se déclare à données personnelles (17 § 11). */
const personalOf = (doc: ApiExport): boolean => schemaHasPersonalFields(doc.api.output_schema) || doc.api.contains_personal_data === true;

export function portabilityRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Params: { slug: string } }>('/api/apis/:slug/export', async (request, reply) => {
    const actor = request.actor!;
    const api = await readOwnApi(ctx, actor, request.params.slug);
    if (api === null) return notFound(reply);
    let doc: ApiExport | null;
    try {
      doc = await withActor(ctx.pool, actor, (db) => exportApi(db, { apiId: api.id, ownerId: actor.userId, exportedAt: new Date() }));
    } catch (error) {
      if (error instanceof PortabilityError) return sendError(reply, 409, error.code, 'API sans demande d’enquête connue : elle ne peut pas être exportée');
      throw error;
    }
    if (doc === null) return notFound(reply);
    await audit(ctx, request, actor, { action: 'api.exported', targetType: 'api', targetId: api.id, outcome: 'success', meta: { format_version: doc.format_version, strategy: doc.strategy !== null, schedules: doc.schedules.length } });
    return reply
      .header('content-disposition', `attachment; filename="${api.slug}.api.json"`)
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(formatExport(doc));
  });

  app.post<{ Body: unknown; Querystring: { confirm?: boolean } }>(
    '/api/apis/import',
    { bodyLimit: IMPORT_BODY_LIMIT, schema: { body: { type: 'object' }, querystring: { type: 'object', properties: { confirm: { type: 'boolean' } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      const parsed = parseApiExport(request.body, { runtimeVersion: ctx.appVersion });
      if (!parsed.ok) return sendError(reply, 400, parsed.code, parsed.message);
      const doc = parsed.export;
      // PA-02 : les plafonds d'instance valent aussi pour un fichier (un membre édite son export, puis le réimporte) ; refus
      // AVANT toute écriture, aperçu compris. Le worker borne de plus ce qu'il lit en base.
      if ((doc.api.max_cost_usd ?? 0) > ctx.rest.maxCostUsdPerRun) return sendError(reply, 400, 'cost_cap_exceeded', `api.max_cost_usd dépasse le plafond de l’instance (${ctx.rest.maxCostUsdPerRun} $ par run)`);
      if ((doc.api.budget_daily_usd ?? 0) > ctx.rest.userBudgetDailyUsd) return sendError(reply, 400, 'cost_cap_exceeded', `api.budget_daily_usd dépasse le plafond de l’instance (${ctx.rest.userBudgetDailyUsd} $ par jour)`);
      const personal = personalOf(doc);
      let policy: Record<string, unknown>;
      try {
        policy = await checkNetworkPolicy(ctx, { allow: doc.api.network_policy?.allow ?? ['direct'] });
      } catch (error) {
        if (error instanceof ApiInputError) return sendError(reply, 400, error.code, error.message);
        throw error;
      }
      if (request.query.confirm !== true) {
        return {
          preview: true,
          description: doc.api.description,
          source_url: doc.api.source_url,
          output_fields: doc.api.output_columns ?? schemaColumns(doc.api.output_schema),
          personal_fields: personal,
          network_allow: (policy['allow'] as string[] | undefined) ?? ['direct'],
          strategy: doc.strategy === null ? null : { execution: doc.strategy.execution, network: doc.strategy.network },
          schedules: doc.schedules.length,
          alert_targets: (doc.api.alert_targets ?? []).map((t) => t.ref),
          ignored_fields: parsed.ignored,
          requires_ack: personal && !(await responsibleUseAcked(ctx, actor.userId)),
        };
      }
      // UX-04 : l'import repasse par l'enquête, qui échouerait aussitôt sans contact du robot : refus avant toute écriture.
      if (await rejectWithoutInstanceContact(ctx, reply)) return reply;
      // 17 § 11 : la case « j'ai lu » avant une API à données personnelles (comme à la création et à la validation).
      if (await rejectWithoutAck(ctx, reply, actor, personal ? true : {})) return reply;
      if (await rejectIfKeyRateLimited(ctx, reply, actor)) return reply;
      if (!URL.canParse(doc.api.source_url)) return sendError(reply, 400, 'invalid_request', 'api.source_url : URL absolue attendue');
      let created: { apiId: string; runId: string };
      try {
        const slug = await freeSlug(ctx, doc.api.description, doc.api.source_url);
        const queue = await ctx.jobs();
        created = await withActor(ctx.pool, actor, async (tx) => {
          await reserveRunSlot(tx, ctx, { kind: 'investigation' });
          return importApi(tx, queue, { ownerId: actor.userId, slug, trigger: triggerOf(actor), export: doc, networkPolicy: policy });
        });
      } catch (error) {
        if (error instanceof RunSlotError) return sendRunSlotError(reply, error);
        if (error instanceof InvestigationStateError) return investigationError(reply, error);
        if (error instanceof PortabilityError) return sendError(reply, 400, error.code, error.message);
        if (error instanceof StorageFullError) return sendError(reply, 507, 'storage_full', 'stockage plein : purgez ou agrandissez la base');
        throw error;
      }
      await audit(ctx, request, actor, {
        action: 'api.imported',
        targetType: 'api',
        targetId: created.apiId,
        outcome: 'success',
        meta: { format_version: doc.format_version, strategy: doc.strategy !== null, schedules: doc.schedules.length, ignored_fields: parsed.ignored.length },
      });
      return reply.code(201).send(await createdView(ctx, actor, created.apiId, created.runId));
    },
  );

  app.get<{ Params: { slug: string } }>('/api/apis/:slug/openapi.json', async (request, reply) => {
    const actor = request.actor!;
    // API visible de l'acteur (siennes, `instance` sans session) : ses schémas lui sont déjà servis par la fiche.
    const api = await withActor(ctx.pool, actor, (db) => readApiBySlug(db, request.params.slug));
    if (api === null) return notFound(reply);
    return apiOpenApi(api);
  });
}
