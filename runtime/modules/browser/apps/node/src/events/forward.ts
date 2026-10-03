// SPDX-License-Identifier: AGPL-3.0-only
// Relais des événements de l'egress d'une session (`egress.blocked`, `egress.budget_exceeded`, 04c § 1.5) vers le puits
// `session_events` (tâche 2.5), d'où la passerelle les sert en SSE et en webhooks. L'egress appelle `onEvent` de façon
// synchrone : l'écriture part aussitôt, dans l'ordre d'émission (chaîne de promesses), sans jamais bloquer ni lever vers
// l'egress ; un échec d'écriture est remis à `onError` (journal du nœud).
import type { SessionEventSink } from '@sym-browser/core';
import type { EgressEvent } from '../egress/index.js';

export type EgressEventForwarder = {
  /** À passer en `SessionEgressDeps.onEvent`. */
  onEvent(event: EgressEvent): void;
  /** Attend la fin des écritures en cours (destruction de la session, tests). */
  flush(): Promise<void>;
};

export function forwardEgressEvents(sessionId: string, sink: SessionEventSink, onError: (error: unknown) => void): EgressEventForwarder {
  let tail: Promise<void> = Promise.resolve();
  return {
    onEvent: (event) => {
      const at = new Date();
      tail = tail.then(() => sink.append({ sessionId, type: event.type, data: { ...event.data }, at })).catch((error: unknown) => onError(error));
    },
    flush: () => tail,
  };
}
