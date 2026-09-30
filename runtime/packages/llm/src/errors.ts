// 13 classes d'erreur LLM (08 §1) : la décision se prend par classe, jamais par code HTTP.
import type { ChatResult, RawUsage } from './types.js';

export const LLM_ERROR_CLASSES = [
  'rate_limited',
  'overloaded',
  'timeout',
  'network',
  'empty_response',
  'quota_exhausted',
  'auth',
  'llm_refused',
  'bad_request',
  'context_length',
  'truncated',
  'schema_invalid',
  'stream_error',
] as const;

export type LlmErrorClass = (typeof LLM_ERROR_CLASSES)[number];

/** Nom sous lequel la classe entre dans le classifieur d'échec (04 §7, `failure_class: llm_*`). */
export function toFailureClass(cls: LlmErrorClass): `llm_${LlmErrorClass}` {
  return `llm_${cls}`;
}

export interface LlmErrorInit {
  status?: number;
  code?: string | number;
  retryAfterMs?: number;
  /** Classe interne d'un `stream_error` : la table de réessai s'applique à elle. */
  inner?: LlmErrorClass;
  /** Usage facturé d'une tentative échouée (réponse tronquée, flux coupé) : imputé au run. */
  usage?: RawUsage | null;
  /** Réponse partielle (truncated). Jamais journalisée par défaut. */
  partial?: ChatResult;
  cause?: unknown;
}

export class LlmError extends Error {
  readonly class: LlmErrorClass;
  readonly status: number | undefined;
  readonly code: string | number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly inner: LlmErrorClass | undefined;
  readonly usage: RawUsage | null;
  readonly partial: ChatResult | undefined;

  constructor(cls: LlmErrorClass, detail: string, init: LlmErrorInit = {}) {
    super(`${toFailureClass(cls)}: ${detail}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'LlmError';
    this.class = cls;
    this.status = init.status;
    this.code = init.code;
    this.retryAfterMs = init.retryAfterMs;
    this.inner = init.inner;
    this.usage = init.usage ?? null;
    this.partial = init.partial;
  }

  /** Classe qui pilote réessai et repli : celle d'un `stream_error` est sa classe interne. */
  get policyClass(): LlmErrorClass {
    return this.class === 'stream_error' ? (this.inner ?? 'network') : this.class;
  }

  get failureClass(): `llm_${LlmErrorClass}` {
    return toFailureClass(this.class);
  }
}

/** Réessais (hors première tentative) par classe : 08 §1. `context_length` : 1 essai seulement si l'appelant sait tronquer. */
export const RETRY_LIMITS: Record<LlmErrorClass, number> = {
  rate_limited: 3,
  overloaded: 3,
  timeout: 1,
  network: 2,
  empty_response: 2,
  quota_exhausted: 0,
  auth: 0,
  llm_refused: 0,
  bad_request: 0,
  context_length: 0,
  truncated: 0,
  schema_invalid: 0,
  stream_error: 0,
};

/** Le repli est facultatif par rôle et ne se déclenche que sur ces classes (après épuisement des réessais). */
export const FALLBACK_CLASSES: ReadonlySet<LlmErrorClass> = new Set<LlmErrorClass>(['overloaded', 'timeout', 'empty_response']);

/** Jamais de repli : un autre modèle ne doit pas servir à contourner un refus, un quota ou une clé refusée. */
export const NEVER_FALLBACK: ReadonlySet<LlmErrorClass> = new Set<LlmErrorClass>(['quota_exhausted', 'auth', 'llm_refused']);

export function isFallbackEligible(error: LlmError): boolean {
  const cls = error.policyClass;
  return FALLBACK_CLASSES.has(cls) && !NEVER_FALLBACK.has(cls) && !NEVER_FALLBACK.has(error.class);
}

export interface Backoff {
  baseMs: number;
  maxMs: number;
  /** Plafond appliqué à `Retry-After`. */
  maxRetryAfterMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { baseMs: 500, maxMs: 15_000, maxRetryAfterMs: 120_000 };

/** Backoff exponentiel avec gigue ; `Retry-After` du fournisseur est un plancher. */
export function backoffDelay(attempt: number, retryAfterMs: number | undefined, random: () => number, backoff: Backoff = DEFAULT_BACKOFF): number {
  const exp = Math.min(backoff.maxMs, backoff.baseMs * 2 ** attempt);
  const jittered = Math.round(exp * (0.5 + 0.5 * random()));
  if (retryAfterMs === undefined) return jittered;
  return Math.max(jittered, Math.min(retryAfterMs, backoff.maxRetryAfterMs));
}
