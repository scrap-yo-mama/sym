// SPDX-License-Identifier: AGPL-3.0-only
// API REST `/v1` des sessions (cdc/sym-browser 04 § 1 à § 9, 04f § 2 ; tâche 2.2), sur Fastify 5 (03 § 1) :
// créer (id réservable, type par défaut `dedicated`, attente du démarrage ou `wait=false`), lire (jetons renouvelés), lister
// (curseur stable, filtres), libérer (rejouable), prolonger (plafonnée), `GET /v1/version`, `GET /v1/openapi.json`.
// Toute session est vue au travers de son client : la session d'un autre client répond 404 (BINV7). Chaque réponse porte
// `X-Request-Id` ; chaque erreur suit 04 § 6. L'authentification, les jetons et le démarrage sur un nœud passent par les
// interfaces de types.ts (tâches 2.1, 2.3).
// Quotas et capacité (tâche 2.4, 04d § 4.2, 04b § 7) : minutes et octets du mois (429 `quota_exceeded`), durée maximale
// (`expiresAt` plafonné), budget d'egress borné par le reste du mois, puis admission : file FIFO bornée en base, sessions
// simultanées du client, nœud au plus faible taux d'occupation ; refus 429 avec `Retry-After`.
// Observabilité (tâche 3.7, 04d § 3.1) : `GET /metrics` sous jeton, hors OpenAPI publique ; sessions par état et type,
// file et nœuds vivants lus en base à chaque collecte, créations comptées par résultat, attente en file mesurée.
import { randomBytes } from 'node:crypto';
import { authorizeRequest, endStateFor, isTerminal, liveViewUrl, metricsResponse, resolveSessionType, sessionUnits, type CreateResult } from '@sym-browser/core';
import {
  abandonQueuedSession,
  assignedNodes,
  claimIdempotencyKey,
  completeIdempotencyKey,
  extendSession,
  gatewaySnapshot,
  getSessionView,
  listSessionViews,
  monthlyUsage,
  readyNodeExists,
  releaseIdempotencyKey,
  requestHash,
  transitionSession,
  type IdempotentOperation,
  type SessionView,
} from '@sym-browser/db';
import {
  BROWSER_API_VERSION,
  BROWSER_ENGINE,
  BROWSER_MIN_SDK,
  BROWSER_PRODUCT,
  BROWSER_PROTOCOL_VERSION,
  browserOpenApi,
  SESSION_STATES,
  SESSION_TYPES,
  type ConnectUrls,
  type Session,
  type SessionPage,
  type SessionState,
  type SessionType,
  type VersionInfo,
} from '@sym/contracts/browser';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Admission, type Placement } from '../admission/admission.js';
import { secondsUntilNextMonth } from '../admission/retry-after.js';
import type pg from 'pg';
import { registerTenantRoutes } from '../admin/tenants.js';
import { createEventHub } from '../events/hub.js';
import { serveEventStream, type OpenStream } from '../events/stream.js';
import { createWebhookDispatcher } from '../webhooks/dispatcher.js';
import { ApiProblem, invalidOption, preferredLanguage } from './errors.js';
import type { GatewayDeps, Principal, Scope } from './types.js';
import { isDateTime, parseCreateSession, parseExtendSession, UUID } from './validation.js';
import { createDbRelayResolver, registerRelay } from '../relay/index.js';

/** Défauts de l'instance (04 § 3) et durée des jetons de connexion (04 § 7, « à valider, tâche 2.1 »). */
const SESSION_DEFAULTS = Object.freeze({ timeoutSeconds: 300, idleTimeoutSeconds: 60 });
const CONNECT_TOKEN_TTL_SECONDS = 300;
const RETRY_AFTER_SECONDS = 5;
const INVALID_BODY = Symbol('corps illisible');
/** Message de la 503 d'un lancement impossible : compté `launch_failed` et non `no_node`. */
const LAUNCH_FAILED = 'No node could start the session.';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Options gardées en base (`sessions.options`, informatives : le nœud reçoit la demande d'origine) : valeurs des en-têtes et
 * `storageState` masquées (audit 5.3 S11, BINV6 : en-têtes d'authentification et cookies de session jamais en clair au repos).
 */
function persistedOptions(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...options };
  const headers = options['extraHTTPHeaders'];
  if (headers !== null && typeof headers === 'object') out['extraHTTPHeaders'] = Object.fromEntries(Object.keys(headers).map((name) => [name, '[masqué]']));
  const state = options['storageState'] as { cookies?: unknown[]; origins?: unknown[] } | undefined;
  if (state !== undefined) out['storageState'] = { masked: true, cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0 };
  return out;
}

const sessionNotFound = (): ApiProblem => new ApiProblem('session_not_found', 'Session not found.');

/** Curseur opaque : position (`created_at` en microsecondes, `id`) de la dernière session de la page. */
function encodeCursor(position: SessionView['position']): string {
  return Buffer.from(JSON.stringify([position.micros, position.id])).toString('base64url');
}

function decodeCursor(cursor: string): SessionView['position'] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && /^\d{1,20}$/.test(value[0]) && typeof value[1] === 'string' && UUID.test(value[1])) {
      return { micros: value[0], id: value[1] };
    }
  } catch {
    // Curseur illisible : refusé ci-dessous.
  }
  throw invalidOption([{ field: 'cursor', reason: 'unknown cursor' }]);
}

export async function createGatewayApi(deps: GatewayDeps): Promise<FastifyInstance> {
  const queueTimeoutMs = deps.queueTimeoutMs ?? 30_000;
  const defaults = { ...SESSION_DEFAULTS, ...deps.defaults };
  const wsBase = deps.publicUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
  const onError = deps.onError ?? (() => undefined);
  const version: VersionInfo = {
    product: BROWSER_PRODUCT,
    api: BROWSER_API_VERSION,
    contract: BROWSER_PROTOCOL_VERSION,
    playwright: BROWSER_ENGINE.playwright,
    chromium: BROWSER_ENGINE.chromium,
    platform: deps.platform ?? process.platform,
    minSdk: BROWSER_MIN_SDK,
  };

  const admission = new Admission({
    db: deps.db,
    ...(deps.queue === undefined ? {} : { limits: deps.queue }),
    ...(deps.queuePollMs === undefined ? {} : { pollMs: deps.queuePollMs }),
    onError,
    onWaited: (ms) => deps.observability?.metrics.queueWaitSeconds.observe({}, ms / 1000),
  });

  const observability = deps.observability;
  if (observability) {
    const { metrics } = observability;
    observability.registry.onCollect(async () => {
      const snapshot = await gatewaySnapshot(deps.db);
      metrics.sessions.reset();
      for (const row of snapshot.sessions) metrics.sessions.set({ state: row.state, type: row.type }, row.count);
      metrics.queueLength.set({}, snapshot.queueLength);
      metrics.nodeUp.reset();
      for (const node of snapshot.nodes) {
        try {
          metrics.nodeUp.set({ node: node.id }, node.up ? 1 : 0);
        } catch (error) {
          onError(error); // identifiant de nœud hors format d'étiquette : ignoré plutôt que d'exposer une cardinalité libre
        }
      }
    });
  }
  const countCreation = (type: SessionType, result: CreateResult): void => observability?.metrics.sessionsCreated.inc({ type, result });

  const app = Fastify({ logger: false, genReqId: () => `req_${randomBytes(9).toString('base64url')}`, bodyLimit: 1_048_576 });

  // Corps : JSON seulement, lu par la passerelle ; un corps illisible ou d'un autre type devient une 422 typée.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(null, INVALID_BODY);
    }
  });
  app.addContentTypeParser('*', { parseAs: 'string' }, (_request, _body, done) => done(null, INVALID_BODY));

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    // Audit 5.3 S12 : réponses JSON jamais interprétées autrement, jamais encadrées, jamais référencées (jetons en URL).
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
  });

  const fail = (request: FastifyRequest, reply: FastifyReply, problem: ApiProblem): FastifyReply => {
    if (problem.retryAfter !== undefined) reply.header('retry-after', String(problem.retryAfter));
    return reply.code(problem.status).send(problem.body(request.id, preferredLanguage(request.headers['accept-language'])));
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiProblem) return fail(request, reply, error);
    const status = (error as { statusCode?: number }).statusCode;
    // Erreurs de Fastify côté client (corps trop gros, en-têtes…) : options invalides, jamais une 5xx.
    if (status !== undefined && status >= 400 && status < 500) return fail(request, reply, invalidOption([{ field: '', reason: (error as Error).message }]));
    onError(error);
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal error.', retryable: true, what_to_do: 'Retry later.', requestId: request.id } });
  });

  app.setNotFoundHandler((request, reply) =>
    fail(request, reply, request.url.startsWith('/v1/sessions/') ? sessionNotFound() : invalidOption([{ field: 'path', reason: 'unknown route' }])),
  );

  /** Clé d'API en `Authorization: Bearer` puis scope requis (04 § 1) : décision de la tâche 2.1 (`authorizeRequest`). */
  const authorize = (scope: Scope) => async (request: FastifyRequest): Promise<void> => {
    const decision = await authorizeRequest(deps.auth, request.headers, scope);
    if (decision.ok) {
      request.principal = decision.principal;
      return;
    }
    if (decision.status === 403) throw new ApiProblem('forbidden', `Scope ${decision.requiredScope} required.`, { details: { requiredScope: decision.requiredScope } });
    // Audit 5.3 S15 : file des vérifications argon2id pleine → 429 à réessayer, jamais 401.
    if (decision.reason === 'busy') throw new ApiProblem('capacity_exceeded', 'Too many API key verifications in progress.', { details: { limit: 'auth' }, retryAfter: 1 });
    throw new ApiProblem('unauthorized', 'Missing, unknown or expired API key.');
  };
  const principalOf = (request: FastifyRequest): Principal => {
    if (!request.principal) throw new ApiProblem('unauthorized', 'Missing API key.');
    return request.principal;
  };

  const connectUrls = async (sessionId: string, type: SessionType, notAfter?: Date): Promise<ConnectUrls> => {
    const url = async (protocol: 'playwright' | 'cdp') =>
      `${wsBase}/v1/sessions/${sessionId}/${protocol}?token=${encodeURIComponent(await deps.tokens.issue({ sessionId, protocol, ttlSeconds: CONNECT_TOKEN_TTL_SECONDS, ...(notAfter === undefined ? {} : { notAfter }) }))}`;
    return { cdp: type === 'dedicated' ? await url('cdp') : null, playwright: await url('playwright'), bidi: null };
  };

  /**
   * Réponse `Session` (04 § 4) : `connectUrls` à jeton neuf pour une session `running` seulement, et seulement pour qui peut
   * la piloter (`sessions:write`, audit 5.3 S09 : une clé de lecture ne reçoit aucun jeton de pilotage).
   */
  const present = async (view: SessionView, canDrive = true): Promise<Session> => ({
    id: view.id,
    state: view.state,
    type: view.type,
    ...(view.nodeRegion === null ? {} : { nodeRegion: view.nodeRegion }),
    ...(view.state === 'running' && canDrive ? { connectUrls: await connectUrls(view.id, view.type) } : {}),
    // Vue en direct (04d § 1.1) : page de la console, jeton de lecture seule de 15 min ; `rw` par la route dédiée (contrat).
    ...(view.state === 'running' && deps.relay?.liveTokens !== undefined ? { liveViewUrl: liveViewUrl(deps.publicUrl, view.id, deps.relay.liveTokens.issue({ sessionId: view.id, mode: 'ro' }).token) } : {}),
    expiresAt: view.expiresAt.toISOString(),
    createdAt: view.createdAt.toISOString(),
    ...(view.endReason === null ? {} : { endReason: view.endReason }),
    ...(view.usage === null ? {} : { usage: view.usage }),
    metadata: view.metadata,
  });

  const loadSession = async (request: FastifyRequest, id: string): Promise<SessionView> => {
    if (!UUID.test(id)) throw sessionNotFound();
    const view = await getSessionView(deps.db, { tenantId: principalOf(request).tenantId, sessionId: id });
    if (!view) throw sessionNotFound();
    return view;
  };

  const bodyOf = (request: FastifyRequest): unknown => {
    if (request.body === INVALID_BODY) throw invalidOption([{ field: '', reason: 'body must be JSON (application/json)' }]);
    return request.body;
  };

  /**
   * `Idempotency-Key` (04 § 9) : même clé et même demande dans les 24 h → réponse d'origine (`Idempotent-Replayed: true`) ;
   * autre demande sous la même clé → 409 ; seules les réponses 2xx sont gardées.
   */
  const idempotent = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: IdempotentOperation,
    target: string,
    body: unknown,
    run: () => Promise<{ status: number; body: Session }>,
  ): Promise<FastifyReply> => {
    const header = request.headers['idempotency-key'];
    if (header === undefined) {
      const result = await run();
      return reply.code(result.status).send(result.body);
    }
    if (typeof header !== 'string' || header.length < 8 || header.length > 128) throw invalidOption([{ field: 'Idempotency-Key', reason: 'must have 8 to 128 characters' }]);
    const scope = { tenantId: principalOf(request).tenantId, operation, key: header };
    const claim = await claimIdempotencyKey(deps.db, { ...scope, hash: requestHash(target, body) });
    if (claim.kind === 'conflict') throw new ApiProblem('idempotency_conflict', 'Idempotency-Key already used for another request.');
    if (claim.kind === 'replay') {
      // Audit 5.3 S10 : la réponse gardée n'a aucun jeton ; le rejeu relit la session et émet des jetons neufs.
      const stored = claim.body as Partial<Session>;
      const view = typeof stored.id === 'string' ? await getSessionView(deps.db, { tenantId: scope.tenantId, sessionId: stored.id }) : null;
      return reply.code(claim.status).header('idempotent-replayed', 'true').send(view ? await present(view) : claim.body);
    }
    try {
      const result = await run();
      const { connectUrls: _connectUrls, liveViewUrl: _liveViewUrl, ...kept } = result.body;
      await completeIdempotencyKey(deps.db, { ...scope, status: result.status, body: kept as Session });
      return reply.code(result.status).send(result.body);
    } catch (error) {
      await releaseIdempotencyKey(deps.db, scope);
      throw error;
    }
  };

  /** Fin d'une session encore `pending` dont le démarrage a échoué ou attend trop (04 § 5, 04b § 7). */
  const failPending = async (sessionId: string, reason: 'crash' | 'quota'): Promise<void> => {
    await transitionSession(deps.db, { sessionId, to: 'failed', reason });
  };

  if (deps.relay) {
    await registerRelay(app, {
      resolver: createDbRelayResolver({ db: deps.db, auth: deps.auth, tokens: deps.tokens, ...(deps.relay.liveTokens === undefined ? {} : { liveTokens: deps.relay.liveTokens }) }),
      nodeToken: deps.relay.nodeToken,
      ...(deps.relay.pingIntervalMs === undefined ? {} : { pingIntervalMs: deps.relay.pingIntervalMs }),
      ...(deps.relay.cdpMaxMessageBytes === undefined ? {} : { cdpMaxMessageBytes: deps.relay.cdpMaxMessageBytes }),
      // Découverte json/version (tâche 2.8) : même URL que `connectUrls.cdp`, jeton neuf.
      // Ouverte par un jeton : jamais au-delà de son échéance (audit 5.3 S14).
      cdpWebSocketUrl: async (sessionId, notAfter) => (await connectUrls(sessionId, 'dedicated', notAfter)).cdp ?? '',
      onError,
    });
  }

  app.addHook('onClose', async () => admission.close());

  /** Minutes et octets du mois (04d § 4.2) : 429 `quota_exceeded` si le solde est nul ; rend le reste d'octets. */
  const monthlyBalance = async (tenantId: string): Promise<{ maxSessionSeconds: number; bytesLeft: number }> => {
    const usage = await monthlyUsage(deps.db, tenantId);
    const retryAfter = secondsUntilNextMonth();
    if (usage.seconds >= usage.limits.monthlyMinutes * 60) {
      throw new ApiProblem('quota_exceeded', 'Monthly browser minutes exhausted.', { details: { quota: 'minutes' }, retryAfter });
    }
    const bytesLeft = usage.limits.monthlyBytes - usage.bytes;
    if (bytesLeft <= 0) throw new ApiProblem('quota_exceeded', 'Monthly egress bytes exhausted.', { details: { quota: 'bytes' }, retryAfter });
    return { maxSessionSeconds: usage.limits.maxSessionSeconds, bytesLeft };
  };

  /** Attente du placement jusqu'à l'échéance ; file expirée : session `failed` raison `quota`, 429 `capacity_exceeded`. */
  const placementOf = async (sessionId: string, deadline: number): Promise<Placement> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      const placement = await admission.wait(sessionId, controller.signal);
      if (placement) return placement;
    } finally {
      clearTimeout(timer);
    }
    if (!(await abandonQueuedSession(deps.db, sessionId))) {
      // Placée entre-temps (par cette passerelle ou une autre) : on la lance quand même.
      const late = (await assignedNodes(deps.db, [sessionId])).get(sessionId);
      if (late) return late;
    }
    throw new ApiProblem('capacity_exceeded', 'Session not started within the queue timeout.', { details: { limit: 'queue_timeout' }, retryAfter: admission.retryAfterSeconds() });
  };

  if (observability) {
    app.get('/metrics', async (request, reply) => {
      const res = await metricsResponse(observability.registry, observability.token, request.headers.authorization);
      return reply.code(res.status).headers(res.headers).send(res.body);
    });
  }

  app.get('/v1/version', async () => version);
  app.get('/v1/openapi.json', async () => browserOpenApi);

  app.post('/v1/sessions', { preHandler: authorize('sessions:write') }, async (request, reply) => {
    const principal = principalOf(request);
    const query = request.query as Record<string, unknown>;
    const waitParam = query['wait'];
    if (waitParam !== undefined && waitParam !== 'true' && waitParam !== 'false') throw invalidOption([{ field: 'wait', reason: 'must be true or false' }]);
    const wait = waitParam !== 'false';
    const body = parseCreateSession(bodyOf(request));

    const counted = resolveSessionType(body).type;
    return idempotent(request, reply, 'createSession', `POST /v1/sessions?wait=${wait}`, body, async () => {
      try {
        const created = await createSession();
        countCreation(counted, created.status === 202 ? 'accepted' : 'started');
        return created;
      } catch (error) {
        if (error instanceof ApiProblem) {
          const result: CreateResult | undefined =
            error.message === LAUNCH_FAILED ? 'launch_failed' : (['quota_exceeded', 'capacity_exceeded', 'no_node', 'session_id_taken'] as const).find((c) => c === error.code);
          if (result) countCreation(counted, result);
        }
        throw error;
      }
    });

    async function createSession(): Promise<{ status: number; body: Session }> {
      const deadline = Date.now() + queueTimeoutMs;
      const region = body.region ?? null;
      if (!(await readyNodeExists(deps.db, region))) throw new ApiProblem('no_node', 'No ready node in the requested region.', { retryAfter: RETRY_AFTER_SECONDS });
      const { bytesLeft } = await monthlyBalance(principal.tenantId);
      const { type } = resolveSessionType(body);
      const timeoutSeconds = body.timeoutSeconds ?? defaults.timeoutSeconds;
      const idleTimeoutSeconds = body.idleTimeoutSeconds ?? defaults.idleTimeoutSeconds;
      // Budget d'egress effectif : le plus petit de `budgetBytes` et du reste du mois (04c § 1.4).
      const egress = { ...body.egress, budgetBytes: Math.min(body.egress?.budgetBytes ?? Number.MAX_SAFE_INTEGER, bytesLeft) };
      const options = { ...body, egress };
      const { id: _id, region: _region, metadata, egress: _egress, ...rest } = body;
      const outcome = await admission.enqueue({
        ...(body.id === undefined ? {} : { id: body.id }),
        tenantId: principal.tenantId,
        apiKeyId: principal.apiKeyId,
        type,
        region,
        timeoutSeconds,
        options: persistedOptions({ ...rest, type, timeoutSeconds, idleTimeoutSeconds }),
        egressPolicy: egress as Record<string, unknown>,
        metadata: metadata ?? {},
        slotWeight: sessionUnits(type),
      });
      if (!outcome.ok) {
        if (outcome.code === 'session_id_taken') throw new ApiProblem('session_id_taken', 'Session id already taken.');
        if (outcome.code === 'quota_exceeded') {
          throw new ApiProblem('quota_exceeded', 'Concurrent sessions quota reached and tenant queue full.', { details: { quota: outcome.quota }, retryAfter: admission.retryAfterSeconds() });
        }
        throw new ApiProblem('capacity_exceeded', 'Session queue full.', { details: { limit: outcome.limit }, retryAfter: admission.retryAfterSeconds() });
      }
      const session = outcome.session;
      const start = async (): Promise<{ ok: true } | { ok: false; code: 'launch_failed' } | 'timeout'> => {
        const placement = outcome.admitted ? { nodeId: outcome.nodeId, nodeUrl: outcome.nodeUrl } : await placementOf(session.id, deadline);
        const launch = deps.launcher.launch({
          sessionId: session.id,
          nodeId: placement.nodeId,
          nodeUrl: placement.nodeUrl,
          tenantId: principal.tenantId,
          type,
          region,
          options,
          expiresAt: session.expiresAt,
          idleTimeoutSeconds,
        });
        let timer: NodeJS.Timeout | undefined;
        return Promise.race([
          launch.catch((error: unknown) => {
            onError(error);
            return { ok: false as const, code: 'launch_failed' as const };
          }),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
          }),
        ]).finally(() => clearTimeout(timer));
      };

      if (!wait) {
        // Démarrage en arrière-plan : la session passe `running` (ou `failed`) sans l'appelant.
        void start()
          .then((result) => (result === 'timeout' ? failPending(session.id, 'quota') : result.ok ? undefined : failPending(session.id, 'crash')))
          .catch(async (error: unknown) => {
            if (!(error instanceof ApiProblem)) {
              onError(error);
              await failPending(session.id, 'crash');
            }
          })
          .catch(onError)
          .finally(() => void admission.pump());
        return { status: 202, body: await present(session) };
      }

      const result = await start().finally(() => void admission.pump());
      if (result === 'timeout') {
        await failPending(session.id, 'quota');
        throw new ApiProblem('capacity_exceeded', 'Session not started within the queue timeout.', { details: { limit: 'queue_timeout' }, retryAfter: admission.retryAfterSeconds() });
      }
      if (!result.ok) {
        await failPending(session.id, 'crash');
        throw new ApiProblem('no_node', LAUNCH_FAILED, { retryAfter: RETRY_AFTER_SECONDS });
      }
      const started = (await getSessionView(deps.db, { tenantId: principal.tenantId, sessionId: session.id })) ?? session;
      return { status: 201, body: await present(started) };
    }
  });

  app.get('/v1/sessions', { preHandler: authorize('sessions:read') }, async (request): Promise<SessionPage> => {
    const query = request.query as Record<string, unknown>;
    const single = (name: string): string | undefined => {
      const value = query[name];
      if (value === undefined) return undefined;
      if (typeof value !== 'string') throw invalidOption([{ field: name, reason: 'must be given once' }]);
      return value;
    };
    const limitText = single('limit');
    const limit = limitText === undefined ? 50 : Number(limitText);
    if (!/^\d+$/.test(limitText ?? '50') || !Number.isInteger(limit) || limit < 1 || limit > 200) throw invalidOption([{ field: 'limit', reason: 'must be an integer from 1 to 200' }]);
    const state = single('state');
    if (state !== undefined && !(SESSION_STATES as readonly string[]).includes(state)) throw invalidOption([{ field: 'state', reason: `must be one of ${SESSION_STATES.join(', ')}` }]);
    const type = single('type');
    if (type !== undefined && !(SESSION_TYPES as readonly string[]).includes(type)) throw invalidOption([{ field: 'type', reason: `must be one of ${SESSION_TYPES.join(', ')}` }]);
    const date = (name: string): Date | undefined => {
      const value = single(name);
      if (value === undefined) return undefined;
      if (!isDateTime(value)) throw invalidOption([{ field: name, reason: 'must be an RFC 3339 date-time' }]);
      return new Date(value);
    };
    const createdAfter = date('createdAfter');
    const createdBefore = date('createdBefore');
    const metadata: Record<string, string> = {};
    for (const name of Object.keys(query)) {
      if (!name.startsWith('metadata.')) continue;
      const value = single(name);
      const key = name.slice('metadata.'.length);
      if (value === undefined || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) throw invalidOption([{ field: name, reason: 'invalid metadata filter' }]);
      metadata[key] = value;
    }
    const cursor = single('cursor');
    const page = await listSessionViews(deps.db, {
      tenantId: principalOf(request).tenantId,
      limit,
      ...(cursor === undefined ? {} : { after: decodeCursor(cursor) }),
      ...(state === undefined ? {} : { state: state as SessionState }),
      ...(type === undefined ? {} : { type: type as SessionType }),
      ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
      ...(createdAfter === undefined ? {} : { createdAfter }),
      ...(createdBefore === undefined ? {} : { createdBefore }),
    });
    const last = page.data.at(-1);
    const canDrive = principalOf(request).scopes.includes('sessions:write');
    return { data: await Promise.all(page.data.map((view) => present(view, canDrive))), nextCursor: page.hasMore && last ? encodeCursor(last.position) : null };
  });

  app.get('/v1/sessions/:id', { preHandler: authorize('sessions:read') }, async (request) =>
    present(await loadSession(request, (request.params as { id: string }).id), principalOf(request).scopes.includes('sessions:write')),
  );

  app.delete('/v1/sessions/:id', { preHandler: authorize('sessions:write') }, async (request) => {
    const view = await loadSession(request, (request.params as { id: string }).id);
    if (isTerminal(view.state)) return present(view);
    // Libération : le nœud qui tient la session la détruit puis écrit `ended` (04c § 3.2) ; sinon la passerelle l'écrit.
    if ((await deps.launcher.release(view.id)) === 'not_held') {
      const to = endStateFor(view.state, 'released');
      if (to !== undefined) await transitionSession(deps.db, { sessionId: view.id, to, reason: 'released' });
    }
    // Des unités se sont libérées : la file est servie sans attendre le passage périodique.
    void admission.pump();
    return present((await getSessionView(deps.db, { tenantId: view.tenantId, sessionId: view.id })) ?? view);
  });

  app.post('/v1/sessions/:id/extend', { preHandler: authorize('sessions:write') }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const view = await loadSession(request, id);
    const body = parseExtendSession(bodyOf(request));
    return idempotent(request, reply, 'extendSession', `POST /v1/sessions/${view.id}/extend`, body, async () => {
      const finished = invalidOption([{ field: 'id', reason: 'session_finished' }]);
      if (isTerminal(view.state)) throw finished;
      if ((await deps.launcher.extend(view.id, body.timeoutSeconds)) === 'not_held') {
        const outcome = await extendSession(deps.db, { sessionId: view.id, seconds: body.timeoutSeconds });
        if (!outcome.ok) throw outcome.code === 'not_found' ? sessionNotFound() : finished;
      }
      const updated = (await getSessionView(deps.db, { tenantId: view.tenantId, sessionId: view.id })) ?? view;
      return { status: 200, body: await present(updated) };
    });
  });

  // --- Événements (tâche 2.5) : flux SSE par session et par client, reprise par Last-Event-ID (04 § 2). ---
  const heartbeatMs = deps.events?.heartbeatMs ?? 15_000;
  const hub = createEventHub({ connection: deps.db.options as pg.ClientConfig, onError });
  const streams = new Set<OpenStream>();
  // Les flux ouverts tiendraient le serveur : fermés avant l'arrêt (le client reprend par Last-Event-ID).
  app.addHook('preClose', async () => {
    for (const stream of [...streams]) stream.end();
  });
  app.addHook('onClose', async () => {
    await hub.close();
  });

  /** `Last-Event-ID` (en-tête de reprise d'EventSource) ou `lastEventId` en requête : identifiant décimal. */
  const lastEventId = (request: FastifyRequest): string | undefined => {
    const header = request.headers['last-event-id'];
    const query = (request.query as Record<string, unknown>)['lastEventId'];
    const value = typeof header === 'string' && header.trim() !== '' ? header.trim() : query;
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) throw invalidOption([{ field: 'Last-Event-ID', reason: 'must be the id of a received event' }]);
    return value;
  };

  const openStream = (request: FastifyRequest, reply: FastifyReply, scope: { tenantId: string; sessionId?: string }, afterId: string | undefined, sessionFinished: boolean): FastifyReply => {
    const replayHistory = scope.sessionId !== undefined;
    reply.hijack();
    const opened: { stream?: OpenStream } = {};
    const stream = serveEventStream(reply.raw, {
      db: deps.db,
      hub,
      scope,
      afterId,
      replayHistory,
      sessionFinished,
      heartbeatMs,
      headers: { 'x-request-id': request.id },
      onError,
      onClose: () => {
        if (opened.stream !== undefined) streams.delete(opened.stream);
      },
    });
    opened.stream = stream;
    if (!reply.raw.writableEnded) streams.add(stream);
    return reply;
  };

  app.get('/v1/sessions/:id/events', { preHandler: authorize('sessions:read') }, async (request, reply) => {
    const view = await loadSession(request, (request.params as { id: string }).id);
    const afterId = lastEventId(request);
    return openStream(request, reply, { tenantId: view.tenantId, sessionId: view.id }, afterId, isTerminal(view.state));
  });

  app.get('/v1/events', { preHandler: authorize('sessions:read') }, async (request, reply) => {
    const afterId = lastEventId(request);
    return openStream(request, reply, { tenantId: principalOf(request).tenantId }, afterId, false);
  });

  // --- Webhooks (tâche 2.5) : réglage par l'admin du client, livraisons signées Standard Webhooks. ---
  if (deps.webhooks !== undefined) {
    const webhooks = deps.webhooks;
    registerTenantRoutes(app, { db: deps.db, authorize, principalOf, guard: webhooks.guard, keys: webhooks.keys });
    if (webhooks.dispatcher !== false) {
      const dispatcher = createWebhookDispatcher({ db: deps.db, guard: webhooks.guard, keys: webhooks.keys, onError, ...webhooks.dispatcher });
      app.addHook('onReady', async () => dispatcher.start());
      app.addHook('preClose', async () => dispatcher.stop());
    }
  }

  return app;
}
