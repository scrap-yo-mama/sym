// SPDX-License-Identifier: AGPL-3.0-only
// Itération d'une API (tâche 3.14, 19 §6, 07 §2 et §3) : affiner (brouillon), tester, promouvoir, revenir en arrière, jeter, et
// reprendre. Les cinq outils MCP `iterate` sont des façades de ces routes (même clé, même garde, mêmes plafonds, même audit).
//
// Droits : PROPRIÉTAIRE SEUL, 404 uniforme pour tout autre (API partagée comprise, `assert_iteration_block_owner_only`) ; le
// brouillon et le texte des retours ne sortent jamais vers un autre membre.
// Porte « promotion » (19 §6) : un acte HUMAIN. Console : accusé `major` exigé ; clé d'API : élicitation acceptée (canal MCP
// seulement) ou, sans élicitation, `minor` et `patch` par un appel explicite du propriétaire ; `major` : 403
// `human_confirmation_required`, que `acknowledge_breaking` n'y change rien (`assert_promotion_requires_human`).
import { decidePromotion, DRAFT_TTL_DAYS, estimateCost, schemaHasPersonalFields, validateOutput, type Elicitation, type FeedbackKind } from '@runtime/core';
import {
  discardDraft,
  IterationError,
  planDraftTest,
  planPromotion,
  planRevert,
  promoteDraft,
  readIterationView,
  readPromotionGate,
  refineDraft,
  revertCurrent,
  settleDraftTest,
  startDraftTest,
  StorageFullError,
  withActor,
  type IterationErrorCode,
  type LastTest,
} from '@runtime/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { diffSentence, discardedText, iterationMessage, promotedText, refinedText, resumeText, revertedText, schemaChangeText, testedText, breakingText, ITERATION_MESSAGES } from '../mcp/iteration-texts.js';
import { parseLang, type McpLocale } from '../mcp/texts.js';
import { readOwnApi, type ApiRow } from '../rest/apis.js';
import { ownerNarrativeLocale } from '../rest/briefs.js';
import { waitForRun } from '../rest/runs.js';
import { rejectIfKeyRateLimited, rejectWithoutAck, reserveRunSlot, RunSlotError, sendRunSlotError, triggerOf, waitSecondsOf } from '../rest/shared.js';
import { audit, notFound, sendError, type Actor } from './guard.js';

type Json = Record<string, unknown>;

const langQuery = { type: 'object', properties: { lang: { type: 'string', maxLength: 16 }, wait: { type: 'integer', minimum: 0, maximum: 25 } } } as const;

const refineBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    feedback: { type: 'string', minLength: 1, maxLength: 2000 },
    kind: { type: 'string', enum: ['wrong_value', 'missing_field', 'extra_items', 'schema', 'step'] },
    field: { type: ['string', 'null'], maxLength: 100 },
    output_schema: { type: 'object' },
    scope: { type: 'string', maxLength: 50 },
    dry_run: { type: 'boolean' },
    accept_cost: { type: 'boolean' },
  },
} as const;

const testBody = {
  type: 'object',
  additionalProperties: false,
  required: ['input'],
  properties: { input: { type: 'object' }, dry_run: { type: 'boolean' }, accept_cost: { type: 'boolean' }, wait_seconds: { type: 'integer', minimum: 0, maximum: 25 } },
} as const;

const elicitationEnum = { type: 'string', enum: ['accepted', 'declined'] } as const;

const promoteBody = {
  type: 'object',
  additionalProperties: false,
  required: ['diff_hash'],
  properties: {
    diff_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    accept_cost_increase: { type: 'boolean' },
    acknowledge_breaking: { type: 'boolean' },
    // Réponse à l'élicitation de promotion : honorée seulement pour une clé passée par le serveur MCP (jamais un client REST).
    elicitation: elicitationEnum,
  },
} as const;

const revertBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
    acknowledge_breaking: { type: 'boolean' },
    elicitation: elicitationEnum,
  },
} as const;

type RefineBody = { feedback?: string; kind?: FeedbackKind; field?: string | null; output_schema?: Json; scope?: string; dry_run?: boolean; accept_cost?: boolean };
type TestBody = { input: Json; dry_run?: boolean; accept_cost?: boolean; wait_seconds?: number };
type PromoteBody = { diff_hash: string; accept_cost_increase?: boolean; acknowledge_breaking?: boolean; elicitation?: 'accepted' | 'declined' };
type RevertBody = { version?: number; acknowledge_breaking?: boolean; elicitation?: 'accepted' | 'declined' };

const STATUS_OF: Partial<Record<IterationErrorCode | 'breaking_change_requires_ack' | 'human_confirmation_required' | 'promotion_declined' | 'cost_above_cap' | 'cost_confirmation_required', number>> = {
  no_current_version: 409,
  api_blocked: 409,
  api_busy: 409,
  refine_in_progress: 409,
  nothing_to_refine: 400,
  invalid_schema: 400,
  no_draft: 409,
  draft_expired: 409,
  base_stale: 409,
  not_tested: 409,
  diff_hash_mismatch: 409,
  not_conform: 409,
  too_few_samples: 409,
  replay_not_llm_free: 409,
  cost_increase_requires_accept: 409,
  version_not_revertable: 400,
  already_current: 409,
  no_previous_version: 409,
  status_not_promotable: 409,
  breaking_change_requires_ack: 409,
  human_confirmation_required: 403,
  promotion_declined: 403,
  cost_above_cap: 409,
  cost_confirmation_required: 409,
};

/** Codes qu'un nouvel appel peut lever (retestable, réessayable) : le reste demande une action de la personne. */
const RETRYABLE = new Set(['refine_in_progress', 'api_busy', 'base_stale', 'not_tested', 'diff_hash_mismatch', 'cost_confirmation_required', 'invalid_schema', 'nothing_to_refine']);

/** Prochaine étape d'un refus (05 § 4.3) : un outil à appeler, ou le lien de la console pour un acte humain. */
function nextActionFor(ctx: ServerContext, code: string, slug: string): Json | null {
  switch (code) {
    case 'base_stale':
    case 'not_tested':
    case 'diff_hash_mismatch':
    case 'not_conform':
    case 'too_few_samples':
    case 'replay_not_llm_free':
      return { tool: 'test_api', args: { slug } };
    case 'no_draft':
    case 'nothing_to_refine':
      return { tool: 'refine_api', args: { slug } };
    case 'human_confirmation_required':
    case 'breaking_change_requires_ack':
      return { url: `${ctx.publicUrl}/apis/${encodeURIComponent(slug)}`, then: 'promote_api' };
    default:
      return null;
  }
}

export function iterationRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const localeOf = async (request: FastifyRequest, actor: Actor): Promise<McpLocale> => parseLang((request.query as { lang?: string } | undefined)?.lang) ?? (await ownerNarrativeLocale(ctx, actor.userId));

  const fail = (reply: FastifyReply, code: string, slug: string, locale: McpLocale, extra: Json = {}): FastifyReply => {
    const next = nextActionFor(ctx, code, slug);
    return reply.code(STATUS_OF[code as keyof typeof STATUS_OF] ?? 409).send({
      error: {
        code,
        message: iterationMessage(locale, code),
        what_to_do: ITERATION_MESSAGES[code]?.en ?? ITERATION_MESSAGES['status_not_promotable']!.en,
        retryable: RETRYABLE.has(code),
        next_action: next,
        ...extra,
      },
    });
  };

  /** Un `IterationError` en réponse ; toute autre erreur remonte. */
  const failWith = (reply: FastifyReply, error: unknown, slug: string, locale: McpLocale): FastifyReply => {
    if (error instanceof IterationError) return error.code === 'not_found' ? notFound(reply) : fail(reply, error.code, slug, locale);
    throw error;
  };

  const owned = async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply): Promise<ApiRow | null> => {
    const api = await readOwnApi(ctx, request.actor!, request.params.slug);
    if (api === null) notFound(reply);
    return api;
  };

  const consoleUrl = (slug: string): string => `${ctx.publicUrl}/apis/${encodeURIComponent(slug)}`;

  /** Test enregistré, tel que servi : sans valeur personnelle (le diff les a déjà masquées), avec la phrase localisée. */
  const testView = (test: LastTest, locale: McpLocale, failure: string | null = null) => ({
    run_id: test.run_id,
    reference_run_id: test.reference_run_id,
    state: test.state,
    ok: test.ok,
    items: test.items,
    items_rejected: test.items_rejected,
    cost_usd: test.cost_usd,
    llm_free: test.llm_free,
    reference_cost_usd: test.reference_cost_usd,
    base_version: test.base_version,
    schema_version: test.schema_version,
    reference: test.reference,
    diff: test.diff,
    diff_hash: test.diff_hash,
    summary_parts: test.summary,
    diff_summary: test.summary === null ? null : diffSentence(locale, test.summary),
    ...(failure === null ? {} : { failure_class: failure }),
  });

  // ——— Affiner : un brouillon à côté de la version en service ———
  app.post<{ Params: { slug: string }; Body: RefineBody; Querystring: { lang?: string } }>(
    '/api/apis/:slug/refine',
    { schema: { body: refineBody, querystring: langQuery } },
    async (request, reply) => {
      const actor = request.actor!;
      const locale = await localeOf(request, actor);
      const api = await owned(request, reply);
      if (api === null) return reply;
      const body = request.body;
      if (body.feedback === undefined && body.output_schema === undefined) return fail(reply, 'nothing_to_refine', api.slug, locale);
      // Un schéma qui ajoute des champs `x-personal` passe par la case « j'ai lu » comme à la validation (17 § 11).
      if (body.output_schema !== undefined && schemaHasPersonalFields(body.output_schema) && (await rejectWithoutAck(ctx, reply, actor, body.output_schema))) return reply;
      if (api.current_strategy_version === null) return fail(reply, 'no_current_version', api.slug, locale);
      const estimate = estimateCost({ history: [], strategyEstUsd: null, maxCostUsd: Number(api.max_cost_usd), iterationBudgetUsd: null });
      if (body.dry_run === true) {
        return reply.send({ dry_run: true, estimate, summary: refinedText(locale, { changes: [], costUsd: estimate.high_usd, feedbackOnly: true, dryRun: true }), next_action: { tool: 'refine_api', args: { slug: api.slug } } });
      }
      // Débit par clé comme `recompile_api` (18 §4.8) : un affinage est une écriture qui compte dans la fenêtre.
      if (await rejectIfKeyRateLimited(ctx, reply, actor)) return reply;
      try {
        const out = await refineDraft(ctx.pool, {
          apiId: api.id,
          ownerId: actor.userId,
          authorId: actor.userId,
          origin: actor.via === 'ui' ? 'ui' : 'mcp',
          ...(body.feedback === undefined ? {} : { feedback: { text: body.feedback, ...(body.kind === undefined ? {} : { kind: body.kind }), ...(body.field === undefined ? {} : { field: body.field }) } }),
          ...(body.scope === undefined ? {} : { scope: body.scope }),
          ...(body.output_schema === undefined ? {} : { outputSchema: body.output_schema }),
        });
        await audit(ctx, request, actor, {
          action: 'api.refined',
          targetType: 'api',
          targetId: api.id,
          outcome: 'success',
          // Jamais le texte du retour (il peut citer une valeur d'item) : sa taille, ses avertissements et le niveau de schéma.
          meta: { draft_version: out.draft_version, base_version: out.base_version, schema_level: out.schema_level, feedback_chars: body.feedback?.length ?? 0, widening_warnings: out.widening_warnings.map((w) => w.guard), run_id: out.run_id },
        });
        return reply.send({
          draft_version: out.draft_version,
          base_version: out.base_version,
          replaced_version: out.replaced_version,
          output_schema_version: out.output_schema_version,
          schema_level: out.schema_level,
          schema_changes: out.schema_changes,
          widening_warnings: out.widening_warnings,
          estimate,
          diff_ref: null,
          diff_hash: null,
          run_id: out.run_id,
          expires_at: out.expires_at,
          ttl_days: DRAFT_TTL_DAYS,
          summary: refinedText(locale, { changes: out.schema_changes, costUsd: estimate.high_usd, feedbackOnly: out.schema_changes.length === 0 }),
          next_action: { tool: 'test_api', args: { slug: api.slug } },
          console_url: consoleUrl(api.slug),
          message_locale: locale,
        });
      } catch (error) {
        return failWith(reply, error, api.slug, locale);
      }
    },
  );

  // ——— Tester : un run `draft_test` sur le brouillon, comparé à la version en service ———
  app.post<{ Params: { slug: string }; Body: TestBody; Querystring: { lang?: string; wait?: number } }>(
    '/api/apis/:slug/test',
    { schema: { body: testBody, querystring: langQuery } },
    async (request, reply) => {
      const actor = request.actor!;
      const locale = await localeOf(request, actor);
      const api = await owned(request, reply);
      if (api === null) return reply;
      const body = request.body;
      // Entrée hors `input_schema` : refus avant tout run (comme un run normal, 05 § 4.3).
      try {
        const checked = validateOutput(api.input_schema, body.input);
        if (!checked.ok) return sendError(reply, 400, 'invalid_input', 'entrée hors input_schema : objet conforme attendu');
      } catch {
        return sendError(reply, 409, 'invalid_input_schema', 'le schéma d’entrée de l’API est illisible : ré-enquêtez');
      }
      let plan: Awaited<ReturnType<typeof planDraftTest>>;
      try {
        plan = await planDraftTest(ctx.pool, { apiId: api.id, ownerId: actor.userId, input: body.input });
      } catch (error) {
        return failWith(reply, error, api.slug, locale);
      }
      // Coût : au-delà du plafond, jamais ; au-delà du seuil de confirmation, `accept_cost` (le coût réel reste sous le plafond du run).
      if (plan.estimate.above_cap) return fail(reply, 'cost_above_cap', api.slug, locale, { estimate: plan.estimate });
      if (body.dry_run === true) return reply.send({ dry_run: true, estimate: plan.estimate, needs_reference: plan.needs_reference, next_action: { tool: 'test_api', args: { slug: api.slug } } });
      if (plan.estimate.needs_confirmation && body.accept_cost !== true) return fail(reply, 'cost_confirmation_required', api.slug, locale, { estimate: plan.estimate });
      if (await rejectIfKeyRateLimited(ctx, reply, actor)) return reply;
      let started: Awaited<ReturnType<typeof startDraftTest>>;
      try {
        const queue = await ctx.jobs();
        started = await withActor(ctx.pool, actor, (tx) =>
          startDraftTest(tx, queue, {
            apiId: api.id,
            ownerId: actor.userId,
            input: body.input,
            trigger: triggerOf(actor) as 'mcp' | 'rest' | 'ui',
            plan,
            reserve: () => reserveRunSlot(tx, ctx, { kind: 'run', apiId: api.id }),
          }),
        );
      } catch (error) {
        if (error instanceof RunSlotError) return sendRunSlotError(reply, error);
        if (error instanceof StorageFullError) return sendError(reply, 507, 'storage_full', 'stockage plein : purgez ou agrandissez la base');
        return failWith(reply, error, api.slug, locale);
      }
      await audit(ctx, request, actor, { action: 'api.draft_tested', targetType: 'api', targetId: api.id, outcome: 'success', meta: { draft_version: plan.draft_version, run_id: started.draft_run_id, reference_run_id: started.reference_run_id, reference_started: started.started_reference } });
      // Attente bornée des deux runs ; la suite se lit avec GET /iteration (le test est enregistré dès qu'ils sont finis).
      const controller = new AbortController();
      request.raw.once('close', () => controller.abort());
      const deadline = Date.now() + waitSecondsOf(ctx, request.query.wait, body.wait_seconds) * 1000;
      for (const runId of [started.draft_run_id, started.reference_run_id]) {
        if (runId !== null) await waitForRun(ctx, actor, runId, Math.max(0, (deadline - Date.now()) / 1000), controller.signal);
      }
      const settled = await settleDraftTest(ctx.pool, { apiId: api.id, ownerId: actor.userId });
      const base = { draft_version: plan.draft_version, draft_run_id: started.draft_run_id, reference_run_id: started.reference_run_id, estimate: plan.estimate, console_url: consoleUrl(api.slug), message_locale: locale };
      if (settled === null || settled === 'pending') {
        return reply.code(202).send({ ...base, state: 'running', poll_after_seconds: 5, next_action: { tool: 'get_api', args: { slug: api.slug, view: 'iteration' } } });
      }
      const failure = settled.ok ? null : ((await withActor(ctx.pool, actor, (db) => db.query<{ failure_class: string | null }>('SELECT failure_class FROM runs WHERE id = $1', [settled.run_id]))).rows[0]?.failure_class ?? null);
      return reply.send({
        ...base,
        state: settled.state,
        test: testView(settled, locale, failure),
        summary: testedText(locale, { ok: settled.ok, summary: settled.summary, costUsd: settled.cost_usd, items: settled.items, rejected: settled.items_rejected, failureCode: failure, llmFree: settled.llm_free }),
        next_action: settled.ok ? { tool: 'promote_api', args: { slug: api.slug, diff_hash: settled.diff_hash } } : { tool: 'refine_api', args: { slug: api.slug } },
      });
    },
  );

  // ——— Promouvoir : acte humain ———
  app.post<{ Params: { slug: string }; Body: PromoteBody; Querystring: { lang?: string } }>(
    '/api/apis/:slug/promote',
    { schema: { body: promoteBody, querystring: langQuery } },
    async (request, reply) => {
      const actor = request.actor!;
      const locale = await localeOf(request, actor);
      const api = await owned(request, reply);
      if (api === null) return reply;
      const body = request.body;
      try {
        // Un test lancé puis fini hors de la requête (autre conversation) est enregistré avant de juger le brouillon.
        await settleDraftTest(ctx.pool, { apiId: api.id, ownerId: actor.userId });
        const plan = await planPromotion(ctx.pool, { apiId: api.id, ownerId: actor.userId });
        const gate = await readPromotionGate(ctx.pool, actor.userId);
        // L'élicitation n'est lue QUE pour la clé que le serveur MCP a passée par son canal interne.
        const elicitation: Elicitation = actor.channel === 'mcp' && body.elicitation !== undefined ? body.elicitation : 'unavailable';
        const decision = decidePromotion({ via: actor.via === 'ui' ? 'ui' : 'key', level: plan.level, gate, elicitation, acknowledgeBreaking: body.acknowledge_breaking === true });
        if (!decision.ok) {
          await audit(ctx, request, actor, { action: 'api.promotion_refused', targetType: 'api', targetId: api.id, outcome: 'denied', meta: { code: decision.code, level: plan.level, draft_version: plan.draft_version } });
          return reply.code(decision.status).send({
            error: {
              code: decision.code,
              message: iterationMessage(locale, decision.code),
              what_to_do: ITERATION_MESSAGES[decision.code]?.en,
              retryable: false,
              next_action: nextActionFor(ctx, decision.code, api.slug),
              level: plan.level,
              impacted: plan.impacted,
              breaking: plan.level === 'major' ? breakingText(locale, plan.impacted) : null,
              console_url: consoleUrl(api.slug),
            },
          });
        }
        const moved = await promoteDraft(ctx.pool, await ctx.jobs(), { apiId: api.id, ownerId: actor.userId, diffHash: body.diff_hash, ...(body.accept_cost_increase === true ? { acceptCostIncrease: true } : {}) });
        await audit(ctx, request, actor, {
          action: 'api.promoted',
          targetType: 'api',
          targetId: api.id,
          outcome: 'success',
          meta: { from_version: moved.previous_version, to_version: moved.current_version, level: plan.level, human: decision.human, transition: moved.transition, schema_version: moved.output_schema_version },
        });
        return reply.send({
          current_version: moved.current_version,
          previous_version: moved.previous_version,
          status: moved.status,
          transition: moved.transition,
          output_schema_version: moved.output_schema_version,
          summary: promotedText(locale, moved.current_version),
          next_action: { tool: 'revert_api', args: { slug: api.slug } },
          console_url: consoleUrl(api.slug),
          message_locale: locale,
        });
      } catch (error) {
        return failWith(reply, error, api.slug, locale);
      }
    },
  );

  // ——— Revenir : déplacement de pointeur vers une version qui a été en service ———
  app.post<{ Params: { slug: string }; Body: RevertBody | undefined; Querystring: { lang?: string } }>(
    '/api/apis/:slug/revert',
    { schema: { body: revertBody, querystring: langQuery }, preValidation: async (request) => void (request.body ??= {}) },
    async (request, reply) => {
      const actor = request.actor!;
      const locale = await localeOf(request, actor);
      const api = await owned(request, reply);
      if (api === null) return reply;
      const body = request.body ?? {};
      try {
        const plan = await planRevert(ctx.pool, { apiId: api.id, ownerId: actor.userId, ...(body.version === undefined ? {} : { version: body.version }) });
        const gate = await readPromotionGate(ctx.pool, actor.userId);
        const elicitation: Elicitation = actor.channel === 'mcp' && body.elicitation !== undefined ? body.elicitation : 'unavailable';
        // Une autre version de schéma : accusé `major` et porte de promotion, comme une promotion (19 §6).
        const decision = decidePromotion({ via: actor.via === 'ui' ? 'ui' : 'key', level: plan.level, gate, elicitation, acknowledgeBreaking: body.acknowledge_breaking === true });
        if (!decision.ok) {
          await audit(ctx, request, actor, { action: 'api.revert_refused', targetType: 'api', targetId: api.id, outcome: 'denied', meta: { code: decision.code, target_version: plan.target_version } });
          return fail(reply, decision.code, api.slug, locale, { level: plan.level });
        }
        const moved = await revertCurrent(ctx.pool, await ctx.jobs(), { apiId: api.id, ownerId: actor.userId, version: plan.target_version });
        await audit(ctx, request, actor, { action: 'api.version_reverted', targetType: 'api', targetId: api.id, outcome: 'success', meta: { from_version: moved.previous_version, to_version: moved.current_version, transition: moved.transition, human: decision.human } });
        const view = await readIterationView(ctx.pool, { slug: api.slug, ownerId: actor.userId });
        return reply.send({
          current_version: moved.current_version,
          previous_version: moved.previous_version,
          status: moved.status,
          transition: moved.transition,
          reason: 'reverted',
          output_schema_version: moved.output_schema_version,
          summary: revertedText(locale, moved.current_version, view?.draft != null),
          next_action: view?.draft != null ? { tool: 'test_api', args: { slug: api.slug } } : null,
          console_url: consoleUrl(api.slug),
          message_locale: locale,
        });
      } catch (error) {
        return failWith(reply, error, api.slug, locale);
      }
    },
  );

  // ——— Jeter le brouillon ———
  app.delete<{ Params: { slug: string }; Querystring: { lang?: string } }>('/api/apis/:slug/draft', { schema: { querystring: langQuery } }, async (request, reply) => {
    const actor = request.actor!;
    const locale = await localeOf(request, actor);
    const api = await owned(request, reply);
    if (api === null) return reply;
    try {
      const out = await discardDraft(ctx.pool, { apiId: api.id, ownerId: actor.userId });
      await audit(ctx, request, actor, { action: 'api.draft_discarded', targetType: 'api', targetId: api.id, outcome: 'success', meta: { archived_version: out.archived_version } });
      return reply.send({ archived_version: out.archived_version, summary: discardedText(locale, out.archived_version), message_locale: locale });
    } catch (error) {
      return failWith(reply, error, api.slug, locale);
    }
  });

  // ——— Reprise : le brouillon, les retours, le test et la prochaine étape (propriétaire seul) ———
  app.get<{ Params: { slug: string }; Querystring: { lang?: string } }>('/api/apis/:slug/iteration', { schema: { querystring: langQuery } }, async (request, reply) => {
    const actor = request.actor!;
    const locale = await localeOf(request, actor);
    const api = await owned(request, reply);
    if (api === null) return reply;
    // Les runs de test finis hors de la requête qui les a lancés sont enregistrés à la lecture.
    if (api.current_strategy_version !== null) await settleDraftTest(ctx.pool, { apiId: api.id, ownerId: actor.userId }).catch(() => null);
    const view = await readIterationView(ctx.pool, { slug: api.slug, ownerId: actor.userId });
    if (view === null) return notFound(reply);
    const plan = view.draft === null ? null : await planPromotion(ctx.pool, { apiId: api.id, ownerId: actor.userId }).catch(() => null);
    const draft = view.draft === null ? null : { ...view.draft, last_test: view.draft.last_test === null ? null : testView(view.draft.last_test, locale) };
    const next =
      view.next_step === 'promote'
        ? { tool: 'promote_api', args: { slug: api.slug, diff_hash: view.draft?.last_test?.diff_hash ?? null } }
        : view.next_step === 'blocked'
          ? null
          : view.next_step === 'refine'
            ? { tool: 'refine_api', args: { slug: api.slug } }
            : { tool: 'test_api', args: { slug: api.slug } };
    return {
      ...view,
      draft,
      promotion:
        plan === null
          ? null
          : { level: plan.level, changes: plan.changes, schema_version_from: plan.schema_version_from, schema_version_to: plan.schema_version_to, impacted: plan.impacted, ready_error: plan.ready_error, estimate_delta_usd: plan.estimate_delta_usd, schema_text: schemaChangeText(locale, plan.changes) },
      summary: resumeText(locale, { slug: api.slug, current: view.current_version, draft: view.draft?.version ?? null, tested: view.draft?.tested ?? false, stale: view.draft?.base_stale ?? false, blocked: view.next_step === 'blocked' }),
      next_action: next,
      console_url: consoleUrl(api.slug),
      message_locale: locale,
    };
  });
}
