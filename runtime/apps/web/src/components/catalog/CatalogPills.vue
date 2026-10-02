<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file CatalogPills.vue
 * @description Pastilles-filtres du catalogue (20 § 5.2, u3 R16) : « Tout », « À traiter », « Saines », « Arrêtées » (libellé de la planche, D-60),
 * chacune avec son compteur EN TEXTE (« À traiter · 2 »). Boutons à bascule (`aria-pressed`) de 44 px au moins ; la pastille
 * active est pleine. Les changements de compteur sont annoncés par la région `status` du catalogue (la vue), pas ici.
 * @component
 * @example <CatalogPills :counts="counts" :active="active" @select="setPill" />
 */
import { useI18n } from 'vue-i18n';
import { PILLS, type PillCounts, type PillId } from '@/lib/catalog-health';

defineProps<{ counts: PillCounts | null; active: PillId | null }>();
defineEmits<{ select: [pill: PillId] }>();
const { t } = useI18n();
</script>

<template>
  <div class="flex flex-wrap gap-2.5" role="group" :aria-label="t('catalog.pills.label')" data-testid="catalog-pills">
    <button
      v-for="pill in PILLS"
      :key="pill"
      type="button"
      class="inline-flex min-h-11 items-center rounded-full border-[1.5px] border-foreground px-4 py-2.5 text-sm font-bold"
      :class="active === pill ? 'bg-foreground text-background' : 'bg-card text-card-foreground'"
      :aria-pressed="active === pill ? 'true' : 'false'"
      :data-pill="pill"
      @click="$emit('select', pill)"
    >
      {{ counts ? t('catalog.pills.withCount', { label: t(`catalog.pills.${pill}`), n: counts[pill] }) : t(`catalog.pills.${pill}`) }}
    </button>
  </div>
</template>
