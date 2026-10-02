// SPDX-License-Identifier: AGPL-3.0-only
// API REST `/v1` des sessions (cdc/sym-browser 04 § 1 à § 9, 04f § 2 ; tâche 2.2), sur Fastify 5 (03 § 1) :
// créer (id réservable, type par défaut `dedicated`, attente du démarrage ou `wait=false`), lire (jetons renouvelés), lister
// (curseur stable, filtres), libérer (rejouable), prolonger (plafonnée), `GET /v1/version`, `GET /v1/openapi.json`.
// Toute session est vue au travers de son client : la session d'un autre client répond 404 (BINV7). Chaque réponse porte
// `X-Request-Id` ; chaque erreur suit 04 § 6. L'authentification, les jetons et le démarrage sur un nœud passent par les
// interfaces de types.ts (tâches 2.1, 2.3, 2.4).
import { randomBytes } from 'node:crypto';
import { endStateFor, isTerminal, resolveSessionType } from '@sym-browser/core';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  extendSession,
  getSessionView,
  insertSession,
  listSessionViews,
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
import { ApiProblem, invalidOption, preferredLanguage } from './errors.js';
import type { GatewayDeps, Principal, Scope } from './types.js';
import { isDateTime, parseCreateSession, parseExtendSession, UUID } from './validation.js';

/** Défauts de l'instance (04 § 3) et durée des jetons de connexion (04 § 7, « à valider, tâche 2.1 »). */
const SESSION_DEFAULTS = Object.freeze({ timeoutSeconds: 300, idleTimeoutSeconds: 60 });
const CONNECT_TOKEN_TTL_SECONDS = 300;
const RETRY_AFTER_SECONDS = 5;
const INVALID_BODY = Symbol('corps illisible');

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
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

  /** Clé d'API en `Authorization: Bearer` puis scope requis (04 § 1). */
  const authorize = (scope: Scope) => async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    const secret = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] : undefined;
    const principal = secret === undefined ? null : await deps.auth.authenticate(secret);
    if (!principal) throw new ApiProblem('unauthorized', 'Missing, unknown or expired API key.');
    if (!principal.scopes.includes(scope)) throw new ApiProblem('forbidden', `Scope ${scope} required.`, { details: { requiredScope: scope } });
    request.principal = principal;
  };
  const principalOf = (request: FastifyRequest): Principal => {
    if (!request.principal) throw new ApiProblem('unauthorized', 'Missing API key.');
    return request.principal;
  };

  const connectUrls = async (sessionId: string, type: SessionType): Promise<ConnectUrls> => {
    const url = async (protocol: 'playwright' | 'cdp') =>
      `${wsBase}/v1/sessions/${sessionId}/${protocol}?token=${encodeURIComponent(await deps.tokens.issue({ sessionId, protocol, ttlSeconds: CONNECT_TOKEN_TTL_SECONDS }))}`;
    return { cdp: type === 'dedicated' ? await url('cdp') : null, playwright: await url('playwright'), bidi: null };
  };

  /** Réponse `Session` (04 § 4) : `connectUrls` à jeton neuf pour une session `running` seulement. */
  const present = async (view: SessionView): Promise<Session> => ({
    id: view.id,
    state: view.state,
    type: view.type,
    ...(view.nodeRegion === null ? {} : { nodeRegion: view.nodeRegion }),
    ...(view.state === 'running' ? { connectUrls: await connectUrls(view.id, view.type) } : {}),
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
    if (claim.kind === 'replay') return reply.code(claim.status).header('idempotent-replayed', 'true').send(claim.body);
    try {
      const result = await run();
      await completeIdempotencyKey(deps.db, { ...scope, status: result.status, body: result.body });
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

  app.get('/v1/version', async () => version);
  app.get('/v1/openapi.json', async () => browserOpenApi);

  app.post('/v1/sessions', { preHandler: authorize('sessions:write') }, async (request, reply) => {
    const principal = principalOf(request);
    const query = request.query as Record<string, unknown>;
    const waitParam = query['wait'];
    if (waitParam !== undefined && waitParam !== 'true' && waitParam !== 'false') throw invalidOption([{ field: 'wait', reason: 'must be true or false' }]);
    const wait = waitParam !== 'false';
    const body = parseCreateSession(bodyOf(request));

    return idempotent(request, reply, 'createSession', `POST /v1/sessions?wait=${wait}`, body, async () => {
      const region = body.region ?? null;
      if (!(await readyNodeExists(deps.db, region))) throw new ApiProblem('no_node', 'No ready node in the requested region.', { retryAfter: RETRY_AFTER_SECONDS });
      const { type } = resolveSessionType(body);
      const timeoutSeconds = body.timeoutSeconds ?? defaults.timeoutSeconds;
      const idleTimeoutSeconds = body.idleTimeoutSeconds ?? defaults.idleTimeoutSeconds;
      const { id: _id, region: _region, metadata, egress, ...rest } = body;
      const inserted = await insertSession(deps.db, {
        ...(body.id === undefined ? {} : { id: body.id }),
        tenantId: principal.tenantId,
        apiKeyId: principal.apiKeyId,
        type,
        region,
        timeoutSeconds,
        options: { ...rest, type, timeoutSeconds, idleTimeoutSeconds },
        egressPolicy: (egress ?? {}) as Record<string, unknown>,
        metadata: metadata ?? {},
      });
      if (!inserted.ok) throw new ApiProblem('session_id_taken', 'Session id already taken.');
      const session = inserted.session;
      const launch = deps.launcher.launch({
        sessionId: session.id,
        tenantId: principal.tenantId,
        type,
        region,
        options: body,
        expiresAt: session.expiresAt,
        idleTimeoutSeconds,
      });

      if (!wait) {
        // Démarrage en arrière-plan : la session passe `running` (ou `failed`) sans l'appelant.
        void launch
          .then((outcome) => (outcome.ok ? undefined : failPending(session.id, 'crash')))
          .catch((error: unknown) => {
            onError(error);
            return failPending(session.id, 'crash');
          })
          .catch(onError);
        return { status: 202, body: await present(session) };
      }

      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        launch.catch((error: unknown) => {
          onError(error);
          return { ok: false as const, code: 'launch_failed' as const };
        }),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), queueTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (outcome === 'timeout') {
        await failPending(session.id, 'quota');
        throw new ApiProblem('capacity_exceeded', 'Session not started within the queue timeout.', { retryAfter: RETRY_AFTER_SECONDS });
      }
      if (!outcome.ok) {
        await failPending(session.id, 'crash');
        throw new ApiProblem('no_node', 'No node could start the session.', { retryAfter: RETRY_AFTER_SECONDS });
      }
      const started = (await getSessionView(deps.db, { tenantId: principal.tenantId, sessionId: session.id })) ?? session;
      return { status: 201, body: await present(started) };
    });
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
    return { data: await Promise.all(page.data.map(present)), nextCursor: page.hasMore && last ? encodeCursor(last.position) : null };
  });

  app.get('/v1/sessions/:id', { preHandler: authorize('sessions:read') }, async (request) => present(await loadSession(request, (request.params as { id: string }).id)));

  app.delete('/v1/sessions/:id', { preHandler: authorize('sessions:write') }, async (request) => {
    const view = await loadSession(request, (request.params as { id: string }).id);
    if (isTerminal(view.state)) return present(view);
    // Libération : le nœud qui tient la session la détruit puis écrit `ended` (04c § 3.2) ; sinon la passerelle l'écrit.
    if ((await deps.launcher.release(view.id)) === 'not_held') {
      const to = endStateFor(view.state, 'released');
      if (to !== undefined) await transitionSession(deps.db, { sessionId: view.id, to, reason: 'released' });
    }
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

  return app;
}
