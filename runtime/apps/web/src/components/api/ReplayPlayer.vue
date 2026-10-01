<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ReplayPlayer.vue
 * @description Lecteur du replay d'une enquête (06 § 2) : événements de `investigation_events` joués à 0,5x, 1x, 2x ou 4x,
 * saut de phase en phase, recherche. Le journal est une région `role="log"` (une phrase par événement, sans déplacer le
 * focus, 06 § 3) ; « Suspendre le suivi » (WCAG 2.2.2) coupe le défilement automatique et les annonces. Aucun partage
 * public du live, aucune prise de contrôle d'un onglet.
 * @component
 * @example <ReplayPlayer :events="events" :live="status === 'live'" />
 */
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useReplayPlayer } from '@/composables/useReplayPlayer';
import { formatDateTime } from '@/lib/display-format';
import { describeReplayEvent, REPLAY_SPEEDS, type ReplayEvent } from '@/lib/replay';

const props = defineProps<{ events: readonly ReplayEvent[]; live?: boolean }>();
const { t, te, locale } = useI18n();
const player = useReplayPlayer(computed(() => props.events));

/** Suivi suspendu : plus de défilement automatique ni d'annonce (2.2.2). */
const suspended = ref(false);
const query = ref('');
const log = useTemplateRef<HTMLElement>('log');

const lines = computed(() =>
  player.visible.value.map((event) => ({ event, text: describeReplayEvent((key, named) => t(key, named ?? {}), te, event) })),
);
const shownLines = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return needle === '' ? lines.value : lines.value.filter((line) => line.text.toLowerCase().includes(needle));
});

/** Tant que l'utilisateur ne lit pas le replay, on suit la fin du journal (enquête en cours : les événements arrivent). */
const tail = ref(true);
watch(
  () => props.events.length,
  (length) => {
    if (tail.value) player.shown.value = length;
  },
  { immediate: true },
);
function play(): void {
  tail.value = false;
  player.play();
}
function restart(): void {
  tail.value = false;
  player.restart();
}
function showAll(): void {
  tail.value = true;
  player.showAll();
}
function jump(direction: 1 | -1): void {
  tail.value = false;
  player.jumpPhase(direction);
}

watch(
  () => player.shown.value,
  async () => {
    if (suspended.value) return;
    await nextTick();
    log.value?.scrollTo?.({ top: log.value.scrollHeight });
  },
);
</script>

<template>
  <section class="flex flex-col gap-3" :aria-label="t('replay.title')" data-testid="replay-player">
    <h3 class="text-base font-semibold">{{ t('replay.title') }}</h3>
    <div class="flex flex-wrap items-center gap-2" role="group" :aria-label="t('replay.controls')">
      <Button size="sm" data-testid="replay-toggle" @click="player.playing.value ? player.pause() : play()">
        {{ player.playing.value ? t('replay.pause') : t('replay.play') }}
      </Button>
      <Button variant="outline" size="sm" @click="restart()">{{ t('replay.restart') }}</Button>
      <Button variant="outline" size="sm" @click="jump(-1)">{{ t('replay.previousPhase') }}</Button>
      <Button variant="outline" size="sm" @click="jump(1)">{{ t('replay.nextPhase') }}</Button>
      <Button variant="outline" size="sm" @click="showAll()">{{ t('replay.showAll') }}</Button>
      <div class="flex items-center gap-1" role="group" :aria-label="t('replay.speed')">
        <Button v-for="value in REPLAY_SPEEDS" :key="value" :variant="player.speed.value === value ? 'default' : 'outline'" size="sm" :aria-pressed="player.speed.value === value" @click="player.setSpeed(value)">{{ value }}x</Button>
      </div>
      <Button variant="outline" size="sm" data-testid="suspend-follow" @click="suspended = !suspended">
        {{ suspended ? t('replay.resumeFollow') : t('replay.suspendFollow') }}
      </Button>
    </div>
    <div class="flex max-w-sm flex-col gap-1">
      <label for="replay-search" class="text-sm font-medium">{{ t('replay.search') }}</label>
      <Input id="replay-search" v-model="query" type="search" />
    </div>
    <p class="text-sm text-muted-foreground">{{ t('replay.position', { shown: String(player.shown.value), total: String(events.length) }) }}<template v-if="live"> · {{ t('replay.live') }}</template></p>
    <!-- Journal : une phrase par événement, sans déplacer le focus. En suivi suspendu, aucune annonce (aria-live="off"). -->
    <!-- Le rôle log va sur un conteneur : sur le <ol>, il remplacerait le rôle de liste et les <li> n'auraient plus de parent de liste. -->
    <div ref="log" role="log" :aria-live="suspended ? 'off' : 'polite'" tabindex="0" class="max-h-96 overflow-y-auto rounded-lg border p-3 text-sm" :aria-label="t('replay.log')" data-testid="replay-log">
      <ol>
        <li v-for="line in shownLines" :key="line.event.id ?? line.event.seq" class="flex gap-3 py-0.5">
          <time v-if="line.event.at" :datetime="line.event.at" class="shrink-0 text-muted-foreground">{{ formatDateTime(line.event.at, locale) }}</time>
          <span>{{ line.text }}</span>
        </li>
      </ol>
    </div>
    <p v-if="query.trim() !== '' && shownLines.length === 0" class="text-sm text-muted-foreground">{{ t('replay.noMatch') }}</p>
    <p class="text-xs text-muted-foreground">{{ t('replay.retention') }}</p>
  </section>
</template>
