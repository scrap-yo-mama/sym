// SPDX-License-Identifier: AGPL-3.0-only
// Replay d'une enquête ou d'une réparation (06 § 2, onglet Enquêtes) : les événements de `investigation_events` arrivent par
// le flux filtré `GET /api/runs/{id}/events` (même format que le flux de l'onglet, reprise par `Last-Event-ID`, rejoué
// depuis le début à la réouverture). Un client SSE par lecture, arrêté quand l'écran ferme ou change de run.
// Écart avec « un seul flux SSE par onglet » (06 § 3) consigné dans l'ADR 0004 : `GET /api/events` n'a pas d'abonnement
// à une enquête dans l'OpenAPI et ne rejoue pas depuis le début ; ce second flux n'existe que pendant la lecture.
import { tryOnScopeDispose } from '@vueuse/core';
import { readonly, ref, shallowRef } from 'vue';
import { parseReplayEvent, type ReplayEvent } from '@/lib/replay';
import { EventStreamClient, type EventStreamOptions, type StreamStatus } from '@/lib/sse';

export function useInvestigationReplay(clientOptions: Partial<EventStreamOptions> = {}) {
  const events = shallowRef<ReplayEvent[]>([]);
  const status = ref<StreamStatus>('idle');
  let client: EventStreamClient | null = null;

  /**
   * Ouvre la lecture d'un run ; un run déjà ouvert est remplacé. `live` : enquête en cours, suivie en direct (une fin de
   * réponse, par exemple au redémarrage du serveur, reconnecte avec `Last-Event-ID`). Sinon l'enquête est terminée : la
   * réponse est finie et sa fin arrête la lecture, sans boucle de reconnexion.
   */
  function open(runId: string, options: { live?: boolean } = {}): void {
    close();
    events.value = [];
    const next = new EventStreamClient({ url: `/api/runs/${encodeURIComponent(runId)}/events`, stopOnEnd: !options.live, ...clientOptions });
    client = next;
    next.onStatus((value) => {
      status.value = value;
    });
    next.onEvent((frame) => {
      const parsed = parseReplayEvent(frame, events.value.length + 1);
      if (parsed) events.value = [...events.value, parsed];
    });
    next.start();
  }

  /** L'enquête suivie en direct est terminée : la fin de la réponse arrête la lecture au lieu de reconnecter. */
  function markFinished(): void {
    client?.stopAtEnd();
  }

  function close(): void {
    client?.stop();
    client = null;
    status.value = 'idle';
  }

  tryOnScopeDispose(close);
  return { events: readonly(events), status: readonly(status), open, markFinished, close };
}
