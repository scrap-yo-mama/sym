<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file RevertConfirm.vue
 * @description « Revenir à cette version » (06 § 2) : l'aperçu (diff à trois niveaux de la version courante vers la version
 * visée) et la conséquence (l'API devient « À surveiller », raison `reverted`, transitions 7 ou 8), avant le bouton de
 * confirmation. Si l'aperçu ne se charge pas, la conséquence reste lisible et la confirmation possible.
 * @component
 * @example <RevertConfirm :version="2" :current="3" :diff="diff" :diff-loading="false" :diff-error="null" @confirm="go" @cancel="close" />
 */
import { useI18n } from 'vue-i18n';
import ConfirmPanel from '@/components/api/ConfirmPanel.vue';
import StrategyDiffView from '@/components/api/StrategyDiffView.vue';
import type { StrategyDiff } from '@/composables/useStrategyVersions';
import type { ApiRequestError } from '@/lib/api-result';

defineProps<{ version: number; current: number | null | undefined; diff: StrategyDiff | null; diffLoading: boolean; diffError: ApiRequestError | null; pending?: boolean }>();
defineEmits<{ confirm: []; cancel: [] }>();
const { t } = useI18n();
</script>

<template>
  <ConfirmPanel
    id="revert-confirm"
    :title="t('strategy.revertConfirm.title', { v: String(version) })"
    :consequence="t('strategy.revertConfirm.consequence', { v: String(version) })"
    :confirm-label="t('strategy.revertConfirm.yes', { v: String(version) })"
    :pending="pending"
    @confirm="$emit('confirm')"
    @cancel="$emit('cancel')"
  >
    <div v-if="current && current !== version" class="flex flex-col gap-2" data-testid="revert-preview">
      <p class="text-sm font-medium">{{ t('strategy.revertConfirm.preview', { from: String(current), to: String(version) }) }}</p>
      <p v-if="diffLoading" role="status" class="text-sm text-muted-foreground" data-testid="revert-preview-loading">{{ t('ui.loading') }}</p>
      <p v-else-if="diffError" class="text-sm text-muted-foreground" data-testid="revert-preview-unavailable">{{ t('strategy.revertConfirm.previewUnavailable') }}</p>
      <StrategyDiffView v-else-if="diff" :diff="diff" :level="5" />
    </div>
  </ConfirmPanel>
</template>
