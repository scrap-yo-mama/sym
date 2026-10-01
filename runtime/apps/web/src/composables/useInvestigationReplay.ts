// SPDX-License-Identifier: AGPL-3.0-only
// Replay d'une enquête ou d'une réparation (06 § 2, onglet Enquêtes) : les événements de `investigation_events` arrivent par
// le flux filtré `GET /api/runs/{id}/events` (même format que le flux de l'onglet, reprise par `Last-Event-ID`, rejoué
// depuis le début à la réouverture). Un client SSE par lecture, arrêté quand l'écran ferme ou change de run, ou quand
// le serveur termine la réponse (enquête terminée : rien à reconnecter).
import { tryOnScopeDispose } from '@vueuse/core';
import { readonly, ref, shallowRef } from 'vue';
import { parseReplayEvent, type ReplayEvent } from '@/lib/replay';
import { EventStreamClient, type EventStreamOptions, type StreamStatus } from '@/lib/sse';

export function useInvestigationReplay(clientOptions: Partial<EventStreamOptions> = {}) {
  const events = shallowRef<ReplayEvent[]>([]);
  const status = ref<StreamStatus>('idle');
  let client: EventStreamClient | null = null;

  /** Ouvre la lecture d'un run ; un run déjà ouvert est remplacé. */
  function open(runId: string): void {
    close();
    events.value = [];
    const next = new EventStreamClient({ url: `/api/runs/${encodeURIComponent(runId)}/events`, stopOnEnd: true, ...clientOptions });
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

  function close(): void {
    client?.stop();
    client = null;
    status.value = 'idle';
  }

  tryOnScopeDispose(close);
  return { events: readonly(events), status: readonly(status), open, close };
}
