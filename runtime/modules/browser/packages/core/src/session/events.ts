// SPDX-License-Identifier: AGPL-3.0-only
// Puits des événements de session (cdc/sym-browser 03 § 5 `session_events`, tâche 2.5) : le nœud y écrit ce que ses
// composants émettent (egress de la 1.5, téléchargements, enregistrements) ; la passerelle les relit pour les flux SSE et
// les webhooks. Interface seule : PostgreSQL dans `@sym-browser/db` (`createPgSessionEventSink`), le noyau n'a pas d'I/O.

/** Types d'événements de `session_events` (copie de `SESSION_EVENT_TYPES` du contrat, égalité vérifiée par un test). */
export const STORED_SESSION_EVENT_TYPES = [
  'state',
  'egress.blocked',
  'egress.budget_exceeded',
  'download',
  'recording.ready',
  'recording.truncated',
  'profile.save_failed',
  'storage_state.exported',
  'live.input',
] as const;
export type StoredSessionEventType = (typeof STORED_SESSION_EVENT_TYPES)[number];

export type SessionEventInput = {
  sessionId: string;
  type: StoredSessionEventType;
  /** Objet JSON ; jamais d'URL complète, de jeton ni de secret (BINV6). */
  data: Record<string, unknown>;
  /** Instant de l'événement chez l'émetteur ; défaut : instant de l'écriture. */
  at?: Date;
};

export interface SessionEventSink {
  append(event: SessionEventInput): Promise<void>;
}
