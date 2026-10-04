<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiInvestigationsTab.vue
 * @description « Enquêtes » (06 § 2) : replay des événements d'enquête d'une API. Les enquêtes et réparations viennent des
 * versions de stratégie (chaque version renvoie à l'enquête ou à la réparation qui l'a produite) et de l'enquête en cours.
 * Rétention par défaut : 30 jours pour les événements, 7 pour les captures. Captures désactivées par défaut en tunnel et
 * derrière une connexion ; aucun partage public du live. En bas : liste des indices du dossier d'enquête (2.14).
 * @component
 * @example <ApiInvestigationsTab :detail="detail" slug="zz-books" initial-run="..." />
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import BriefHintsList from '@/components/api/BriefHintsList.vue';
import ReplayPlayer from '@/components/api/ReplayPlayer.vue';
import LoadingState from '@/components/LoadingState.vue';
import type { ApiDetail } from '@/composables/useApiDetail';
import { useInvestigationReplay } from '@/composables/useInvestigationReplay';
import { useStrategyVersions } from '@/composables/useStrategyVersions';
import { formatDateTime } from '@/lib/display-format';

const props = defineProps<{ detail: ApiDetail; slug: string; initialRun?: string | null }>();
const { t, locale } = useI18n();
const versions = useStrategyVersions(() => props.slug);
const replay = useInvestigationReplay();

/** `live` : l'enquête ou la réparation en cours (suivie en direct) ; les autres sont terminées. */
type Entry = { runId: string; label: string; live: boolean };
const entries = computed<Entry[]>(() => {
  const out: Entry[] = [];
  const seen = new Set<string>();
  const push = (runId: string | null | undefined, label: string, live = false) => {
    if (runId && !seen.has(runId)) {
      seen.add(runId);
      out.push({ runId, label, live });
    }
  };
  const reasonRun = props.detail.status_reason?.params?.run_id;
  if (props.detail.status === 'enquete' || props.detail.status === 'reparation') push(typeof reasonRun === 'string' ? reasonRun : null, t('investigations.inProgress'), true);
  for (const item of versions.versions.value) {
    push(item.run_id, t('investigations.entry', { origin: t(`strategy.origins.${item.created_by}`), v: String(item.version), date: formatDateTime(item.created_at, locale.value) }));
  }
  push(props.initialRun, t('investigations.requested'));
  return out;
});

const selected = ref<string>('');
watch(
  [entries, () => props.initialRun],
  ([list, initial]) => {
    if (selected.value && list.some((entry) => entry.runId === selected.value)) return;
    const next = (initial && list.find((entry) => entry.runId === initial)?.runId) || list[0]?.runId || '';
    selected.value = next;
  },
  { immediate: true },
);
// L'enquête en cours se termine (la fiche est relue par le flux de l'onglet) : la lecture s'arrête à la fin de la réponse.
watch(
  () => entries.value.find((entry) => entry.runId === selected.value)?.live ?? false,
  (live, wasLive) => {
    if (wasLive && !live) replay.markFinished();
  },
);
watch(selected, (runId) => (runId ? replay.open(runId, { live: entries.value.find((entry) => entry.runId === runId)?.live ?? false }) : replay.close()), { immediate: true });
</script>

<template>
  <div class="flex flex-col gap-4">
    <LoadingState v-if="versions.loading.value && entries.length === 0" />
    <p v-else-if="entries.length === 0" class="text-sm text-muted-foreground" data-testid="no-investigation">{{ t('investigations.none') }}</p>
    <template v-else>
      <div class="flex max-w-xl flex-col gap-1">
        <label for="investigation-run" class="text-sm font-medium">{{ t('investigations.choose') }}</label>
        <select id="investigation-run" v-model="selected" class="h-11 rounded-md border border-input bg-background px-2 text-sm">
          <option v-for="entry in entries" :key="entry.runId" :value="entry.runId">{{ entry.label }}</option>
        </select>
      </div>
      <ReplayPlayer :events="replay.events.value" :live="replay.status.value === 'live'" />
    </template>
    <!-- Dossier d'enquête (2.14, 19c § 7) : indices, état, raison, coût, version ; propriétaire seulement. -->
    <BriefHintsList :slug="slug" />
  </div>
</template>
