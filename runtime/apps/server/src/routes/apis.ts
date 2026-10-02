// SPDX-License-Identifier: AGPL-3.0-only
// Catalogue d'API (tâche 3.1, 05 § 4.2) : création (= create_api, enquête lancée dans la même transaction), liste
// (= list_apis), fiche (= get_api), modification, suppression, validation du schéma (= validate_schema), lancement d'un run
// (= run_api), ré-enquête manuelle, versions de stratégie (liste, détail, diff, retour), chronologie des statuts.
//
// Droits : lectures sous `withActor` (RLS : siennes + `instance` sans session) ; écritures réservées au propriétaire (404
// uniforme pour l'API d'autrui, même visible) ; codes d'erreur de 05 § 4.3. Aucun réglage robots.txt n'existe (INV11).
import {
  API_STATUSES,
  EXECUTIONS,
  formatIssues,
  isTerminalRunState,
  NETWORKS,
  type Execution,
  validateOutput,
  type StatusEventInput,
} from '@runtime/core';
import {
  applyStatusAndNotify,
  createRun,
  InvestigationStateError,
  removeScheduleMirror,
  StorageFullError,
  startInvestigation,
  validateInvestigationSchema,
  withActor,
  type InvestigationState,
} from '@runtime/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import {
  apiDetail,
  apiMetadataForAdmin,
  ApiInputError,
  apiSummary,
  checkNetworkPolicy,
  freeSlug,
  insertApi,
  latestAccessReport,
  latestProposal,
  listApiRows,
  readApiById,
  readApiBySlug,
  readOwnApi,
  versionSummary,
  type ApiRow,
} from '../rest/apis.js';
import { buildRunResult, readRunRow, waitForRun } from '../rest/runs.js';
import { rejectIfQueueFull, rejectWithoutAck, reasonMessage, triggerOf, waitSecondsOf } from '../rest/shared.js';
import { decodeCursor, encodeCursor, UUID } from './account-helpers.js';
import { audit, notFound, sendError, type Actor } from './guard.js';

const executionList = { type: 'array', uniqueItems: true, maxItems: 6, items: { type: 'string', enum: [...EXECUTIONS] } } as const;

/** Politique réseau (04 § 3.2) : niveaux et proxys de l'admin par identifiant ; validée ensuite par le cœur. */
const networkPolicySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['allow'],
  properties: {
    allow: { type: 'array', uniqueItems: true, minItems: 1, items: { type: 'string', enum: [...NETWORKS] } },
    proxy_ids: { type: 'object', additionalProperties: false, properties: { dc_proxy: { type: 'string', maxLength: 64 }, res_proxy: { type: 'string', maxLength: 64 } } },
    res_proxy_params: { type: 'object', additionalProperties: false, properties: { country: { type: 'string', pattern: '^[a-z]{2}$' } } },
    dc_proxy_params: { type: 'object', additionalProperties: false, properties: { country: { type: 'string', pattern: '^[a-z]{2}$' } } },
  },
} as const;

const waitQuery = { type: 'object', properties: { wait: { type: 'integer', minimum: 0, maximum: 25 } } } as const;

const createSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'url'],
  properties: {
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    url: { type: 'string', minLength: 1, maxLength: 2048 },
    example_output: { type: ['object', 'array'] },
    auto_validate: { type: 'boolean' },
    network_policy: networkPolicySchema,
    wait_seconds: { type: 'integer', minimum: 0, maximum: 25 },
    visibility: { type: 'string', enum: ['private', 'instance'] },
    account_site_acknowledged: { type: 'boolean' },
  },
} as const;

type CreateBody = {
  description: string;
  url: string;
  example_output?: unknown;
  auto_validate?: boolean;
  network_policy?: Record<string, unknown>;
  wait_seconds?: number;
  visibility?: 'private' | 'instance';
  account_site_acknowledged?: boolean;
};

const patchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    views: { type: 'object', additionalProperties: false, properties: { columns: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 200 } } } },
    network_policy: networkPolicySchema,
    mcp_exposed: { type: 'boolean' },
    pinned: { type: 'boolean' },
    visibility: { type: 'string', enum: ['private', 'instance'] },
    purpose: { type: ['string', 'null'], maxLength: 2000 },
    legal_basis: { type: ['string', 'null'], maxLength: 2000 },
    contains_personal_data: { type: 'boolean' },
    max_cost_usd: { type: ['number', 'null'], minimum: 0, maximum: 1000 },
    budget_daily_usd: { type: ['number', 'null'], minimum: 0, maximum: 100000 },
  },
} as const;

type PatchBody = {
  description?: string;
  input_schema?: object;
  output_schema?: object;
  views?: { columns?: string[] };
  network_policy?: Record<string, unknown>;
  mcp_exposed?: boolean;
  pinned?: boolean;
  visibility?: 'private' | 'instance';
  purpose?: string | null;
  legal_basis?: string | null;
  contains_personal_data?: boolean;
  max_cost_usd?: number | null;
  budget_daily_usd?: number | null;
};

const validateSchemaBody = {
  type: 'object',
  additionalProperties: false,
  properties: { output_schema: { type: 'object' }, exclude_executions: executionList, wait_seconds: { type: 'integer', minimum: 0, maximum: 25 } },
} as const;

const runBody = {
  type: 'object',
  additionalProperties: false,
  required: ['input'],
  properties: { input: { type: 'object' }, force_investigate: { type: 'boolean' }, strategy_version: { type: 'integer', minimum: 1 } },
} as const;

const investigateBody = { type: 'object', additionalProperties: false, properties: { exclude_executions: executionList } } as const;

const listQuery = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: [...API_STATUSES] },
    execution: { type: 'string', enum: [...EXECUTIONS] },
    network: { type: 'string', enum: [...NETWORKS] },
    q: { type: 'string', maxLength: 200 },
    cursor: { type: 'string', maxLength: 512 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
} as const;

const pageQuery = { type: 'object', properties: { cursor: { type: 'string', maxLength: 512 }, limit: { type: 'integer', minimum: 1, maximum: 200 } } } as const;

/** Statut de l'API qui interdit un run (05 § 4.3). `enquete` : la stratégie n'est pas encore là. */
const BLOCKING_STATUS: Record<string, { code: string; message: string }> = {
  erreur: { code: 'api_error', message: 'API en erreur : relancez une enquête (investigate) avant de l’appeler' },
  action_requise: { code: 'action_required', message: 'action requise : connectez le site, configurez le proxy ou réglez l’accès payant, puis relancez' },
  bloquee: { code: 'blocked', message: 'API bloquée par le site : informez l’utilisateur et ne réessayez pas' },
  enquete: { code: 'investigation_in_progress', message: 'enquête en cours : aucune stratégie validée pour l’instant' },
};

/** Erreur d'état d'enquête → code HTTP (05 § 4.3). */
function investigationError(reply: FastifyReply, error: InvestigationStateError): FastifyReply {
  const status = error.code === 'api_not_found' ? 404 : error.code === 'invalid_request' || error.code === 'invalid_schema' ? 400 : 409;
  return error.code === 'api_not_found' ? notFound(reply) : sendError(reply, status, error.code, error.message);
}

/** Réponse d'un run lancé : `RunResult` (200) s'il est terminé dans l'attente, sinon 202 et run à suivre. */
async function runResponse(ctx: ServerContext, request: FastifyRequest, reply: FastifyReply, actor: Actor, runId: string, wait: number, finishedStatus = 200) {
  const controller = new AbortController();
  request.raw.once('close', () => controller.abort());
  const row = wait > 0 ? await waitForRun(ctx, actor, runId, wait, controller.signal) : await withActor(ctx.pool, actor, (db) => readRunRow(db, runId));
  if (row === null) return notFound(reply);
  if (!isTerminalRunState(row.state)) return reply.code(202).send({ run_id: runId, state: row.state, poll_after_seconds: row.paused_at === null ? 5 : null });
  return reply.code(finishedStatus).send(await buildRunResult(ctx, actor, row));
}

/** Enquête active (en file, en cours, en pause) sur l'API. */
async function activeInvestigation(ctx: ServerContext, actor: Actor, apiId: string): Promise<boolean> {
  // Les enquêtes sont celles du propriétaire (seul à pouvoir en lancer) : lecture sous RLS.
  const { rowCount } = await withActor(ctx.pool, actor, (db) =>
    db.query("SELECT 1 FROM runs WHERE api_id = $1 AND kind = 'investigation' AND state IN ('queued', 'running', 'waiting_tunnel') LIMIT 1", [apiId]),
  );
  return (rowCount ?? 0) > 0;
}

/** État d'enquête de l'API du propriétaire (jamais servi tel quel). */
async function investigationOf(ctx: ServerContext, actor: Actor, apiId: string): Promise<InvestigationState | null> {
  return withActor(ctx.pool, actor, async (db) => (await db.query<{ investigation: InvestigationState | null }>('SELECT investigation FROM apis WHERE id = $1 AND owner_id = $2', [apiId, actor.userId])).rows[0]?.investigation ?? null);
}

/** Corps de `ApiCreated` (05 § 4.1) : phase, schéma proposé et échantillon (propriétaire), rapport d'accès, run. */
async function createdView(ctx: ServerContext, actor: Actor, apiId: string, runId: string) {
  return withActor(ctx.pool, actor, async (db) => {
    const api = await readApiById(db, apiId);
    const proposal = await latestProposal(db, apiId);
    return {
      api_id: apiId,
      slug: api?.slug ?? '',
      investigation_phase: api?.investigation_phase ?? null,
      proposed_output_schema: proposal.output_schema,
      sample: proposal.sample,
      access_report: await latestAccessReport(db, apiId),
      run_id: runId,
    };
  });
}

/** Champs JSON d'une diff (chemins pointés), du plus haut niveau aux feuilles. */
function diffFields(before: unknown, after: unknown, path = ''): { path: string; change: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }[] {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const out: ReturnType<typeof diffFields> = [];
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const next = path === '' ? key : `${path}.${key}`;
      if (!(key in after)) out.push({ path: next, change: 'removed', before: before[key] });
      else if (!(key in before)) out.push({ path: next, change: 'added', after: after[key] });
      else out.push(...diffFields(before[key], after[key], next));
    }
    return out;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: path || '.', change: 'changed', before, after }];
}

export function apiRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // ——— Catalogue ———
  app.get<{ Querystring: { status?: string; execution?: string; network?: string; q?: string; cursor?: string; limit?: number } }>(
    '/api/apis',
    { schema: { querystring: listQuery } },
    async (request, reply) => {
      const actor = request.actor!;
      const q = request.query;
      const limit = q.limit ?? 50;
      const cursor = decodeCursor(q.cursor, 2);
      if (cursor === null) return sendError(reply, 400, 'invalid_cursor', 'curseur illisible');
      const where: string[] = ['true'];
      const params: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replaceAll('$?', `$${params.length}`));
      };
      if (q.status) add('a.status = $?', q.status);
      if (q.execution) add('sv.execution = $?', q.execution);
      if (q.network) add('sv.network = $?', q.network);
      if (q.q) add("(a.slug ILIKE $? OR a.description ILIKE $?)", `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      if (cursor) {
        params.push(cursor[0], cursor[1]);
        where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      const { rows, signals } = await withActor(ctx.pool, actor, async (db) => {
        const found = await listApiRows(db, where.join(' AND '), params, limit + 1);
        const ids = found.slice(0, limit).map((r) => r.id);
        // Pastille Accès du dernier rapport (enquêtes de l'acteur seulement : RLS).
        const sig = await db.query<{ api_id: string; signal: string | null }>(
          `SELECT DISTINCT ON (r.api_id) r.api_id, e.payload -> 'view' ->> 'signal' AS signal
           FROM investigation_events e JOIN runs r ON r.id = e.run_id
           WHERE r.api_id = ANY($1::uuid[]) AND e.kind = 'access_report' ORDER BY r.api_id, e.at DESC, e.seq DESC`,
          [ids],
        );
        return { rows: found, signals: new Map(sig.rows.map((s) => [s.api_id, s.signal])) };
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        apis: page.map((r) => apiSummary(r, signals.get(r.id) ?? null)),
        next_cursor: rows.length > limit && last ? encodeCursor(last.created_text, last.id) : null,
      };
    },
  );

  app.post<{ Body: CreateBody; Querystring: { wait?: number } }>('/api/apis', { schema: { body: createSchema, querystring: waitQuery } }, async (request, reply) => {
    const actor = request.actor!;
    const body = request.body;
    if (await rejectIfQueueFull(ctx, reply)) return reply;
    // Validation automatique : le schéma proposé n'est pas encore connu ; s'il porte `x-personal`, la case est exigée.
    if (body.auto_validate === true && (await rejectWithoutAck(ctx, reply, actor, true))) return reply;
    let policy: Record<string, unknown> | null = null;
    try {
      if (body.network_policy) policy = await checkNetworkPolicy(ctx, body.network_policy);
    } catch (error) {
      if (error instanceof ApiInputError) return sendError(reply, 400, error.code, error.message);
      throw error;
    }
    let created: { apiId: string; runId: string };
    try {
      const slug = await freeSlug(ctx, body.description, body.url);
      const queue = await ctx.jobs();
      created = await withActor(ctx.pool, actor, async (tx) => {
        const apiId = await insertApi(tx, actor, { slug, description: body.description.trim(), visibility: body.visibility ?? 'private', networkPolicy: policy });
        const { runId } = await startInvestigation(tx, queue, {
          apiId,
          ownerId: actor.userId,
          trigger: triggerOf(actor),
          request: { url: body.url, description: body.description, auto_validate: body.auto_validate === true },
          ...(body.example_output === undefined ? {} : { exampleOutput: body.example_output }),
        });
        return { apiId, runId };
      });
    } catch (error) {
      if (error instanceof InvestigationStateError) return investigationError(reply, error);
      if (error instanceof StorageFullError) return sendError(reply, 507, 'storage_full', 'stockage plein : purgez ou agrandissez la base');
      throw error;
    }
    await audit(ctx, request, actor, {
      action: 'api.created',
      targetType: 'api',
      targetId: created.apiId,
      outcome: 'success',
      meta: { auto_validate: body.auto_validate === true, account_site_acknowledged: body.account_site_acknowledged === true },
    });
    const wait = waitSecondsOf(ctx, request.query.wait, body.wait_seconds);
    if (wait > 0) {
      const controller = new AbortController();
      request.raw.once('close', () => controller.abort());
      const row = await waitForRun(ctx, actor, created.runId, wait, controller.signal);
      // Validation automatique terminée : l'enveloppe RunResult (05 § 4.1, `auto_validate`).
      if (row !== null && body.auto_validate === true && isTerminalRunState(row.state)) return reply.code(201).send(await buildRunResult(ctx, actor, row));
    }
    return reply.code(201).send(await createdView(ctx, actor, created.apiId, created.runId));
  });

  app.get<{ Params: { slug: string }; Querystring: { response_format?: 'concise' | 'detailed' } }>(
    '/api/apis/:slug',
    { schema: { querystring: { type: 'object', properties: { response_format: { type: 'string', enum: ['concise', 'detailed'] } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      const view = await withActor(ctx.pool, actor, async (db) => {
        const row = await readApiBySlug(db, request.params.slug);
        return row === null ? null : apiDetail(db, actor, row);
      });
      if (view !== null) return view;
      // Admin et owner : métadonnées d'une API à session d'autrui (13 § 2), audité ; sinon 404 uniforme.
      const metadata = await apiMetadataForAdmin(ctx, actor, request.params.slug);
      if (metadata === null) return notFound(reply);
      await audit(ctx, request, actor, { action: 'api.metadata_read', targetType: 'api', targetId: metadata.id, outcome: 'success' });
      return metadata;
    },
  );

  app.patch<{ Params: { slug: string }; Body: PatchBody }>('/api/apis/:slug', { schema: { body: patchSchema } }, async (request, reply) => {
    const actor = request.actor!;
    const api = await readOwnApi(ctx, actor, request.params.slug);
    if (api === null) return notFound(reply);
    const body = request.body;
    // Un schéma ne change que par brouillon puis promotion (19 § 6, 10 « Jamais ») : livré avec l'itération (3.14).
    if (body.output_schema !== undefined || body.input_schema !== undefined) {
      return sendError(reply, 409, 'draft_required', 'un schéma se modifie par un brouillon puis une promotion (itération), jamais en place');
    }
    if (body.visibility === 'instance' && api.requires_session) return sendError(reply, 400, 'session_api_private', 'une API à session reste privée');
    let policy: Record<string, unknown> | undefined;
    try {
      if (body.network_policy) policy = await checkNetworkPolicy(ctx, body.network_policy);
    } catch (error) {
      if (error instanceof ApiInputError) return sendError(reply, 400, error.code, error.message);
      throw error;
    }
    const sets: string[] = [];
    const params: unknown[] = [api.id, actor.userId];
    const set = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (body.description !== undefined) set('description', body.description.trim());
    if (body.views !== undefined) set('views', JSON.stringify(body.views), '::jsonb');
    if (policy !== undefined) set('network_policy', JSON.stringify(policy), '::jsonb');
    if (body.mcp_exposed !== undefined) set('mcp_exposed', body.mcp_exposed);
    if (body.pinned !== undefined) set('pinned', body.pinned);
    if (body.visibility !== undefined) set('visibility', body.visibility);
    if (body.purpose !== undefined) set('purpose', body.purpose ?? '');
    if (body.legal_basis !== undefined) set('legal_basis', body.legal_basis);
    if (body.contains_personal_data !== undefined) set('contains_personal_data', body.contains_personal_data);
    if (body.max_cost_usd !== undefined && body.max_cost_usd !== null) set('max_cost_usd', body.max_cost_usd);
    if (body.budget_daily_usd !== undefined && body.budget_daily_usd !== null) set('budget_daily_usd', body.budget_daily_usd);
    const view = await withActor(ctx.pool, actor, async (db) => {
      if (sets.length > 0) await db.query(`UPDATE apis SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND owner_id = $2`, params);
      const row = await readApiById(db, api.id);
      return row === null ? null : apiDetail(db, actor, row);
    });
    if (view === null) return notFound(reply);
    await audit(ctx, request, actor, { action: 'api.updated', targetType: 'api', targetId: api.id, outcome: 'success', meta: { fields: Object.keys(body) } });
    return view;
  });

  app.delete<{ Params: { slug: string } }>('/api/apis/:slug', async (request, reply) => {
    const actor = request.actor!;
    const api = await readOwnApi(ctx, actor, request.params.slug);
    if (api === null) return notFound(reply);
    const { rowCount: active } = await ctx.pool.query("SELECT 1 FROM runs WHERE api_id = $1 AND state IN ('queued', 'running', 'waiting_tunnel') LIMIT 1", [api.id]);
    if (active) return sendError(reply, 409, 'runs_active', 'des runs sont en cours : annulez-les avant de supprimer l’API');
    // Suppression complète (propriétaire vérifié ci-dessus), en identité système : runs et datasets de l'API, y compris
    // ceux d'autres membres sur une API `instance` (leurs données suivent l'API), puis l'API (cascades : versions,
    // statuts, planifications, clés de déduplication).
    const client = await ctx.pool.connect();
    let schedules: string[];
    try {
      await client.query('BEGIN');
      schedules = (await client.query<{ id: string }>('SELECT id FROM schedules WHERE api_id = $1', [api.id])).rows.map((r) => r.id);
      await client.query('DELETE FROM datasets WHERE api_id = $1', [api.id]);
      await client.query('DELETE FROM runs WHERE api_id = $1', [api.id]);
      await client.query('DELETE FROM apis WHERE id = $1 AND owner_id = $2', [api.id, actor.userId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (schedules.length > 0) {
      const queue = await ctx.jobs();
      for (const id of schedules) await removeScheduleMirror(queue, id);
    }
    await audit(ctx, request, actor, { action: 'api.deleted', targetType: 'api', targetId: api.id, outcome: 'success', meta: { slug: api.slug } });
    return reply.code(204).send();
  });

  // ——— Enquête : validation du schéma, ré-enquête ———
  app.post<{ Params: { id: string }; Body: { output_schema?: Record<string, unknown>; exclude_executions?: Execution[]; wait_seconds?: number }; Querystring: { wait?: number } }>(
    '/api/apis/:id/validate-schema',
    { schema: { body: validateSchemaBody, querystring: waitQuery } },
    async (request, reply) => {
      const actor = request.actor!;
      if (!UUID.test(request.params.id)) return notFound(reply);
      const api = await withActor(ctx.pool, actor, (db) => readApiById(db, request.params.id));
      if (api === null || api.owner_id !== actor.userId) return notFound(reply);
      const state = await investigationOf(ctx, actor, api.id);
      const schema = request.body.output_schema ?? state?.proposed_schema ?? {};
      if (await rejectWithoutAck(ctx, reply, actor, schema)) return reply;
      if (await rejectIfQueueFull(ctx, reply)) return reply;
      let runId: string;
      try {
        const queue = await ctx.jobs();
        ({ runId } = await withActor(ctx.pool, actor, (tx) =>
          validateInvestigationSchema(tx, queue, {
            apiId: api.id,
            ownerId: actor.userId,
            trigger: triggerOf(actor),
            ...(request.body.output_schema === undefined ? {} : { outputSchema: request.body.output_schema }),
            ...(request.body.exclude_executions === undefined ? {} : { excludeExecutions: request.body.exclude_executions }),
          }),
        ));
      } catch (error) {
        if (error instanceof InvestigationStateError) return investigationError(reply, error);
        throw error;
      }
      await audit(ctx, request, actor, { action: 'api.schema_validated', targetType: 'api', targetId: api.id, outcome: 'success', meta: { corrected: request.body.output_schema !== undefined } });
      return runResponse(ctx, request, reply, actor, runId, waitSecondsOf(ctx, request.query.wait, request.body.wait_seconds));
    },
  );

  /** Ré-enquête (16 à 20, 17 pour une action requise) puis enquête en file ; le statut passe par la machine (INV3). */
  const reinvestigate = async (request: FastifyRequest, reply: FastifyReply, actor: Actor, api: ApiRow, trigger: 'manual' | 'force_investigate', exclude?: Execution[]) => {
    if (await activeInvestigation(ctx, actor, api.id)) return sendError(reply, 409, 'investigation_in_progress', 'une enquête est déjà en file, en cours ou en pause sur cette API');
    const state = await investigationOf(ctx, actor, api.id);
    if (state === null) return sendError(reply, 409, 'no_investigation_request', 'aucune demande d’enquête connue pour cette API (créée hors enquête) : recréez-la');
    if (await rejectIfQueueFull(ctx, reply)) return reply;
    const queue = await ctx.jobs();
    if (api.status !== 'enquete') {
      const event: StatusEventInput = api.status === 'action_requise' ? { type: 'user_acted' } : { type: 'reinvestigate', trigger };
      const step = await applyStatusAndNotify(ctx.pool, queue, { apiId: api.id, event, clock: { now: () => new Date() } });
      if (!step.ok) return sendError(reply, 409, step.rejected === 'bloquee_manual_only' ? 'blocked' : 'status_not_reinvestigable', 'ce statut ne permet pas cette ré-enquête');
    }
    let runId: string;
    try {
      ({ runId } = await withActor(ctx.pool, actor, (tx) =>
        startInvestigation(tx, queue, {
          apiId: api.id,
          ownerId: actor.userId,
          trigger: triggerOf(actor),
          request: state.request,
          ...(exclude === undefined ? {} : { excludeExecutions: exclude }),
        }),
      ));
    } catch (error) {
      if (error instanceof InvestigationStateError) return investigationError(reply, error);
      throw error;
    }
    await audit(ctx, request, actor, { action: 'api.reinvestigated', targetType: 'api', targetId: api.id, outcome: 'success', meta: { trigger } });
    return reply.code(202).send({ run_id: runId, state: 'queued', poll_after_seconds: 5 });
  };

  app.post<{ Params: { slug: string }; Body: { exclude_executions?: Execution[] } | undefined }>(
    '/api/apis/:slug/investigate',
    // Corps facultatif (OpenAPI : requestBody non requis) : absent, il vaut `{}` avant la validation (Fastify valide sinon
    // `undefined` contre le schéma objet et répondrait 400).
    { schema: { body: investigateBody }, preValidation: async (request) => void (request.body ??= {}) },
    async (request, reply) => {
      const actor = request.actor!;
      const api = await readOwnApi(ctx, actor, request.params.slug);
      if (api === null) return notFound(reply);
      return reinvestigate(request, reply, actor, api, 'manual', request.body?.exclude_executions);
    },
  );

  // ——— Runs ———
  app.post<{ Params: { slug: string }; Body: { input: Record<string, unknown>; force_investigate?: boolean; strategy_version?: number }; Querystring: { wait?: number } }>(
    '/api/apis/:slug/runs',
    { schema: { body: runBody, querystring: waitQuery } },
    async (request, reply) => {
      const actor = request.actor!;
      const api = await withActor(ctx.pool, actor, (db) => readApiBySlug(db, request.params.slug));
      if (api === null) return notFound(reply);
      const body = request.body;
      if (body.force_investigate === true) {
        // Ré-enquête forcée : propriétaire seulement (un run d'une API `instance` ne réécrit pas l'API d'autrui).
        if (api.owner_id !== actor.userId) return sendError(reply, 403, 'forbidden', 'seul le propriétaire de l’API peut forcer une ré-enquête');
        return reinvestigate(request, reply, actor, api, 'force_investigate');
      }
      const blocking = BLOCKING_STATUS[api.status];
      if (blocking) return sendError(reply, 409, blocking.code, blocking.message);
      if (api.current_strategy_version === null) return sendError(reply, 409, 'investigation_in_progress', 'aucune stratégie validée pour l’instant');
      // Entrée hors `input_schema` : 400 `invalid_input`, AUCUN run créé (05 § 4.3).
      try {
        const checked = validateOutput(api.input_schema, body.input);
        if (!checked.ok) return sendError(reply, 400, 'invalid_input', `entrée hors input_schema : ${formatIssues(checked.errors).replace(/\n/g, ' ; ')}`);
      } catch {
        return sendError(reply, 409, 'invalid_input_schema', 'le schéma d’entrée de l’API est illisible : ré-enquêtez');
      }
      if (body.strategy_version !== undefined) {
        const { rowCount } = await withActor(ctx.pool, actor, (db) => db.query('SELECT 1 FROM strategy_versions WHERE api_id = $1 AND version = $2', [api.id, body.strategy_version]));
        if (!rowCount) return sendError(reply, 400, 'invalid_strategy_version', 'version de stratégie inconnue pour cette API');
      }
      if (await rejectIfQueueFull(ctx, reply)) return reply;
      let runId: string;
      try {
        const queue = await ctx.jobs();
        ({ runId } = await withActor(ctx.pool, actor, async (tx) => {
          const made = await createRun(tx, queue, { apiId: api.id, ownerId: actor.userId, trigger: triggerOf(actor), input: body.input });
          if (body.strategy_version !== undefined) await tx.query('UPDATE runs SET strategy_version = $2 WHERE id = $1', [made.runId, body.strategy_version]);
          return made;
        }));
      } catch (error) {
        if (error instanceof StorageFullError) return sendError(reply, 507, 'storage_full', 'stockage plein : purgez ou agrandissez la base');
        throw error;
      }
      return runResponse(ctx, request, reply, actor, runId, waitSecondsOf(ctx, request.query.wait));
    },
  );

  // ——— Versions de stratégie (06 § 2, « Stratégie & versions ») ———
  type VersionRow = { version: number; execution: string; network: string; est_cost_usd: string | null; created_by: string; parent_version: number | null; created_at: Date; spec: Record<string, unknown> | null; script_ref: string | null; patch: unknown[] | null };
  const VERSION_COLUMNS = 'version, execution, network, est_cost_usd, created_by, parent_version, created_at, spec, script_ref, patch';

  app.get<{ Params: { slug: string }; Querystring: { cursor?: string; limit?: number } }>('/api/apis/:slug/versions', { schema: { querystring: pageQuery } }, async (request, reply) => {
    const actor = request.actor!;
    const cursor = decodeCursor(request.query.cursor, 1);
    if (cursor === null || (cursor && !/^\d+$/.test(cursor[0]!))) return sendError(reply, 400, 'invalid_cursor', 'curseur illisible');
    const limit = request.query.limit ?? 50;
    const out = await withActor(ctx.pool, actor, async (db) => {
      const api = await readApiBySlug(db, request.params.slug);
      if (api === null) return null;
      const { rows } = await db.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM strategy_versions WHERE api_id = $1 ${cursor ? 'AND version < $3' : ''} ORDER BY version DESC LIMIT $2`,
        cursor ? [api.id, limit + 1, Number(cursor[0])] : [api.id, limit + 1],
      );
      return rows;
    });
    if (out === null) return notFound(reply);
    const page = out.slice(0, limit);
    return { versions: page.map(versionSummary), next_cursor: out.length > limit && page.length > 0 ? encodeCursor(String(page.at(-1)!.version)) : null };
  });

  const readVersion = async (actor: Actor, slug: string, version: number) =>
    withActor(ctx.pool, actor, async (db) => {
      const api = await readApiBySlug(db, slug);
      if (api === null) return null;
      const { rows } = await db.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM strategy_versions WHERE api_id = $1 AND version = $2`, [api.id, version]);
      return rows[0] ? { api, version: rows[0] } : null;
    });

  const versionParams = { type: 'object', properties: { slug: { type: 'string' }, version: { type: 'integer', minimum: 1 } } } as const;

  app.get<{ Params: { slug: string; version: number } }>('/api/apis/:slug/versions/:version', { schema: { params: versionParams } }, async (request, reply) => {
    const found = await readVersion(request.actor!, request.params.slug, request.params.version);
    if (found === null) return notFound(reply);
    const v = found.version;
    return { ...versionSummary(v), spec: v.script_ref === null ? v.spec : null, script_ref: v.script_ref, patch: Array.isArray(v.patch) ? v.patch : null };
  });

  app.get<{ Params: { slug: string; version: number }; Querystring: { against?: number } }>(
    '/api/apis/:slug/versions/:version/diff',
    // `against` est exigé (OpenAPI), mais contrôlé APRÈS l'API : l'API d'autrui répond 404 comme l'inexistante (INV12).
    { schema: { params: versionParams, querystring: { type: 'object', properties: { against: { type: 'integer', minimum: 1 } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      const to = await readVersion(actor, request.params.slug, request.params.version);
      if (to !== null && request.query.against === undefined) return sendError(reply, 400, 'invalid_request', 'paramètre against (version de comparaison) exigé');
      const from = to === null || request.query.against === undefined ? null : await readVersion(actor, request.params.slug, request.query.against);
      if (to === null || from === null) return notFound(reply);
      const shape = (v: VersionRow) => ({ execution: v.execution, network: v.network, spec: v.spec, script_ref: v.script_ref });
      const fields = diffFields(shape(from.version), shape(to.version));
      return {
        from: from.version.version,
        to: to.version.version,
        summary: { code: fields.length === 0 ? 'strategy_unchanged' : 'strategy_changed', params: { fields: fields.length } },
        fields,
        raw: { before: shape(from.version), after: shape(to.version) },
      };
    },
  );

  app.post<{ Params: { slug: string; version: number } }>('/api/apis/:slug/versions/:version/revert', { schema: { params: versionParams } }, async (request, reply) => {
    const actor = request.actor!;
    const api = await readOwnApi(ctx, actor, request.params.slug);
    if (api === null) return notFound(reply);
    const target = await readVersion(actor, api.slug, request.params.version);
    if (target === null) return notFound(reply);
    if (api.status !== 'sain' && api.status !== 'warning') return sendError(reply, 409, 'status_not_runnable', 'un retour de version se fait depuis sain ou warning');
    if (api.current_strategy_version === request.params.version) return sendError(reply, 409, 'already_current', 'cette version est déjà la version courante');
    // Nouvelle version (created_by `revert`) copiée de la cible : l'historique reste linéaire, la cible n'est pas réécrite.
    const v = target.version;
    await withActor(ctx.pool, actor, async (db) => {
      const locked = await db.query<{ current_strategy_version: number | null; project_id: string }>('SELECT current_strategy_version, project_id FROM apis WHERE id = $1 AND owner_id = $2 FOR UPDATE', [api.id, actor.userId]);
      const next = (await db.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM strategy_versions WHERE api_id = $1', [api.id])).rows[0]!.v;
      await db.query(
        `INSERT INTO strategy_versions (api_id, version, owner_id, project_id, execution, network, spec, script_ref, est_cost_usd, created_by, parent_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'revert', $10)`,
        [api.id, next, actor.userId, locked.rows[0]!.project_id, v.execution, v.network, JSON.stringify(v.spec ?? {}), v.script_ref, v.est_cost_usd, locked.rows[0]!.current_strategy_version],
      );
      await db.query('UPDATE apis SET current_strategy_version = $2, updated_at = now() WHERE id = $1', [api.id, next]);
    });
    const step = await applyStatusAndNotify(ctx.pool, await ctx.jobs(), { apiId: api.id, event: { type: 'version_rollback' }, clock: { now: () => new Date() } });
    await audit(ctx, request, actor, { action: 'api.reverted', targetType: 'api', targetId: api.id, outcome: 'success', meta: { to_version: v.version, transitioned: step.ok } });
    const view = await withActor(ctx.pool, actor, async (db) => {
      const row = await readApiById(db, api.id);
      return row === null ? null : apiDetail(db, actor, row);
    });
    return view ?? notFound(reply);
  });

  // ——— Chronologie des statuts (06 § 2, « Bugs & statut ») ———
  app.get<{ Params: { slug: string }; Querystring: { cursor?: string; limit?: number } }>('/api/apis/:slug/status-events', { schema: { querystring: pageQuery } }, async (request, reply) => {
    const actor = request.actor!;
    const cursor = decodeCursor(request.query.cursor, 1);
    if (cursor === null || (cursor && !/^\d+$/.test(cursor[0]!))) return sendError(reply, 400, 'invalid_cursor', 'curseur illisible');
    const limit = request.query.limit ?? 50;
    // Chronologie : celle de l'API du propriétaire (RLS sur status_events) ; un membre qui lit une API `instance` n'en voit rien.
    const out = await withActor(ctx.pool, actor, async (db) => {
      const api = await readApiBySlug(db, request.params.slug);
      if (api === null) return null;
      const { rows } = await db.query<{ id: string; at: Date; from_status: string | null; to_status: string; reason: string | null; run_id: string | null }>(
        `SELECT id::text AS id, at, from_status, to_status, reason, run_id FROM status_events WHERE api_id = $1 ${cursor ? 'AND id < $3' : ''} ORDER BY id DESC LIMIT $2`,
        cursor ? [api.id, limit + 1, cursor[0]] : [api.id, limit + 1],
      );
      return rows;
    });
    if (out === null) return notFound(reply);
    const page = out.slice(0, limit);
    const isFailure = (reason: string | null) => reason !== null && /^(transient|network|rate_limited|forbidden|blocked_by_protection|robots_disallowed|robots_unreachable|payment_required|auth_required|account_limit|not_found|extraction|code_error|run_budget_exceeded|budget_exceeded|llm_[a-z0-9_]+)$/.test(reason);
    return {
      events: page.map((e) => ({
        id: e.id,
        at: e.at.toISOString(),
        from_status: e.from_status,
        to_status: e.to_status,
        transition: null,
        reason: reasonMessage(e.reason),
        failure_class: isFailure(e.reason) ? e.reason : null,
        run_id: e.run_id,
      })),
      next_cursor: out.length > limit && page.length > 0 ? encodeCursor(page.at(-1)!.id) : null,
    };
  });

}
