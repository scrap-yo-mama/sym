<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file NodesView.vue
 * @description Écran Nœuds et capacité (04d § 5.2, 04b § 5 et § 10, tâche 3.6) : une carte par nœud (état `ready`,
 * `draining`, `down`, slots libres sur total en jauge, mémoire, versions de Playwright et de Chromium, dernier battement),
 * action « Drainer » sur un nœud prêt (`POST /v1/admin/nodes/{id}/drain`) ; alerte quand les slots libres des nœuds prêts
 * passent sous 15 %.
 * @page
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ConsoleButton from '../components/ConsoleButton.vue';
import ErrorAlert from '../components/ErrorAlert.vue';
import StatusBadge from '../components/StatusBadge.vue';
import SymMessage from '../components/SymMessage.vue';
import { useConsoleApi } from '../composables/console-api.js';
import { useLoad } from '../composables/load.js';
import { formatBytes, formatRelative } from '../lib/format.js';

/** Seuil d'alerte de capacité (04d § 5.2 ; cible de mise à l'échelle 04b § 10). */
const CAPACITY_ALERT_RATIO = 0.15;

const { t, locale } = useI18n();
const api = useConsoleApi();
const nodes = useLoad(() => api.listNodes());
const notice = ref('');
const actionError = ref<string | null>(null);
const draining = ref<string | null>(null);

const capacity = computed(() => {
  const ready = (nodes.data.value?.data ?? []).filter((n) => n.state === 'ready');
  const total = ready.reduce((sum, n) => sum + n.slotsTotal, 0);
  const free = ready.reduce((sum, n) => sum + n.slotsFree, 0);
  return { total, free, low: total === 0 ? (nodes.data.value?.data.length ?? 0) > 0 : free / total < CAPACITY_ALERT_RATIO };
});

async function drain(id: string): Promise<void> {
  if (draining.value) return;
  draining.value = id;
  const result = await api.drainNode(id);
  draining.value = null;
  if (!result.ok) {
    actionError.value = result.code;
    return;
  }
  actionError.value = null;
  const list = nodes.data.value?.data ?? [];
  nodes.data.value = { data: list.map((n) => (n.id === id ? result.data : n)) };
  notice.value = t('console.nodes.drained', { id });
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-6xl flex-col gap-6" aria-labelledby="nodes-title">
    <h1 id="nodes-title" data-route-heading tabindex="-1" class="text-4xl">{{ t('console.nodes.title') }}</h1>
    <p v-if="nodes.loading.value && !nodes.data.value" role="status">{{ t('console.common.loading') }}</p>
    <div v-else data-loaded class="flex flex-col gap-6">
      <ErrorAlert v-if="nodes.error.value" :code="nodes.error.value" :retry="nodes.reload" />
      <div v-else-if="(nodes.data.value?.data.length ?? 0) === 0" class="rounded-xl border border-border bg-card p-6 text-card-foreground">
        <SymMessage :text="t('console.nodes.empty')" />
      </div>
      <template v-else>
        <p v-if="capacity.low" role="alert" class="rounded-md bg-signature px-3 py-2 font-bold text-signature-foreground">
          {{ t('console.nodes.capacityAlert', { free: capacity.free, total: capacity.total }) }}
        </p>
        <p role="status" class="font-bold">{{ notice }}</p>
        <ErrorAlert v-if="actionError" :code="actionError" />
        <p class="text-sm text-muted-foreground">{{ t('console.nodes.drainHint') }}</p>
        <ul class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <li v-for="node in nodes.data.value?.data" :key="node.id">
            <article :data-node="node.id" :aria-labelledby="`node-${node.id}`" class="flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h2 :id="`node-${node.id}`" class="font-mono text-xl">{{ node.id }}</h2>
                <StatusBadge :status="node.state" kind="node" />
              </div>
              <p class="text-sm text-muted-foreground">{{ t('console.nodes.region', { region: node.region }) }}</p>
              <div class="flex flex-col gap-1">
                <span :id="`node-${node.id}-slots`" class="font-bold">{{ t('console.nodes.slots', { free: node.slotsFree, total: node.slotsTotal }) }}</span>
                <meter
                  :aria-labelledby="`node-${node.id}-slots`"
                  min="0"
                  :max="node.slotsTotal"
                  :value="node.slotsFree"
                  :low="Math.ceil(node.slotsTotal * 0.15)"
                  :optimum="node.slotsTotal"
                  class="h-3 w-full"
                ></meter>
              </div>
              <p>{{ t('console.nodes.memory', { rss: formatBytes(node.rssBytes, locale), limit: formatBytes(node.limitBytes, locale) }) }}</p>
              <p>{{ t('console.nodes.versions', { playwright: node.playwright, chromium: node.chromium }) }}</p>
              <p class="text-sm text-muted-foreground">
                <time :datetime="node.lastHeartbeatAt">{{ t('console.nodes.heartbeat', { when: formatRelative(node.lastHeartbeatAt, locale) }) }}</time>
              </p>
              <div v-if="node.state === 'ready'" class="mt-auto">
                <ConsoleButton type="button" variant="outline" :data-drain="node.id" :busy="draining === node.id" @click="drain(node.id)">
                  {{ t('console.nodes.drain') }}<span class="sr-only"> {{ node.id }}</span>
                </ConsoleButton>
              </div>
            </article>
          </li>
        </ul>
      </template>
    </div>
  </section>
</template>
