<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SessionDetailView.vue
 * @description Détail d'une session (04d § 5.2, tâche 3.6) : en-tête (état, type, clé, nœud, dates, metadata), actions
 * (prolonger, libérer avec confirmation), vue en direct (lecture seule ou « Prendre la main »), frise des événements SSE
 * annoncée (`aria-live="polite"` : `state`, `egress.blocked`, `download`, `recording.ready`), enregistrements et fichiers
 * (téléchargement sur la même origine), usage de la session. Session inconnue : message et retour à la liste.
 * @page
 */
import type { SessionEvent } from '@sym/contracts/browser';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import type { ConsoleSession } from '../api/types.js';
import ConsoleButton from '../components/ConsoleButton.vue';
import ErrorAlert from '../components/ErrorAlert.vue';
import LiveViewer from '../components/LiveViewer.vue';
import StatusBadge from '../components/StatusBadge.vue';
import SymMessage from '../components/SymMessage.vue';
import { useConsoleApi } from '../composables/console-api.js';
import { useLoad } from '../composables/load.js';
import { formatBytes, formatDate, formatDuration, sessionSeconds } from '../lib/format.js';

const props = defineProps<{ id: string }>();
const { t, locale } = useI18n();
const api = useConsoleApi();

const loaded = useLoad(() => api.getSession(props.id));
const recordings = useLoad(() => api.listRecordings(props.id));
const files = useLoad(() => api.listFiles(props.id));
/** Session à jour : réponse initiale, puis actions et événements `state`. */
const override = ref<ConsoleSession | null>(null);
const session = computed(() => override.value ?? loaded.data.value ?? null);
const active = computed(() => session.value?.state === 'running' || session.value?.state === 'pending');

const events = ref<SessionEvent[]>([]);
let stop: (() => void) | undefined;
onMounted(() => {
  stop = api.watchEvents(props.id, (event) => {
    events.value = [...events.value, event];
    const current = session.value;
    if (event.type === 'state' && current && current.state !== event.data.state) {
      override.value = { ...current, state: event.data.state, ...(event.data.endReason ? { endReason: event.data.endReason } : {}), ...(event.data.state === 'running' ? {} : { endedAt: event.at }) };
    }
    if (event.type === 'recording.ready') void recordings.reload();
    if (event.type === 'download' && event.data.state === 'completed') void files.reload();
  });
});
onBeforeUnmount(() => stop?.());

function describe(event: SessionEvent): string {
  switch (event.type) {
    case 'state': {
      const state = t(`console.status.session.${event.data.state}`);
      return event.data.endReason ? t('console.session.events.stateReason', { state, reason: t(`console.endReasons.${event.data.endReason}`) }) : t('console.session.events.state', { state });
    }
    case 'download':
      return t('console.session.events.download', { name: event.data.name, state: t(`console.session.events.downloadStates.${event.data.state}`) });
    case 'recording.ready':
      return t('console.session.events.recordingReady', { type: t(`console.session.recordings.types.${event.data.type}`) });
    case 'egress.blocked':
      return t('console.session.events.egressBlocked', { host: event.data.host, count: event.data.count });
    case 'egress.budget_exceeded':
      return t('console.session.events.budget');
    default:
      return t('console.session.events.other', { type: event.type });
  }
}

// Actions.
const notice = ref('');
const actionError = ref<string | null>(null);
const extendSeconds = ref(300);
const confirming = ref(false);
const busy = ref(false);

async function extend(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const result = await api.extendSession(props.id, Number(extendSeconds.value));
  busy.value = false;
  if (!result.ok) {
    actionError.value = result.code;
    return;
  }
  actionError.value = null;
  override.value = result.data;
  notice.value = t('console.session.actions.extended', { time: formatDate(result.data.expiresAt, locale.value) });
}

async function askRelease(): Promise<void> {
  confirming.value = true;
  await nextTick();
  document.getElementById('release-confirm')?.focus();
}
async function cancelRelease(): Promise<void> {
  confirming.value = false;
  await nextTick();
  document.getElementById('release')?.focus();
}
async function release(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const result = await api.releaseSession(props.id);
  busy.value = false;
  confirming.value = false;
  if (!result.ok) {
    actionError.value = result.code;
    return;
  }
  actionError.value = null;
  override.value = result.data;
  notice.value = t('console.session.actions.released');
  await nextTick();
  document.querySelector<HTMLElement>('[data-route-heading]')?.focus();
}

const usageSeconds = computed(() => (session.value ? sessionSeconds(session.value) : 0));
const metadata = computed(() => Object.entries(session.value?.metadata ?? {}));
</script>

<template>
  <section class="mx-auto flex w-full max-w-6xl flex-col gap-6" aria-labelledby="session-title">
    <h1 id="session-title" data-route-heading tabindex="-1" class="font-mono text-3xl break-all sm:text-4xl">{{ t('console.session.title', { id }) }}</h1>
    <p><RouterLink to="/sessions" class="inline-flex min-h-6 items-center font-bold text-primary underline underline-offset-4">{{ t('console.session.back') }}</RouterLink></p>

    <p v-if="loaded.loading.value && !session" role="status">{{ t('console.common.loading') }}</p>
    <div v-else data-loaded class="flex flex-col gap-6">
      <template v-if="!session">
        <div v-if="loaded.error.value === 'session_not_found'" class="rounded-xl border border-border bg-card p-6 text-card-foreground">
          <SymMessage :text="t('console.session.notFound')" />
        </div>
        <ErrorAlert v-else :code="loaded.error.value ?? 'unexpected'" :retry="loaded.reload" />
      </template>
      <template v-else>
        <div class="rounded-xl border border-border bg-card p-4 text-card-foreground">
          <h2 class="mb-3 text-2xl">{{ t('console.session.summary') }}</h2>
          <dl class="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
            <dt class="font-bold">{{ t('console.session.fields.state') }}</dt>
            <dd><StatusBadge data-session-status :status="session.state" kind="session" /></dd>
            <dt class="font-bold">{{ t('console.session.fields.type') }}</dt>
            <dd>{{ t(`console.types.${session.type}`) }}</dd>
            <dt class="font-bold">{{ t('console.session.fields.key') }}</dt>
            <dd class="font-mono">{{ session.apiKeyPrefix }}</dd>
            <dt class="font-bold">{{ t('console.session.fields.node') }}</dt>
            <dd class="font-mono">{{ session.nodeId ?? t('console.session.fields.none') }}</dd>
            <dt class="font-bold">{{ t('console.session.fields.created') }}</dt>
            <dd>{{ formatDate(session.createdAt, locale) }}</dd>
            <template v-if="session.startedAt">
              <dt class="font-bold">{{ t('console.session.fields.started') }}</dt>
              <dd>{{ formatDate(session.startedAt, locale) }}</dd>
            </template>
            <template v-if="session.endedAt">
              <dt class="font-bold">{{ t('console.session.fields.ended') }}</dt>
              <dd>{{ formatDate(session.endedAt, locale) }}</dd>
            </template>
            <template v-if="active">
              <dt class="font-bold">{{ t('console.session.fields.expires') }}</dt>
              <dd>{{ formatDate(session.expiresAt, locale) }}</dd>
            </template>
            <template v-if="session.endReason">
              <dt class="font-bold">{{ t('console.session.fields.endReason') }}</dt>
              <dd>{{ t(`console.endReasons.${session.endReason}`) }}</dd>
            </template>
            <dt class="font-bold">{{ t('console.session.fields.metadata') }}</dt>
            <dd class="font-mono">
              <template v-if="metadata.length === 0">{{ t('console.session.fields.none') }}</template>
              <span v-for="[key, value] in metadata" v-else :key="key" class="me-3 inline-block">{{ key }}={{ value }}</span>
            </dd>
          </dl>
        </div>

        <p role="status" class="font-bold">{{ notice }}</p>
        <ErrorAlert v-if="actionError" :code="actionError" />

        <div v-if="active" class="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground">
          <h2 class="text-2xl">{{ t('console.session.actions.heading') }}</h2>
          <form class="flex flex-wrap items-end gap-3" @submit.prevent="extend">
            <div class="flex flex-col gap-1">
              <label for="extend-seconds" class="text-sm font-bold">{{ t('console.session.actions.extendLabel') }}</label>
              <input id="extend-seconds" v-model.number="extendSeconds" type="number" min="1" step="1" inputmode="numeric" class="min-h-11 w-40 rounded-md border border-input bg-background px-3" />
            </div>
            <ConsoleButton id="extend-submit" type="submit" variant="outline" :busy="busy">{{ t('console.session.actions.extend') }}</ConsoleButton>
          </form>
          <div class="flex flex-col gap-2">
            <p id="release-hint" class="text-sm text-muted-foreground">{{ t('console.session.actions.releaseHint') }}</p>
            <div v-if="!confirming">
              <ConsoleButton id="release" type="button" aria-describedby="release-hint" @click="askRelease">{{ t('console.session.actions.release') }}</ConsoleButton>
            </div>
            <div v-else class="flex flex-wrap gap-3">
              <ConsoleButton id="release-confirm" type="button" :busy="busy" @click="release">{{ t('console.session.actions.releaseConfirm') }}</ConsoleButton>
              <ConsoleButton type="button" variant="outline" @click="cancelRelease">{{ t('console.session.actions.releaseCancel') }}</ConsoleButton>
            </div>
          </div>
        </div>

        <LiveViewer v-if="session.state === 'running'" :session-id="session.id" :interactive="session.interactiveLiveView" />
        <section v-else class="rounded-xl border border-border bg-card p-4 text-card-foreground" aria-labelledby="live-off-title">
          <h2 id="live-off-title" class="mb-2 text-2xl">{{ t('console.session.live.heading') }}</h2>
          <p>{{ t('console.session.live.unavailable') }}</p>
        </section>

        <section class="rounded-xl border border-border bg-card p-4 text-card-foreground" aria-labelledby="events-title">
          <h2 id="events-title" class="mb-2 text-2xl">{{ t('console.session.events.heading') }}</h2>
          <div id="session-events" aria-live="polite" aria-relevant="additions">
            <p v-if="events.length === 0" class="text-muted-foreground">{{ t('console.session.events.empty') }}</p>
            <ol v-else class="flex flex-col gap-1">
              <li v-for="(event, index) in events" :key="index" class="flex flex-wrap gap-x-3">
                <time :datetime="event.at" class="font-mono text-sm text-muted-foreground">{{ formatDate(event.at, locale) }}</time>
                <span>{{ describe(event) }}</span>
              </li>
            </ol>
          </div>
        </section>

        <section class="rounded-xl border border-border bg-card p-4 text-card-foreground" aria-labelledby="recordings-title">
          <h2 id="recordings-title" class="mb-2 text-2xl">{{ t('console.session.recordings.heading') }}</h2>
          <ErrorAlert v-if="recordings.error.value" :code="recordings.error.value" :retry="recordings.reload" />
          <p v-else-if="(recordings.data.value?.data.length ?? 0) === 0" class="text-muted-foreground">{{ t('console.session.recordings.empty') }}</p>
          <ul v-else class="flex flex-col gap-2">
            <li v-for="recording in recordings.data.value?.data" :key="recording.id" class="flex flex-wrap items-center gap-x-3">
              <span class="font-bold">{{ t(`console.session.recordings.types.${recording.type}`) }}</span>
              <span>{{ formatBytes(recording.size, locale) }}</span>
              <span class="text-sm text-muted-foreground">{{ t('console.session.recordings.expires', { date: formatDate(recording.expiresAt, locale) }) }}</span>
              <a
                :href="api.recordingHref(session.id, recording.id)"
                download
                :aria-label="t('console.session.recordings.downloadLabel', { type: t(`console.session.recordings.types.${recording.type}`) })"
                class="inline-flex min-h-6 items-center font-bold text-primary underline underline-offset-4"
                >{{ t('console.session.recordings.download') }}</a
              >
            </li>
          </ul>
        </section>

        <section class="rounded-xl border border-border bg-card p-4 text-card-foreground" aria-labelledby="files-title">
          <h2 id="files-title" class="mb-2 text-2xl">{{ t('console.session.files.heading') }}</h2>
          <ErrorAlert v-if="files.error.value" :code="files.error.value" :retry="files.reload" />
          <p v-else-if="(files.data.value?.data.length ?? 0) === 0" class="text-muted-foreground">{{ t('console.session.files.empty') }}</p>
          <ul v-else class="flex flex-col gap-2">
            <li v-for="file in files.data.value?.data" :key="file.id" class="flex flex-wrap items-center gap-x-3">
              <a
                :href="api.fileHref(session.id, file.id)"
                download
                :aria-label="t('console.session.files.downloadLabel', { name: file.name })"
                class="inline-flex min-h-6 items-center font-bold text-primary underline underline-offset-4"
                >{{ file.name }}</a
              >
              <span>{{ formatBytes(file.size, locale) }}</span>
              <code class="text-xs break-all text-muted-foreground">sha256 {{ file.sha256 }}</code>
              <span class="text-sm text-muted-foreground">{{ t('console.session.files.expires', { date: formatDate(file.expiresAt, locale) }) }}</span>
            </li>
          </ul>
        </section>

        <section class="rounded-xl border border-border bg-card p-4 text-card-foreground" aria-labelledby="usage-title">
          <h2 id="usage-title" class="mb-2 text-2xl">{{ t('console.session.usage.heading') }}</h2>
          <dl class="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt class="font-bold">{{ t('console.session.usage.seconds') }}</dt>
            <dd>{{ formatDuration(usageSeconds, locale) }}</dd>
            <dt class="font-bold">{{ t('console.session.usage.bytesIn') }}</dt>
            <dd>{{ formatBytes(session.usage?.bytesIn ?? 0, locale) }}</dd>
            <dt class="font-bold">{{ t('console.session.usage.bytesOut') }}</dt>
            <dd>{{ formatBytes(session.usage?.bytesOut ?? 0, locale) }}</dd>
          </dl>
        </section>
      </template>
    </div>
  </section>
</template>
