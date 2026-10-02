// SPDX-License-Identifier: AGPL-3.0-only
// Persistance des transitions (tâche 1.2) vue par le nœud et la passerelle : interface `SessionStore`, implémentée sur
// PostgreSQL par `@sym-browser/db` (createPgSessionStore) et en mémoire ici (tests, modèle de référence). Chaque transition
// acceptée est écrite avec sa date et laisse un événement `state` (04 § 5).
import type { EndReason, SessionState } from '@sym/contracts/browser';
import { checkTransition, extendedExpiry, isTerminal } from './machine.js';

export type TransitionInput = {
  sessionId: string;
  to: SessionState;
  reason: EndReason | null;
  /** Nœud propriétaire, posé au passage en `running` (table de routage, AD4). */
  nodeId?: string;
};

export type TransitionOutcome =
  | { ok: true; previous: SessionState; state: SessionState; endReason?: EndReason; at: number }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'invalid_transition'; current: SessionState };

export type ExtendOutcome =
  | { ok: true; expiresAt: number }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'invalid_state'; current: SessionState };

export interface SessionStore {
  transition(input: TransitionInput): Promise<TransitionOutcome>;
  /** Prolongation plafonnée par la durée maximale du client (04 § 3). */
  extend(input: { sessionId: string; seconds: number }): Promise<ExtendOutcome>;
}

export type StateEvent = { state: SessionState; endReason?: EndReason; at: number };

export type MemorySession = {
  state: SessionState;
  nodeId?: string;
  endReason?: EndReason;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  expiresAt: number;
  maxDurationSeconds: number;
};

export type MemorySessionStore = SessionStore & {
  create(input: { sessionId: string; createdAt: number; expiresAt: number; maxDurationSeconds?: number }): void;
  get(sessionId: string): Readonly<MemorySession> | undefined;
  events(sessionId: string): readonly StateEvent[];
};

/** Magasin en mémoire : mêmes règles que la base (table de 04 § 5, dates de début et de fin, raison sur les états terminaux). */
export function createMemorySessionStore(options: { now?: () => number } = {}): MemorySessionStore {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, MemorySession>();
  const log = new Map<string, StateEvent[]>();
  return {
    create({ sessionId, createdAt, expiresAt, maxDurationSeconds = 3600 }) {
      if (sessions.has(sessionId)) throw new Error(`session ${sessionId} déjà créée`);
      sessions.set(sessionId, { state: 'pending', createdAt, expiresAt, maxDurationSeconds });
      log.set(sessionId, []);
    },
    get: (sessionId) => sessions.get(sessionId),
    events: (sessionId) => log.get(sessionId) ?? [],
    async transition({ sessionId, to, reason, nodeId }) {
      const session = sessions.get(sessionId);
      if (!session) return { ok: false, code: 'not_found' };
      if (!checkTransition(session.state, to, reason).ok) return { ok: false, code: 'invalid_transition', current: session.state };
      const previous = session.state;
      const at = now();
      session.state = to;
      if (to === 'running') {
        session.startedAt = at;
        if (nodeId !== undefined) session.nodeId = nodeId;
      }
      if (isTerminal(to) && reason !== null) {
        session.endReason = reason;
        session.endedAt = at;
      }
      const event: StateEvent = reason === null ? { state: to, at } : { state: to, endReason: reason, at };
      log.get(sessionId)?.push(event);
      return reason === null ? { ok: true, previous, state: to, at } : { ok: true, previous, state: to, endReason: reason, at };
    },
    async extend({ sessionId, seconds }) {
      const session = sessions.get(sessionId);
      if (!session) return { ok: false, code: 'not_found' };
      if (isTerminal(session.state)) return { ok: false, code: 'invalid_state', current: session.state };
      session.expiresAt = extendedExpiry({ createdAt: session.createdAt, expiresAt: session.expiresAt, seconds, maxDurationSeconds: session.maxDurationSeconds });
      return { ok: true, expiresAt: session.expiresAt };
    },
  };
}
