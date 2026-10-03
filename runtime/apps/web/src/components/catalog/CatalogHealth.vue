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
import { I18nT, useI18n } from 'vue-i18n';
import type { CatalogHealth } from '@/lib/catalog-health';
import type { ApiStatus } from '@/lib/status';

const props = defineProps<{ health: CatalogHealth; partial?: boolean }>();
const { t } = useI18n();

/**
 * Surface de chaque segment (jetons de statut de packages/ui), aux couleurs de la planche Catalogue (D-60 : vert `status-sain-bar`,
 * jaune, violet `status-reparation-bar`, bleu ; `assert_catalog_status_colors_match_planche`) ; la légende, dans l'ordre de la barre, est en texte. La surface du
 * statut `enquete` est celle de la carte (papier en clair, anthracite relevé en sombre) : son segment prend une surface atténuée et
 * un contour de statut, sinon il laisserait un trou dans la barre (`assert_health_bar_enquete_visible`).
 */
const FILL: Record<ApiStatus, string> = {
  enquete: 'fill-muted stroke-status-border',
  sain: 'fill-status-sain-bar',
  warning: 'fill-status-warning',
  reparation: 'fill-status-reparation-bar',
  erreur: 'fill-status-erreur',
  action_requise: 'fill-status-action-requise',
  bloquee: 'fill-status-bloquee',
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
/** Contour du segment `enquete` : épaisseur en pixels, gardée malgré la barre étirée (viewBox sans proportions). */
const OUTLINE = { 'vector-effect': 'non-scaling-stroke', 'stroke-width': 2 } as const;
const outlineOf = (status: ApiStatus) => (status === 'enquete' ? OUTLINE : {});
</script>

<template>
  <section class="flex flex-col gap-3.5 rounded-xl bg-card px-6 py-5 text-card-foreground" aria-labelledby="catalog-health-title" data-testid="catalog-health">
    <h2 id="catalog-health-title" class="sr-only">{{ t('catalog.health.title') }}</h2>
    <!-- Ratio en texte (20b § 3.3) : les arrêts volontaires ne sont jamais au dénominateur. -->
    <p class="text-sm font-bold" data-testid="health-line">
      <span data-testid="health-ratio">{{ health.inService > 0 ? t('catalog.health.ratio', { healthy: health.healthy, total: health.inService }) : t('catalog.health.noneInService') }}</span
      ><template v-if="health.stopped > 0"> · <span data-testid="health-stopped">{{ t('catalog.health.stopped', { n: health.stopped }, health.stopped) }}</span></template>
    </p>
    <div class="flex items-center gap-6">
      <svg class="h-4 flex-1 overflow-hidden rounded-full" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-testid="health-bar">
        <rect v-for="rect in rects" :key="rect.status" :class="FILL[rect.status]" :x="rect.x" y="0" :width="rect.width" height="4" v-bind="outlineOf(rect.status)" :data-status="rect.status" />
      </svg>
      <!-- Les arrêts volontaires sont à part (planche : « 1 arrêtée ») : séparateur en pointillés et carré anthracite, hors de la barre et du ratio. -->
      <span v-if="health.stopped > 0" class="flex items-center gap-2 border-l-2 border-dashed border-nav-muted-foreground pl-5" data-testid="health-stopped-mark">
        <span class="size-4 rounded-sm bg-status-bloquee" aria-hidden="true"></span>
        <span class="text-sm font-bold">{{ t('catalog.summary.stopped', { n: health.stopped }, health.stopped) }}</span>
      </span>
    </div>
    <ul class="flex flex-wrap gap-x-[22px] gap-y-1 text-sm text-muted-foreground" :aria-label="t('catalog.health.legendLabel')" data-testid="health-legend">
      <li v-for="segment in health.segments" :key="segment.status" class="flex items-center gap-1.5" :data-status="segment.status">
        <I18nT :keypath="`catalog.health.legend.${segment.status}`" :plural="segment.count" tag="span" scope="global">
          <template #n><b class="text-card-foreground">{{ segment.count }}</b></template>
        </I18nT>
      </li>
    </ul>
    <p v-if="partial" class="text-sm text-muted-foreground">{{ t('catalog.health.partial', { n: 1000 }) }}</p>
  </section>
</template>
