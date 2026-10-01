// SPDX-License-Identifier: AGPL-3.0-only
// Rafraîchissement d'un écran (06 § 3) : relecture périodique (catalogue : 15 s) et relecture à chaque événement du flux
// SSE qui le concerne. La relecture plutôt que la lecture de la charge : le contrat des charges est celui du serveur
// (3.1), la source de vérité reste la réponse REST. Les relectures rapprochées sont fusionnées.
import { tryOnMounted, tryOnScopeDispose } from '@vueuse/core';
import { useEventStream } from '@/composables/useEventStream';
import type { SseEvent } from '@/lib/sse';

export type LiveRefreshOptions = {
  /** Période de la relecture périodique en millisecondes ; 0 ou absent : aucune. */
  pollMs?: number;
  /** Noms d'événements SSE qui déclenchent une relecture. */
  events: readonly string[];
  /** Filtre fin sur la trame (par exemple « cette API seulement ») ; absent : toute trame du bon nom. */
  accepts?: (event: SseEvent) => boolean;
  /** Vrai : le suivi est suspendu par l'utilisateur (WCAG 2.2.2), aucune relecture automatique ne part. */
  paused?: () => boolean;
  /** Fusionne les relectures déclenchées dans cette fenêtre (défaut 250 ms). */
  debounceMs?: number;
};

export function useLiveRefresh(refresh: () => void | Promise<void>, options: LiveRefreshOptions): void {
  const { onStreamEvent } = useEventStream();
  let pending: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopListening: (() => void) | undefined;

  // Une relecture lancée par une minuterie ou par le flux est sautée tant que le suivi est suspendu.
  const refreshUnlessPaused = () => {
    if (!options.paused?.()) void refresh();
  };

  const schedule = () => {
    clearTimeout(pending);
    pending = setTimeout(refreshUnlessPaused, options.debounceMs ?? 250);
  };

  tryOnMounted(() => {
    stopListening = onStreamEvent((event) => {
      if (options.events.includes(event.event) && (options.accepts?.(event) ?? true)) schedule();
    });
    if (options.pollMs && options.pollMs > 0) timer = setInterval(refreshUnlessPaused, options.pollMs);
  });

  tryOnScopeDispose(() => {
    stopListening?.();
    clearTimeout(pending);
    clearInterval(timer);
  });
}
