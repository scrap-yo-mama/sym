// SPDX-License-Identifier: AGPL-3.0-only
// Classement minimal d'un échange ou d'une erreur de transport en classe d'échec (04 §7). C'est le socle des exécuteurs
// (tâche 1.6) : le classifieur complet et la garde de classification AVANT extraction (défi servi en 200, en-têtes et
// signatures de protection) sont la tâche 1.7, qui se branche par l'option `classify` de `runDeclarative`.
// Règles tenues dès ici : un 401, un 403 ou un 429 n'est jamais `network` (aucune escalade réseau, X4, INV6).
import { DslError } from '../dsl/errors.js';
import { findSsrfBlocked } from '../net/guard.js';
import { NetworkConfigError } from '../net/modes/definitions.js';
import { UpstreamProxyError } from '../net/modes/upstream.js';
import type { ExecFailure, HttpExchange } from './types.js';

const fail = (failure_class: ExecFailure['failure_class'], retryable: boolean, detail: string, status?: number): ExecFailure =>
  status === undefined ? { failure_class, retryable, detail } : { failure_class, retryable, detail, status };

/** Statut HTTP → classe ; `null` pour une réponse 2xx (le contenu est ensuite extrait). */
export function classifyStatus(status: number): ExecFailure | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return fail('auth_required', false, 'http_401', status);
  if (status === 402) return fail('payment_required', false, 'http_402', status);
  if (status === 403) return fail('forbidden', false, 'http_403', status);
  if (status === 404 || status === 410) return fail('not_found', false, `http_${status}`, status);
  if (status === 407) return fail('code_error', false, 'proxy_auth_failed', status);
  if (status === 408) return fail('transient', true, 'http_408', status);
  if (status === 429) return fail('rate_limited', true, 'http_429', status);
  if (status === 451) return fail('network', false, 'geo_restriction', status);
  if (status >= 500 && status < 600) return fail('transient', true, `http_${status}`, status);
  return fail('extraction', false, `http_${status}`, status);
}

/** Classement par défaut d'un échange : le statut seul (1.7 ajoute la garde de contenu). */
export function classifyExchange(exchange: HttpExchange): ExecFailure | null {
  return classifyStatus(exchange.status);
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
  const ssrf = findSsrfBlocked(error);
  if (ssrf !== undefined) return fail('forbidden', false, 'ssrf_blocked');
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
