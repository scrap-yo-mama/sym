// SPDX-License-Identifier: AGPL-3.0-only
// Lecteur de replay (06 § 2) : vitesses 0,5x à 4x, pause, saut de phase en phase, recherche. L'état est un simple compteur
// d'événements affichés ; le temps passe par `schedule`, injectable pour les tests.
import { tryOnScopeDispose } from '@vueuse/core';
import { computed, ref, type Ref } from 'vue';
import { delayBefore, phaseStarts, type ReplayEvent, type ReplaySpeed } from '@/lib/replay';

type Schedule = (callback: () => void, ms: number) => () => void;

const browserSchedule: Schedule = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

export function useReplayPlayer(events: Readonly<Ref<readonly ReplayEvent[]>>, schedule: Schedule = browserSchedule) {
  /** Nombre d'événements déjà affichés. */
  const shown = ref(0);
  const playing = ref(false);
  const speed = ref<ReplaySpeed>(1);
  let cancel: (() => void) | null = null;

  function tick(): void {
    cancel?.();
    cancel = null;
    if (!playing.value) return;
    if (shown.value >= events.value.length) {
      // Plus rien à montrer pour l'instant : on attend les événements suivants d'une enquête encore en cours.
      cancel = schedule(tick, 500);
      return;
    }
    cancel = schedule(() => {
      shown.value += 1;
      tick();
    }, delayBefore(events.value, shown.value, speed.value));
  }

  function play(): void {
    if (shown.value >= events.value.length && events.value.length > 0 && !playing.value) shown.value = 0;
    playing.value = true;
    tick();
  }

  function pause(): void {
    playing.value = false;
    cancel?.();
    cancel = null;
  }

  function setSpeed(value: ReplaySpeed): void {
    speed.value = value;
    if (playing.value) tick();
  }

  /** Saute au début de la phase suivante (affichée), ou à la fin ; en arrière, au début de la phase précédente, ou au tout début. */
  function jumpPhase(direction: 1 | -1): void {
    const starts = phaseStarts(events.value).map((phase) => phase.index);
    const current = shown.value - 1;
    if (direction === 1) {
      const next = starts.find((index) => index > current);
      shown.value = next === undefined ? events.value.length : next + 1;
    } else {
      const previous = starts.findLast((index) => index < current);
      shown.value = previous === undefined ? 0 : previous + 1;
    }
    if (playing.value) tick();
  }

  function showAll(): void {
    pause();
    shown.value = events.value.length;
  }

  function restart(): void {
    shown.value = 0;
    if (playing.value) tick();
  }

  tryOnScopeDispose(pause);

  return {
    shown,
    playing,
    speed,
    visible: computed(() => events.value.slice(0, shown.value)),
    atEnd: computed(() => shown.value >= events.value.length),
    play,
    pause,
    setSpeed,
    jumpPhase,
    showAll,
    restart,
  };
}
