<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file CatalogHealth.vue
 * @description Barre de santé du catalogue (20 § 5.2, u3 R15) : une barre segmentée par statut, sa légende en TEXTE (le sens
 * n'est jamais porté par la couleur seule) et la ligne « 5 sur 6 saines · 1 arrêt volontaire ». Les API `bloquee` sont des arrêts
 * volontaires, pas des pannes : elles sont affichées À PART, après un séparateur en pointillés, et n'entrent jamais dans le
 * dénominateur (`assert_catalog_health_excludes_blocked`). Pas de score magique : un rapport simple, des comptes réels.
 * @component
 * @example <CatalogHealth :health="health" :partial="false" />
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CatalogHealth } from '@/lib/catalog-health';
import type { ApiStatus } from '@/lib/status';

const props = defineProps<{ health: CatalogHealth; partial?: boolean }>();
const { t } = useI18n();

/** Surface de chaque segment et de son repère de légende (jetons de statut de packages/ui). */
const FILL: Record<ApiStatus, string> = {
  enquete: 'fill-status-enquete',
  sain: 'fill-status-sain',
  warning: 'fill-status-warning',
  reparation: 'fill-status-reparation',
  erreur: 'fill-status-erreur',
  action_requise: 'fill-status-action-requise',
  bloquee: 'fill-status-bloquee',
};
const SWATCH: Record<ApiStatus, string> = {
  enquete: 'bg-status-enquete',
  sain: 'bg-status-sain',
  warning: 'bg-status-warning',
  reparation: 'bg-status-reparation',
  erreur: 'bg-status-erreur text-status-erreur-foreground',
  action_requise: 'bg-status-action-requise',
  bloquee: 'bg-status-bloquee',
};

/** Segments de la barre en unités d'un viewBox de 100 : largeur proportionnelle au compte, un petit écart entre deux segments. */
const GAP = 0.8;
const rects = computed(() => {
  let x = 0;
  const total = props.health.inService || 1;
  return props.health.segments.map((segment) => {
    const width = (segment.count / total) * 100;
    const rect = { status: segment.status, x, width: Math.max(width - GAP, 0.4) };
    x += width;
    return rect;
  });
});
</script>

<template>
  <section class="flex flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground" aria-labelledby="catalog-health-title" data-testid="catalog-health">
    <h2 id="catalog-health-title" class="sr-only">{{ t('catalog.health.title') }}</h2>
    <p class="text-lg font-semibold" data-testid="health-line">
      <span data-testid="health-ratio">{{ health.inService > 0 ? t('catalog.health.ratio', { healthy: health.healthy, total: health.inService }) : t('catalog.health.noneInService') }}</span
      ><template v-if="health.stopped > 0"> · <span data-testid="health-stopped">{{ t('catalog.health.stopped', { n: health.stopped }, health.stopped) }}</span></template>
    </p>
    <div class="flex items-center gap-5">
      <svg class="h-4 flex-1 overflow-hidden rounded-full bg-muted" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-testid="health-bar">
        <rect v-for="rect in rects" :key="rect.status" :class="FILL[rect.status]" :x="rect.x" y="0" :width="rect.width" height="4" :data-status="rect.status" />
      </svg>
      <!-- Les arrêts volontaires sont à part : séparateur en pointillés et carré anthracite, hors de la barre et du ratio. -->
      <span v-if="health.stopped > 0" class="flex items-center gap-2 border-l-2 border-dashed pl-5" aria-hidden="true" data-testid="health-stopped-mark">
        <span class="size-4 rounded-sm border-2 border-status-border bg-status-bloquee"></span>
      </span>
    </div>
    <ul class="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground" :aria-label="t('catalog.health.legendLabel')" data-testid="health-legend">
      <li v-for="segment in health.segments" :key="segment.status" class="flex items-center gap-2" :data-status="segment.status">
        <span class="size-3 rounded-sm border border-status-border" :class="SWATCH[segment.status]" aria-hidden="true"></span>
        <span>{{ t(`catalog.health.legend.${segment.status}`, { n: segment.count }, segment.count) }}</span>
      </li>
    </ul>
    <p v-if="partial" class="text-sm text-muted-foreground">{{ t('catalog.health.partial', { n: 1000 }) }}</p>
  </section>
</template>
