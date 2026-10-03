<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file LiveViewer.vue
 * @description Vue en direct d'une session (04d § 1 et § 5.4, tâche 3.6 ; relais : tâche 3.2). Lecture seule par défaut :
 * aucune entrée n'est envoyée. « Prendre la main » (session créée avec `liveView.interactive`) demande un jeton `rw`, pose le
 * focus sur la vue et capte le clavier (Tab compris) ; Échap rend la main, revient en lecture seule et rend le focus au
 * bouton. Titre, URL courante et dernière action sont donnés en texte à côté de l'image ; le mode est annoncé.
 * @component
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LiveConnection, LiveMode, LiveServerMessage } from '../api/types.js';
import { useConsoleApi } from '../composables/console-api.js';
import ConsoleButton from './ConsoleButton.vue';
import ErrorAlert from './ErrorAlert.vue';

const props = defineProps<{ sessionId: string; interactive: boolean }>();
const { t } = useI18n();
const api = useConsoleApi();

const mode = ref<LiveMode>('ro');
const status = ref<'connecting' | 'open' | 'closed'>('connecting');
const error = ref<string | null>(null);
const frame = ref<{ src: string; w: number; h: number } | null>(null);
const meta = ref<{ url: string; title: string } | null>(null);
const lastAction = ref<string | null>(null);
const viewer = ref<HTMLElement | null>(null);
const takeButton = ref<{ $el: HTMLElement } | null>(null);
let connection: LiveConnection | null = null;
let unmounted = false;

function onMessage(message: LiveServerMessage): void {
  if (message.t === 'frame') {
    frame.value = { src: `data:image/jpeg;base64,${message.data}`, w: message.w, h: message.h };
    status.value = 'open';
  } else if (message.t === 'meta') {
    meta.value = { url: message.url, title: message.title };
    status.value = 'open';
  } else if (message.t === 'closed') status.value = 'closed';
}

async function connect(next: LiveMode): Promise<boolean> {
  connection?.close();
  connection = null;
  status.value = 'connecting';
  const opened = await api.openLive(props.sessionId, next);
  if (unmounted) {
    if (opened.ok) opened.data.close();
    return false;
  }
  if (!opened.ok) {
    error.value = opened.code;
    status.value = 'closed';
    return false;
  }
  error.value = null;
  connection = opened.data;
  connection.onMessage(onMessage);
  mode.value = next;
  return true;
}

async function takeControl(): Promise<void> {
  if (!props.interactive || mode.value === 'rw') return;
  if (await connect('rw')) {
    await nextTick();
    viewer.value?.focus();
  }
}

async function giveBack(): Promise<void> {
  await connect('ro');
  await nextTick();
  takeButton.value?.$el.focus();
}

function onKey(event: KeyboardEvent, type: 'keyDown' | 'keyUp'): void {
  if (mode.value !== 'rw') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (type === 'keyDown') void giveBack();
    return;
  }
  // Clavier capté : Tab et les raccourcis partent vers le navigateur de la session, pas vers la console.
  event.preventDefault();
  connection?.send({ t: 'key', type, key: event.key });
  if (type === 'keyDown') lastAction.value = t('console.session.live.actions.key', { key: event.key === ' ' ? 'Space' : event.key });
}

function point(event: MouseEvent): { x: number; y: number } {
  const target = event.currentTarget as HTMLElement;
  const box = target.getBoundingClientRect();
  const w = frame.value?.w ?? box.width;
  const h = frame.value?.h ?? box.height;
  // Coordonnées ramenées à la taille de la trame (le relais les borne au viewport, 04d § 1.3).
  return { x: Math.round(((event.clientX - box.left) / Math.max(1, box.width)) * w), y: Math.round(((event.clientY - box.top) / Math.max(1, box.height)) * h) };
}

function onMouse(event: MouseEvent, type: 'mousePressed' | 'mouseReleased'): void {
  if (mode.value !== 'rw') return;
  const { x, y } = point(event);
  connection?.send({ t: 'mouse', type, x, y, button: 'left' });
  if (type === 'mousePressed') lastAction.value = t('console.session.live.actions.click', { x, y });
}

function onWheel(event: WheelEvent): void {
  if (mode.value !== 'rw') return;
  event.preventDefault();
  const { x, y } = point(event);
  connection?.send({ t: 'wheel', x, y, deltaX: event.deltaX, deltaY: event.deltaY });
  lastAction.value = t('console.session.live.actions.wheel');
}

onMounted(() => {
  void connect('ro');
});
onBeforeUnmount(() => {
  unmounted = true;
  connection?.close();
  connection = null;
});
</script>

<template>
  <section class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground" aria-labelledby="live-title">
    <h2 id="live-title" class="text-2xl">{{ t('console.session.live.heading') }}</h2>
    <p id="live-mode" role="status" class="font-bold">{{ mode === 'rw' ? t('console.session.live.control') : t('console.session.live.readOnly') }}</p>
    <div
      id="live-viewer"
      ref="viewer"
      :tabindex="mode === 'rw' ? 0 : -1"
      role="application"
      :aria-label="t('console.session.live.frameAlt')"
      :aria-describedby="'live-meta'"
      :class="['relative overflow-hidden rounded-lg border-4 bg-muted', mode === 'rw' ? 'border-primary' : 'border-border']"
      @keydown="onKey($event, 'keyDown')"
      @keyup="onKey($event, 'keyUp')"
      @mousedown="onMouse($event, 'mousePressed')"
      @mouseup="onMouse($event, 'mouseReleased')"
      @wheel="onWheel"
    >
      <img v-if="frame" :src="frame.src" :width="frame.w" :height="frame.h" :alt="t('console.session.live.frameAlt')" class="block h-auto w-full" draggable="false" />
      <p v-else class="p-6 text-muted-foreground">{{ status === 'closed' ? t('console.session.live.closed') : t('console.session.live.waiting') }}</p>
    </div>
    <dl id="live-meta" class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      <dt class="font-bold">{{ t('console.session.live.page') }}</dt>
      <dd class="font-mono break-all">{{ meta?.url ?? '—' }}</dd>
      <dt class="font-bold">{{ t('console.session.live.pageTitle') }}</dt>
      <dd>{{ meta?.title ?? '—' }}</dd>
      <dt class="font-bold">{{ t('console.session.live.lastAction') }}</dt>
      <dd>{{ lastAction ?? t('console.session.live.noAction') }}</dd>
    </dl>
    <ErrorAlert v-if="error" :code="error" />
    <div v-if="interactive">
      <ConsoleButton id="take-control" ref="takeButton" type="button" :aria-pressed="mode === 'rw' ? 'true' : 'false'" @click="takeControl">{{ t('console.session.live.take') }}</ConsoleButton>
    </div>
    <p v-else class="text-sm text-muted-foreground">{{ t('console.session.live.notInteractive') }}</p>
  </section>
</template>
