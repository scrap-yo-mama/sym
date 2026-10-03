// SPDX-License-Identifier: MIT
// Erreur unique du SDK : erreurs typées de l'API (04 § 6 : `code`, `retryable`, `what_to_do`, `requestId`, `details`,
// `Retry-After`) et erreurs propres au client (réseau, réponse illisible, session pas `running`, délai). La clé d'API
// n'apparaît jamais dans le message.
import type { ErrorCode } from '@sym/contracts/browser';

/** Codes de l'API (04 § 6) et codes du client. */
export type SymBrowserErrorCode = ErrorCode | 'http_error' | 'network_error' | 'session_not_running' | 'timeout';

export type SymBrowserErrorInit = {
  code: SymBrowserErrorCode;
  message: string;
  status?: number;
  retryable?: boolean;
  whatToDo?: string;
  requestId?: string;
  details?: unknown;
  retryAfterSeconds?: number;
  cause?: unknown;
};

export class SymBrowserError extends Error {
  override name = 'SymBrowserError';
  readonly code: SymBrowserErrorCode;
  /** Statut HTTP ; absent pour une erreur réseau ou du client. */
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** Phrase d'action de l'API (`what_to_do`), en français ou en anglais selon `Accept-Language`. */
  readonly whatToDo: string | undefined;
  readonly requestId: string | undefined;
  readonly details: unknown;
  /** `Retry-After` des réponses 429 et 503, en secondes. */
  readonly retryAfterSeconds: number | undefined;

  constructor(init: SymBrowserErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.whatToDo = init.whatToDo;
    this.requestId = init.requestId;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

type ApiErrorBody = { error?: { code?: unknown; message?: unknown; retryable?: unknown; what_to_do?: unknown; requestId?: unknown; details?: unknown } };

/** Erreur d'une réponse HTTP non 2xx : corps typé de l'API si présent, sinon `http_error`. */
export function errorFromResponse(status: number, headers: Headers, text: string): SymBrowserError {
  const retryAfter = Number(headers.get('retry-after'));
  const retryAfterSeconds = Number.isFinite(retryAfter) && headers.get('retry-after') !== null ? retryAfter : undefined;
  let body: ApiErrorBody | undefined;
  try {
    body = JSON.parse(text) as ApiErrorBody;
  } catch {
    body = undefined;
  }
  const error = body?.error;
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return new SymBrowserError({
      code: error.code as ErrorCode,
      message: error.message,
      status,
      retryable: error.retryable === true,
      ...(typeof error.what_to_do === 'string' ? { whatToDo: error.what_to_do } : {}),
      ...(typeof error.requestId === 'string' ? { requestId: error.requestId } : {}),
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  const requestId = headers.get('x-request-id');
  return new SymBrowserError({
    code: 'http_error',
    message: `HTTP ${status} sans corps d'erreur de l'API`,
    status,
    retryable: status >= 500 || status === 429,
    ...(requestId === null ? {} : { requestId }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}
