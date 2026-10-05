// SPDX-License-Identifier: AGPL-3.0-only
// Classifieur d'échec (tâche 1.7, 04 §7) et garde de classification AVANT extraction (04 §5, INV6) : chaque réponse est
// classée sur son code HTTP, ses en-têtes de protection, son contenu (page de défi servie en 200) et sa redirection
// (connexion, pays) avant que l'interpréteur n'y touche. Un refus détecté n'est jamais extrait ni réparé.
// Règles tenues : un 401, un 403 ou un 429 n'est jamais `network` (aucune escalade réseau, X4) ; un défi donne
// `blocked_by_protection` quel que soit le code (200 compris) ; les codes `detail` sont stables et ne contiennent
// jamais une valeur de la cible.
import { DslError } from '../dsl/errors.js';
import { findDomainNotAllowed } from '../net/domain-lock.js';
import { findSsrfBlocked } from '../net/guard.js';
import { NetworkConfigError } from '../net/modes/definitions.js';
import { ProxyBudgetExceededError } from '../net/modes/session.js';
import { UpstreamProxyError } from '../net/modes/upstream.js';
import { detectChallengePage, protectionSignal, vendorSignature } from './protection.js';
import type { ExecFailure, HttpExchange } from './types.js';

/**
 * Codes de journal d'une géo-restriction (04 §7) : 451, redirection vers une page de pays. Un « non » géographique ou
 * légal : jamais réessayé, jamais contourné (mode « SYM ne lâche pas », D-49). Tout code `geo_*` en est un.
 */
const GEO_RESTRICTION_DETAILS = ['geo_restriction', 'geo_redirect'] as const;

/** Vrai pour un code de journal de géo-restriction (`geo_*`, dont ceux de `GEO_RESTRICTION_DETAILS`). */
export function isGeoRestrictionDetail(detail: string | null | undefined): boolean {
  return typeof detail === 'string' && ((GEO_RESTRICTION_DETAILS as readonly string[]).includes(detail) || detail.startsWith('geo_'));
}

const fail = (failure_class: ExecFailure['failure_class'], retryable: boolean, detail: string, status?: number): ExecFailure =>
  status === undefined ? { failure_class, retryable, detail } : { failure_class, retryable, detail, status };

/** Statut HTTP seul → classe ; `null` pour une réponse 2xx. Socle de `classifyExchange`, qui ajoute les en-têtes et le contenu. */
export function classifyStatus(status: number): ExecFailure | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return fail('auth_required', false, 'http_401', status);
  if (status === 402) return fail('payment_required', false, 'http_402', status);
  if (status === 403) return fail('forbidden', false, 'http_403', status);
  if (status === 404 || status === 410) return fail('not_found', false, `http_${status}`, status);
  if (status === 407) return fail('code_error', false, 'proxy_auth_failed', status);
  if (status === 408) return fail('transient', true, 'http_408', status);
  if (status === 429) return fail('rate_limited', true, 'http_429', status);
  if (status === 451) return fail('network', false, GEO_RESTRICTION_DETAILS[0], status);
  if (status >= 500 && status < 600) return fail('transient', true, `http_${status}`, status);
  return fail('extraction', false, `http_${status}`, status);
}

/** Contexte facultatif du classement : l'URL demandée, pour reconnaître une redirection (connexion, pays). */
export type ClassifyContext = { readonly requestUrl?: string };

/** Chemins de connexion usuels (redirection d'une page protégée par session, cookie absent ou expiré). */
const LOGIN_PATH = /(?:^|\/)(?:log-?in|sign-?in|sign_in|signin|connexion|se-connecter|identification|authenticate|session\/new|sessions\/new|auth\/login|oauth\/authorize)(?:\/|\.[a-z]{2,5}\/?)?$/i;
/** Pages de géo-restriction usuelles (redirection de pays, 04 §7). */
const GEO_PATH = /(?:unavailable|not[-_]?available|restricted|blocked)[-_](?:in[-_])?(?:your[-_])?(?:country|region|location)|geo[-_]?(?:block|restrict)|country[-_]?(?:block|restrict)/i;

/** Vrai si le chemin est une page de connexion usuelle (`/login`, `/connexion`, `/auth/login`...). */
export function isLoginPath(path: string): boolean {
  return LOGIN_PATH.test(path);
}

function pathOf(url: string, base?: string): string | undefined {
  try {
    return new URL(url, base).pathname;
  } catch {
    return undefined;
  }
}

/** Redirection (suivie ou non) vers une page de connexion ou de géo-restriction ; `null` sinon. */
function redirectTarget(exchange: HttpExchange, context: ClassifyContext): ExecFailure | null {
  const requested = context.requestUrl === undefined ? undefined : pathOf(context.requestUrl);
  const location = exchange.status >= 300 && exchange.status < 400 ? exchange.headers['location'] : undefined;
  const target = location !== undefined ? pathOf(location, exchange.url) : requested === undefined ? undefined : pathOf(exchange.url);
  if (target === undefined || target === requested) return null;
  if (LOGIN_PATH.test(target) && !(requested !== undefined && LOGIN_PATH.test(requested))) return fail('auth_required', false, 'login_redirect', exchange.status);
  if (GEO_PATH.test(target)) return fail('network', false, GEO_RESTRICTION_DETAILS[1], exchange.status);
  return null;
}

/**
 * Garde de classification d'un échange (défaut de `runDeclarative` et des exécuteurs E1-E3) : `null` si la réponse
 * peut être extraite, sinon la classe d'échec. Ordre : en-tête de défi (tout statut), 401, signature d'éditeur sur un
 * 403, page de défi sur TOUT statut ≥ 400 (un défi servi en 400, 404 ou 405 n'est ni une `extraction` ni un
 * `not_found`, qui ouvriraient la réparation), page de défi sur un 2xx (mode strict : signal fort seulement),
 * redirection vers la connexion ou de pays, puis le statut seul.
 */
export function classifyExchange(exchange: HttpExchange, context: ClassifyContext = {}): ExecFailure | null {
  const { status, headers } = exchange;
  const header = protectionSignal(headers);
  if (header !== null) return fail('blocked_by_protection', false, header.code, status);
  if (status === 401) return fail('auth_required', false, 'http_401', status);
  if (status >= 400) {
    // Signature d'éditeur (en-tête seul) : « 403 signé » seulement (04 §7) ; l'en-tête d'un éditeur accompagne aussi les
    // réponses ordinaires (404, 429, 5xx) d'un site protégé. La page de défi, elle, compte sur tout refus.
    const signed = (status === 403 ? vendorSignature(headers) : null) ?? detectChallengePage(exchange.body, headers);
    if (signed !== null) return fail('blocked_by_protection', false, signed.code, status);
  }
  if (status >= 200 && status < 300) {
    const page = detectChallengePage(exchange.body, headers, { strict: true });
    if (page !== null) return fail('blocked_by_protection', false, page.code, status);
  }
  if ((status >= 200 && status < 400)) {
    const redirected = redirectTarget(exchange, context);
    if (redirected !== null) return redirected;
  }
  return classifyStatus(status);
}

/**
 * Refus constaté par le transport lui-même, avant que l'échange ne soit complet : par exemple une navigation du cadre
 * principal lancée par la page pendant l'attente du rendu (défi qui se résout seul en JavaScript puis recharge la page,
 * 04 §5, INV6). La classe est déjà décidée ; `exchange` est la réponse servie quand elle est connue (preuve, cadence).
 */
export class TransportRefusal extends Error {
  readonly failure: ExecFailure;
  readonly exchange: HttpExchange | undefined;
  constructor(failure: ExecFailure, exchange?: HttpExchange) {
    super(`refus du transport : ${failure.failure_class} (${failure.detail})`);
    this.name = 'TransportRefusal';
    this.failure = failure;
    this.exchange = exchange;
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const TRANSIENT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED']);
/** Erreurs réseau de Chromium (messages `net::ERR_*` relayés par Playwright). */
const CHROMIUM_NETWORK = /net::ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|INTERNET_DISCONNECTED|NAME_RESOLUTION_FAILED)/;
const CHROMIUM_TRANSIENT = /net::ERR_(TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|CONNECTION_ABORTED)/;

function errorCodes(error: unknown): { codes: string[]; names: string[]; messages: string[] } {
  const codes: string[] = [];
  const names: string[] = [];
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    names.push(current.name);
    messages.push(current.message);
    current = current.cause;
  }
  return { codes, names, messages };
}

/** Erreur levée par un transport → classe. Les messages d'origine ne sortent jamais (codes stables seulement). */
export function classifyTransportError(error: unknown): ExecFailure {
  if (error instanceof TransportRefusal) return error.failure;
  const ssrf = findSsrfBlocked(error);
  if (ssrf !== undefined) return fail('forbidden', false, 'ssrf_blocked');
  // Verrou de domaines (tâche 1.6) : une redirection ou une requête hors des domaines de l'API est une faute de stratégie.
  if (findDomainNotAllowed(error) !== undefined) return fail('code_error', false, 'domain_not_allowed');
  if (error instanceof ProxyBudgetExceededError || (error instanceof Error && error.cause instanceof ProxyBudgetExceededError)) {
    return fail('run_budget_exceeded', false, 'max_cost_usd');
  }
  if (error instanceof DslError) {
    if (error.code === 'host_not_allowed' || error.code === 'invalid_template' || error.code === 'unsupported') return fail('code_error', false, error.code);
    return fail('extraction', false, error.code);
  }
  if (error instanceof UpstreamProxyError) {
    return error.code === 'proxy_auth_failed' ? fail('code_error', false, 'proxy_auth_failed') : fail('network', true, 'proxy_unreachable');
  }
  if (error instanceof NetworkConfigError) return fail('code_error', false, 'network_config');
  const { codes, names, messages } = errorCodes(error);
  if (codes.some((c) => NETWORK_CODES.has(c))) return fail('network', true, 'connection_error');
  if (codes.some((c) => TRANSIENT_CODES.has(c)) || names.includes('TimeoutError')) return fail('transient', true, 'timeout_or_reset');
  if (messages.some((m) => m.includes('net::ERR_BLOCKED_BY_CLIENT'))) return fail('code_error', false, 'domain_not_allowed');
  if (messages.some((m) => CHROMIUM_NETWORK.test(m))) return fail('network', true, 'connection_error');
  if (messages.some((m) => CHROMIUM_TRANSIENT.test(m))) return fail('transient', true, 'timeout_or_reset');
  return fail('code_error', false, 'executor_error');
}
