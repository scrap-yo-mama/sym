// SPDX-License-Identifier: AGPL-3.0-only
// Décisions d'accès (BINV7, cdc/sym-browser 04 § 1, § 6, § 7 ; 04f § 3 ; tâche 2.1), sans dépendance au serveur HTTP :
//   - authorizeRequest : REST, clé d'API en `Authorization: Bearer`, scope requis (401 unauthorized, 403 forbidden) ;
//   - authorizeConnection : ouverture d'une WebSocket ou de `json/version` (Playwright, CDP, vue en direct), jeton de session
//     en query `token` ou en `Bearer`, ou clé d'API en `Bearer` ; décidée avant tout octet vers un nœud.
// Le motif (`reason`) est destiné au journal de la passerelle ; le client ne reçoit que le code HTTP et `code` (04 § 6).
import { API_KEY_PREFIX, CONNECT_TOKEN_PREFIX } from './api-key.js';
import type { ApiKeyAuthenticator, ApiKeyFailure } from './authenticator.js';
import type { ConnectProtocol, ConnectTokens, TokenFailure } from './connect-token.js';
import type { ApiScope } from './scopes.js';

/** En-têtes de requête (compatible `IncomingHttpHeaders` et `request.headers` de Fastify). */
export type HeadersLike = { authorization?: string | string[] | undefined };

type Unauthorized<R extends string> = { ok: false; status: 401; code: 'unauthorized'; reason: R };
type Forbidden = { ok: false; status: 403; code: 'forbidden'; reason: 'missing_scope'; requiredScope: ApiScope };

const unauthorized = <R extends string>(reason: R): Unauthorized<R> => ({ ok: false, status: 401, code: 'unauthorized', reason });
const forbidden = (requiredScope: ApiScope): Forbidden => ({ ok: false, status: 403, code: 'forbidden', reason: 'missing_scope', requiredScope });

/** Valeur d'un en-tête `Authorization: Bearer <valeur>` (schéma insensible à la casse, une seule valeur) ; `null` sinon. */
export function bearerOf(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  return /^Bearer +([^\s]+)$/i.exec(header)?.[1] ?? null;
}

export type RequestDecision =
  | { ok: true; principal: { tenantId: string; apiKeyId: string; scopes: readonly ApiScope[] } }
  | Unauthorized<'missing' | ApiKeyFailure>
  | Forbidden;

/** REST : clé d'API en Bearer puis scope (aucun scope n'en implique un autre). */
export async function authorizeRequest(auth: Pick<ApiKeyAuthenticator, 'check'>, headers: HeadersLike, scope: ApiScope): Promise<RequestDecision> {
  const secret = bearerOf(headers.authorization);
  if (secret === null) return unauthorized('missing');
  const result = await auth.check(secret);
  if (!result.ok) return unauthorized(result.reason);
  if (!result.principal.scopes.includes(scope)) return forbidden(scope);
  return { ok: true, principal: result.principal };
}

/** État d'une session vu par la passerelle (ligne `sessions`) ; `null` : inconnue. */
export type SessionAccess = { tenantId: string; state: string };

export type ConnectionDeps = {
  auth: Pick<ApiKeyAuthenticator, 'check'>;
  tokens: Pick<ConnectTokens, 'verify'>;
  /** Lecture de la session visée, après authentification seulement. */
  session: (sessionId: string) => Promise<SessionAccess | null>;
};

export type ConnectionInput = {
  sessionId: string;
  protocol: ConnectProtocol;
  headers?: HeadersLike;
  /** Query de l'URL d'upgrade ; seule `token` est lue. */
  query?: { token?: string | string[] | undefined };
};

export type ConnectionFailure = 'missing' | 'api_key_in_query' | 'session_not_found' | 'session_not_running' | ApiKeyFailure | TokenFailure;

export type ConnectionDecision =
  | { ok: true; via: 'connect_token'; tenantId: string }
  | { ok: true; via: 'api_key'; tenantId: string; apiKeyId: string }
  | Unauthorized<ConnectionFailure>
  | Forbidden;

/** Scope qu'une clé d'API doit porter pour ouvrir ce protocole : piloter demande `sessions:write`, regarder `sessions:read`. */
export function connectionScope(protocol: ConnectProtocol): ApiScope {
  return protocol === 'live' ? 'sessions:read' : 'sessions:write';
}

/**
 * Ouverture d'une connexion à une session. L'en-tête `Authorization` fait foi s'il est présent (un en-tête invalide n'est
 * pas rattrapé par la query) ; sinon la query `token`. Une clé d'API n'est acceptée qu'en en-tête. Un jeton n'ouvre que sa
 * session et son protocole ; la session doit exister, appartenir au client et être `running` (refus dès sa fin).
 */
export async function authorizeConnection(deps: ConnectionDeps, input: ConnectionInput): Promise<ConnectionDecision> {
  const header = input.headers?.authorization;
  let credential: string;
  if (header !== undefined && header !== '') {
    const bearer = bearerOf(header);
    if (bearer === null) return unauthorized('malformed');
    credential = bearer;
  } else {
    const token = input.query?.token;
    if (Array.isArray(token)) return unauthorized('malformed');
    if (token === undefined || token === '') return unauthorized('missing');
    if (token.startsWith(API_KEY_PREFIX)) return unauthorized('api_key_in_query');
    credential = token;
  }

  if (credential.startsWith(CONNECT_TOKEN_PREFIX)) {
    const checked = deps.tokens.verify(credential, { sessionId: input.sessionId, protocol: input.protocol });
    if (!checked.ok) return unauthorized(checked.reason);
    const session = await deps.session(input.sessionId);
    if (!session) return unauthorized('session_not_found');
    if (session.state !== 'running') return unauthorized('session_not_running');
    return { ok: true, via: 'connect_token', tenantId: session.tenantId };
  }

  const result = await deps.auth.check(credential);
  if (!result.ok) return unauthorized(result.reason);
  const scope = connectionScope(input.protocol);
  if (!result.principal.scopes.includes(scope)) return forbidden(scope);
  const session = await deps.session(input.sessionId);
  // Session d'un autre client : même réponse qu'une session inconnue (aucune fuite d'existence).
  if (!session || session.tenantId !== result.principal.tenantId) return unauthorized('session_not_found');
  if (session.state !== 'running') return unauthorized('session_not_running');
  return { ok: true, via: 'api_key', tenantId: session.tenantId, apiKeyId: result.principal.apiKeyId };
}
