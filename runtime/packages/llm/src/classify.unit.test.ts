import { describe, expect, test } from 'vitest';
import { classifyFailure, parseRetryAfter } from './classify.js';
import { backoffDelay, FALLBACK_CLASSES, isFallbackEligible, LLM_ERROR_CLASSES, LlmError, NEVER_FALLBACK, RETRY_LIMITS, toFailureClass } from './errors.js';

const headers = (h: Record<string, string>) => new Headers(h);

describe('13 classes d\'erreur LLM', () => {
  test('la liste compte exactement 13 classes, toutes avec une limite de réessai', () => {
    expect(LLM_ERROR_CLASSES).toHaveLength(13);
    expect(Object.keys(RETRY_LIMITS).sort()).toEqual([...LLM_ERROR_CLASSES].sort());
    expect(toFailureClass('llm_refused')).toBe('llm_llm_refused');
  });

  test('limites de réessai de 08 §1', () => {
    expect(RETRY_LIMITS).toMatchObject({ rate_limited: 3, overloaded: 3, timeout: 1, network: 2, empty_response: 2, quota_exhausted: 0, auth: 0, llm_refused: 0, schema_invalid: 0, truncated: 0 });
  });

  test('le repli est réservé à overloaded, timeout, empty_response ; jamais pour quota, auth, refus', () => {
    expect([...FALLBACK_CLASSES].sort()).toEqual(['empty_response', 'overloaded', 'timeout']);
    for (const cls of NEVER_FALLBACK) expect(isFallbackEligible(new LlmError(cls, 'x'))).toBe(false);
    expect(isFallbackEligible(new LlmError('overloaded', 'x'))).toBe(true);
    // un stream_error suit la classe interne
    expect(isFallbackEligible(new LlmError('stream_error', 'x', { inner: 'overloaded' }))).toBe(true);
    expect(isFallbackEligible(new LlmError('stream_error', 'x', { inner: 'llm_refused' }))).toBe(false);
  });
});

describe('classifyFailure : par classe, pas par code HTTP', () => {
  const cls = (status: number, body: unknown) => classifyFailure({ status, body }).cls;
  test.each([
    [429, { error: { code: '1302', message: 'rate' } }, 'rate_limited'],
    [429, { error: { code: '1305', message: 'rate' } }, 'rate_limited'],
    [429, { error: { code: '1308', message: 'quota' } }, 'quota_exhausted'],
    [429, { error: { code: '1321', message: 'quota' } }, 'quota_exhausted'],
    [429, { error: { code: '1113', message: 'arrears' } }, 'quota_exhausted'],
    [429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }, 'quota_exhausted'],
    [429, { error: { message: 'Too many requests' } }, 'rate_limited'],
    [402, { error: { message: 'Insufficient credits' } }, 'quota_exhausted'],
    [401, { error: { message: 'Invalid API key' } }, 'auth'],
    [403, { error: { message: 'Forbidden' } }, 'auth'],
    [403, { error: { message: 'Your input was flagged by moderation' } }, 'llm_refused'],
    [400, { error: { code: 'content_filter', message: 'blocked' } }, 'llm_refused'],
    [400, { error: { code: 'context_length_exceeded', message: 'maximum context length is 8192' } }, 'context_length'],
    [413, {}, 'context_length'],
    [400, { error: { message: 'unknown parameter' } }, 'bad_request'],
    [422, { detail: { error: 'bad field' } }, 'bad_request'],
    [404, {}, 'bad_request'],
    [500, {}, 'overloaded'],
    [503, { error: { message: 'overloaded' } }, 'overloaded'],
    [529, {}, 'overloaded'],
    [504, {}, 'timeout'],
    [408, {}, 'timeout'],
  ] as const)('HTTP %i %j -> %s', (status, body, expected) => {
    expect(cls(status, body)).toBe(expected);
  });

  test('Retry-After : secondes, date HTTP, millisecondes', () => {
    expect(parseRetryAfter(headers({ 'retry-after': '3' }))).toBe(3000);
    expect(parseRetryAfter(headers({ 'retry-after-ms': '250' }))).toBe(250);
    expect(parseRetryAfter(headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:05 GMT' }), () => Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(5000);
    expect(parseRetryAfter(headers({}))).toBeUndefined();
  });

  test('backoff exponentiel avec gigue ; Retry-After est un plancher plafonné', () => {
    const fixed = () => 1; // gigue maximale
    expect(backoffDelay(0, undefined, fixed)).toBe(500);
    expect(backoffDelay(2, undefined, fixed)).toBe(2000);
    expect(backoffDelay(0, undefined, () => 0)).toBe(250);
    expect(backoffDelay(0, 4000, fixed)).toBe(4000);
    expect(backoffDelay(0, 10 * 60_000, fixed)).toBe(120_000);
    expect(backoffDelay(10, undefined, fixed)).toBe(15_000);
  });
});
