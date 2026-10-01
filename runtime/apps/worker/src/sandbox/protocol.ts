// SPDX-License-Identifier: AGPL-3.0-only
// Protocole IPC parent ↔ enfant du bac à sable. L'enfant est traité comme compromis : le parent valide chaque message
// (forme, types, tailles) avant d'agir ; un message invalide tue l'enfant (`sandbox_violation`, raison `protocol`).
import type { SandboxEngineId, SandboxLimits } from '@runtime/core';

/** Signal par lequel l'enfant s'arrête de lui-même sur dépassement de sortie : l'hôte le lit comme `output_limit`. */
export const SIGNAL_OUTPUT_LIMIT = 'SIGUSR2';

export type RunMessage = {
  t: 'run';
  engine: SandboxEngineId;
  code: string;
  inputJson: string;
  limits: Required<Pick<SandboxLimits, 'timeoutMs' | 'memoryMb' | 'maxIpcBytes'>>;
};
type ReplyMessage = { t: 'reply'; id: number; ok: boolean; payload: string };
export type ParentMessage = RunMessage | ReplyMessage;

/** `engine_error` : le moteur d'isolat n'a pas pu démarrer dans l'enfant (pas une erreur du script). */
type ChildOutcome = 'ok' | 'script_error' | 'timeout' | 'memory' | 'engine_error';
/** Violations que l'enfant peut signaler lui-même (pièges de l'amorce, chargeur de modules). */
type ChildViolationReason = 'forbidden_global' | 'forbidden_import' | 'invalid_bridge_call' | 'output_limit';
const CHILD_VIOLATIONS = new Set<string>(['forbidden_global', 'forbidden_import', 'invalid_bridge_call', 'output_limit']);
export type ChildMessage =
  | { t: 'ready'; envKeys: string[]; node: string }
  | { t: 'rss'; mb: number }
  | { t: 'call'; id: number; bridge: 'fetch' | 'page'; payload: string }
  | { t: 'log'; payload: string }
  | { t: 'emit'; payload: string }
  | { t: 'violation'; reason: ChildViolationReason; detail: string }
  | { t: 'done'; outcome: ChildOutcome; value?: string; error?: string };

/**
 * Plafond d'une chaîne reçue de l'enfant (le résultat a son propre plafond, vérifié ensuite). Le canal IPC de Node lit
 * un message entier avant cette validation : sa taille reste bornée par le plafond RSS de l'enfant (README § Limites).
 */
const MAX_CHILD_STRING = 8 * 1024 * 1024;

const OUTCOMES = new Set<string>(['ok', 'script_error', 'timeout', 'memory', 'engine_error']);
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
      return int(m.id) && (m.bridge === 'fetch' || m.bridge === 'page') && str(m.payload)
        ? { t: 'call', id: m.id, bridge: m.bridge, payload: m.payload }
        : undefined;
    case 'log':
      return str(m.payload) ? { t: 'log', payload: m.payload } : undefined;
    case 'emit':
      return str(m.payload) ? { t: 'emit', payload: m.payload } : undefined;
    case 'violation':
      return typeof m.reason === 'string' && CHILD_VIOLATIONS.has(m.reason) && str(m.detail, 64)
        ? { t: 'violation', reason: m.reason as ChildViolationReason, detail: m.detail }
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
