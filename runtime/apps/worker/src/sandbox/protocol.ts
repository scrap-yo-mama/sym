// SPDX-License-Identifier: AGPL-3.0-only
// Protocole IPC parent ↔ enfant du bac à sable. L'enfant est traité comme compromis : le parent valide chaque message
// (forme, types, tailles) avant d'agir ; un message invalide tue l'enfant (`sandbox_violation`, raison `protocol`).
import type { SandboxEngineId, SandboxLimits } from '@runtime/core';

export type RunMessage = {
  t: 'run';
  engine: SandboxEngineId;
  code: string;
  inputJson: string;
  limits: Required<Pick<SandboxLimits, 'timeoutMs' | 'memoryMb'>>;
};
type ReplyMessage = { t: 'reply'; id: number; ok: boolean; payload: string };
export type ParentMessage = RunMessage | ReplyMessage;

type ChildOutcome = 'ok' | 'script_error' | 'timeout' | 'memory';
export type ChildMessage =
  | { t: 'ready'; envKeys: string[]; node: string }
  | { t: 'rss'; mb: number }
  | { t: 'call'; id: number; bridge: 'fetch'; payload: string }
  | { t: 'log'; payload: string }
  | { t: 'emit'; payload: string }
  | { t: 'violation'; reason: 'forbidden_global' | 'invalid_bridge_call'; detail: string }
  | { t: 'done'; outcome: ChildOutcome; value?: string; error?: string };

/** Plafond d'une chaîne reçue de l'enfant (le résultat a son propre plafond, vérifié ensuite). */
const MAX_CHILD_STRING = 8 * 1024 * 1024;

const OUTCOMES = new Set<string>(['ok', 'script_error', 'timeout', 'memory']);
const str = (v: unknown, max = MAX_CHILD_STRING): v is string => typeof v === 'string' && v.length <= max;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Valide un message de l'enfant ; `undefined` si invalide. */
export function parseChildMessage(raw: unknown): ChildMessage | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'ready':
      return Array.isArray(m.envKeys) && m.envKeys.length <= 10_000 && m.envKeys.every((k) => str(k, 1024)) && str(m.node, 64)
        ? { t: 'ready', envKeys: m.envKeys as string[], node: m.node }
        : undefined;
    case 'rss':
      return int(m.mb) ? { t: 'rss', mb: m.mb } : undefined;
    case 'call':
      return int(m.id) && m.bridge === 'fetch' && str(m.payload) ? { t: 'call', id: m.id, bridge: 'fetch', payload: m.payload } : undefined;
    case 'log':
      return str(m.payload) ? { t: 'log', payload: m.payload } : undefined;
    case 'emit':
      return str(m.payload) ? { t: 'emit', payload: m.payload } : undefined;
    case 'violation':
      return (m.reason === 'forbidden_global' || m.reason === 'invalid_bridge_call') && str(m.detail, 64)
        ? { t: 'violation', reason: m.reason, detail: m.detail }
        : undefined;
    case 'done':
      if (typeof m.outcome !== 'string' || !OUTCOMES.has(m.outcome)) return undefined;
      if (m.value !== undefined && !str(m.value)) return undefined;
      if (m.error !== undefined && !str(m.error, 1000)) return undefined;
      return { t: 'done', outcome: m.outcome as ChildOutcome, value: m.value as string | undefined, error: m.error as string | undefined };
    default:
      return undefined;
  }
}
