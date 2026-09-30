// Classement d'une réponse d'échec : par classe, pas par code HTTP (z.ai : 429 avec 1302/1305 réessayable, 1308 à 1321 et 1113 non).
import type { LlmErrorClass } from './errors.js';

export interface FailureInfo {
  cls: LlmErrorClass;
  code: string | number | undefined;
  /** Message du fournisseur, tronqué. Peut citer l'entrée : jamais journalisé hors erreur. */
  detail: string;
  retryAfterMs: number | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Extrait `{code, type, message}` des formes d'erreur rencontrées (OpenAI, OpenRouter, z.ai, DeepInfra). */
export function extractErrorFields(body: unknown): { code: string | number | undefined; type: string | undefined; message: string } {
  let node: unknown = body;
  if (isRecord(node) && 'detail' in node && !('error' in node)) node = node['detail'];
  if (isRecord(node) && 'error' in node) node = node['error'];
  if (typeof node === 'string') return { code: undefined, type: undefined, message: node };
  if (!isRecord(node)) return { code: undefined, type: undefined, message: '' };
  const codeRaw = node['code'];
  const code = typeof codeRaw === 'string' || typeof codeRaw === 'number' ? codeRaw : undefined;
  const type = typeof node['type'] === 'string' ? node['type'] : undefined;
  const message = typeof node['message'] === 'string' ? node['message'] : typeof node['error'] === 'string' ? node['error'] : '';
  return { code, type, message };
}

export function parseRetryAfter(headers: { get(name: string): string | null }, now: () => number = Date.now): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.round(Number(ms));
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const v = raw.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}

const ZAI_RATE = new Set([1302, 1305]);
const ZAI_QUOTA = (n: number) => (n >= 1308 && n <= 1321) || n === 1113;
const ZAI_REFUSED = new Set([1301]);
const ZAI_AUTH = new Set([1000, 1001, 1002, 1003, 1004]);

const RE_QUOTA = /insufficient[_ ](quota|balance|credits?|funds)|exceeded your current quota|billing|out of credits|payment required|credit balance/i;
const RE_CONTEXT = /context[_ ]length|maximum context|too many tokens|prompt is too long|reduce the length|exceeds the (model|context)/i;
const RE_REFUSED = /content[_ ]?(policy|filter)|flagged|moderation|safety|responsible ai|refus/i;
const RE_AUTH = /invalid[_ ]api[_ ]key|incorrect api key|unauthorized|authentication|invalid[_ ]auth|no auth/i;

function numericCode(code: string | number | undefined): number | undefined {
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  return undefined;
}

export function classifyFailure(input: { status: number; body: unknown; retryAfterMs?: number }): FailureInfo {
  const { status, body, retryAfterMs } = input;
  const { code, type, message } = extractErrorFields(body);
  const detail = message.slice(0, 300);
  const make = (cls: LlmErrorClass): FailureInfo => ({ cls, code, detail, retryAfterMs });
  const n = numericCode(code);
  const haystack = `${typeof code === 'string' ? code : ''} ${type ?? ''} ${message}`;

  if (n !== undefined) {
    if (ZAI_RATE.has(n)) return make('rate_limited');
    if (ZAI_QUOTA(n)) return make('quota_exhausted');
    if (ZAI_REFUSED.has(n)) return make('llm_refused');
    if (ZAI_AUTH.has(n)) return make('auth');
  }
  if (status === 402 || RE_QUOTA.test(haystack)) return make('quota_exhausted');
  if (RE_CONTEXT.test(haystack) || status === 413) return make('context_length');
  if (RE_REFUSED.test(haystack) && status < 500 && status !== 429) return make('llm_refused');
  if (status === 401 || status === 403 || RE_AUTH.test(haystack)) return make('auth');
  if (status === 429) return make('rate_limited');
  if (status === 408 || status === 504) return make('timeout');
  if (status >= 500) return make('overloaded');
  return make('bad_request');
}
