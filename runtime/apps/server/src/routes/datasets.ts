// SPDX-License-Identifier: AGPL-3.0-only
// Items d'un dataset (tâche 3.1, 05 § 4.2) : `GET /api/datasets/{id}/items?format=json|ndjson|csv&after=&offset=&limit=&fields=&omit=&since=`.
// Export EN FLUX (rest/export.ts) : mémoire bornée, reprise par `after` (curseur opaque du dernier item servi : champ
// `next_cursor` en JSON, en-tête `X-Next-Cursor` en NDJSON et CSV quand `limit` arrête la page avant la fin). Les exports
// partent en pièce jointe avec `nosniff` (08b § 2) ; le CSV est neutralisé contre l'injection de formules.
// Reprise d'un export SANS `limit` coupé en cours de route (T3) : `offset` = nombre d'items reçus en entier (lignes NDJSON
// complètes, lignes CSV hors en-tête), mêmes filtres ; ou `after=<seq>` en clair, `seq` étant le rang de l'item dans le
// dataset (0, 1, 2… dans l'ordre de l'export).
// Droits : datasets de l'acteur seulement (RLS) ; l'admin n'en voit jamais le contenu (404 uniforme).
import { Readable } from 'node:stream';
import { withActor } from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { csvLine, datasetItems, pageEnd, seqAtOffset, type ExportQuery } from '../rest/export.js';
import { decodeItemsCursor, itemsCursor } from '../rest/runs.js';
import { UUID } from './account-helpers.js';
import { notFound, sendError } from './guard.js';

const FIELD = /^[A-Za-z0-9_$.-]{1,200}$/;

/** Liste de champs `a,b,c` (100 au plus) ; null si illisible. */
function fieldList(raw: string | undefined): string[] | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  const list = raw.split(',').map((f) => f.trim()).filter((f) => f !== '');
  return list.length <= 100 && list.every((f) => FIELD.test(f)) ? list : null;
}

const MIME = { json: 'application/json; charset=utf-8', ndjson: 'application/x-ndjson; charset=utf-8', csv: 'text/csv; charset=utf-8' } as const;

export function datasetRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Params: { id: string }; Querystring: { format?: 'json' | 'ndjson' | 'csv'; after?: string; offset?: number; limit?: number; fields?: string; omit?: string; since?: string } }>(
    '/api/datasets/:id/items',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['json', 'ndjson', 'csv'] },
            after: { type: 'string', maxLength: 512 },
            offset: { type: 'integer', minimum: 0, maximum: 1000000000 },
            limit: { type: 'integer', minimum: 1, maximum: 100000 },
            fields: { type: 'string', maxLength: 4000 },
            omit: { type: 'string', maxLength: 4000 },
            since: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = request.actor!;
      if (!UUID.test(request.params.id)) return notFound(reply);
      const q = request.query;
      // `after` : curseur opaque, ou `seq` en clair (T3 : `after=<seq>`).
      const after = q.after !== undefined && /^\d{1,15}$/.test(q.after) ? Number(q.after) : decodeItemsCursor(q.after);
      const fields = fieldList(q.fields);
      const omit = fieldList(q.omit);
      if (after === null) return sendError(reply, 400, 'invalid_cursor', 'curseur illisible');
      if (fields === null || omit === null) return sendError(reply, 400, 'invalid_fields', 'fields et omit : noms de champs séparés par des virgules (100 au plus)');
      const dataset = await withActor(ctx.pool, actor, async (db) => {
        const { rows } = await db.query<{ id: string; api_id: string; output_schema: { properties?: Record<string, unknown> } | null; output_columns: string[] | null }>(
          'SELECT d.id, d.api_id, a.output_schema, a.output_columns FROM datasets d LEFT JOIN apis a ON a.id = d.api_id WHERE d.id = $1 AND d.deleted_at IS NULL',
          [request.params.id],
        );
        return rows[0] ?? null;
      });
      if (dataset === null) return notFound(reply);
      const format = q.format ?? 'json';
      // Colonnes du CSV : propriétés du schéma dans leur ordre DÉCLARÉ (`output_columns`, relevé avant jsonb), puis celles
      // que cet ordre ne connaît pas (API d'avant 0017 : ordre de jsonb).
      const declared = Object.keys(dataset.output_schema?.properties ?? {});
      const ordered = (dataset.output_columns ?? []).filter((c) => declared.includes(c));
      const schemaColumns = [...ordered, ...declared.filter((c) => !ordered.includes(c))];
      const start = await seqAtOffset(ctx, actor, { datasetId: dataset.id, afterSeq: after ?? -1, ...(q.since === undefined ? {} : { since: q.since }) }, q.offset ?? 0);
      const query: ExportQuery = {
        datasetId: dataset.id,
        afterSeq: start,
        ...(q.limit === undefined ? {} : { limit: q.limit }),
        ...(q.since === undefined ? {} : { since: q.since }),
        ...(fields === undefined ? {} : { fields }),
        ...(omit === undefined ? {} : { omit }),
      };
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'no-store');
      // Page bornée : le curseur de suite est connu avant le flux (en-tête), sinon l'export va jusqu'au bout.
      const end = q.limit === undefined ? null : await pageEnd(ctx, actor, { ...query, limit: q.limit });
      const next = end === null ? null : itemsCursor(end);
      if (next !== null) reply.header('x-next-cursor', next);
      const exported = q.limit === undefined;
      if (exported || format !== 'json') reply.header('content-disposition', `attachment; filename="dataset-${dataset.id}.${format}"`);
      reply.type(MIME[format]);

      async function* body(): AsyncGenerator<string> {
        if (format === 'json') {
          yield '{"items":[';
          let first = true;
          for await (const { item } of datasetItems(ctx, actor, query)) {
            yield (first ? '' : ',') + JSON.stringify(item);
            first = false;
          }
          yield `],"next_cursor":${JSON.stringify(next)}}`;
          return;
        }
        if (format === 'ndjson') {
          for await (const { item } of datasetItems(ctx, actor, query)) yield `${JSON.stringify(item)}\n`;
          return;
        }
        // CSV : colonnes du schéma de sortie (ou du premier item), restreintes par `fields` et `omit` ; en-tête neutralisé aussi.
        // Un champ d'item hors des propriétés du schéma (schéma sans `additionalProperties: false`) n'a pas de colonne : il
        // n'est exporté qu'en JSON et NDJSON, ou nommé par `fields` (documenté dans l'OpenAPI, paramètre `format`).
        let columns: string[] | null = fields ?? (schemaColumns.length > 0 ? schemaColumns : null);
        let headerSent = false;
        for await (const { item } of datasetItems(ctx, actor, query)) {
          columns ??= Object.keys(item);
          if (!headerSent) {
            if (omit) columns = columns.filter((c) => !omit.includes(c));
            yield csvLine(columns);
            headerSent = true;
          }
          yield csvLine(columns.map((c) => item[c]));
        }
        if (!headerSent && columns !== null) yield csvLine(omit ? columns.filter((c) => !omit.includes(c)) : columns);
      }
      return reply.send(Readable.from(body(), { objectMode: false, highWaterMark: 16 * 1024 }));
    },
  );
}
