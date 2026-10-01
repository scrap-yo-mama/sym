// SPDX-License-Identifier: AGPL-3.0-only
// Flux SSE unique de l'onglet (06 § 3) : ouvert tant que la session est authentifiée, fermé à la déconnexion. Les
// écrans s'y abonnent par `onStreamEvent` ; le bandeau de coupure lit `streamStatus`.
import { readonly, ref } from 'vue';
import { EventStreamClient, type SseEvent, type StreamStatus } from '@/lib/sse';

const EVENTS_URL = '/api/events';

const status = ref<StreamStatus>('idle');
let client: EventStreamClient | null = null;
const handlers = new Set<(event: SseEvent) => void>();

export function useEventStream() {
  return { streamStatus: readonly(status), onStreamEvent };
}

/** S'abonne aux événements du flux ; renvoie le désabonnement. */
function onStreamEvent(handler: (event: SseEvent) => void): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Ouvre le flux de l'onglet (une seule connexion, même si appelé plusieurs fois). `onUnauthorized` : session finie. */
export function startEventStream(onUnauthorized: () => void, factory: () => EventStreamClient = () => new EventStreamClient({ url: EVENTS_URL })): void {
  if (client) return;
  client = factory();
  client.onStatus((next) => {
    status.value = next;
  });
  client.onEvent((event) => {
    for (const handler of handlers) handler(event);
  });
  client.onUnauthorized(onUnauthorized);
  client.start();
}

export function stopEventStream(): void {
  client?.stop();
  client = null;
  status.value = 'idle';
}
