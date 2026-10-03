<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file BriefHintsList.vue
 * @description Liste des indices du dossier d'enquête de la fiche API (tâche 2.14, 19c § 7) : état, raison, coût et version
 * du dossier, posés par le code ; version du dossier lue par chaque version de stratégie. Aucun texte du dossier (notes,
 * valeurs, questions) n'est affiché ici : identifiants, types, codes et gabarits reconstruits par le serveur seulement.
 * @component
 * @example <BriefHintsList slug="zz-books" />
 */
import { useI18n } from 'vue-i18n';
import LoadingState from '@/components/LoadingState.vue';
import { useApiBrief } from '@/composables/useApiBrief';
import { formatUsd } from '@/lib/display-format';

const props = defineProps<{ slug: string }>();
const { t, te, locale } = useI18n();
const brief = useApiBrief(() => props.slug);

const label = (prefix: string, key: string | null | undefined) => (key && te(`${prefix}.${key}`) ? t(`${prefix}.${key}`) : '—');
</script>

<template>
  <section aria-labelledby="brief-heading" class="flex flex-col gap-3" data-testid="brief-hints">
    <h2 id="brief-heading" class="text-lg font-semibold">{{ t('brief.title') }}</h2>
    <p class="text-sm text-muted-foreground">{{ t('brief.intro') }}</p>
    <LoadingState v-if="brief.loading.value && brief.brief.value === null" />
    <!-- Erreur de lecture : une phrase, aucune commande (onglet consultable sur une API bloquée, liste blanche de 06 § 2). -->
    <p v-else-if="brief.error.value" class="text-sm text-muted-foreground" role="status">{{ t('brief.unavailable') }}</p>
    <p v-else-if="brief.brief.value === null || brief.brief.value.latest === null" class="text-sm text-muted-foreground">{{ t('brief.empty') }}</p>
    <template v-else>
      <p class="text-sm">
        {{
          t('brief.latest', {
            version: String(brief.brief.value.latest.version),
            hints: String(brief.brief.value.latest.hints),
            tried: String(brief.brief.value.latest.tried),
            questions: String(brief.brief.value.latest.open_questions),
          })
        }}
      </p>
      <p v-if="brief.brief.value.latest.erased" class="text-sm text-muted-foreground">{{ t('brief.erased') }}</p>
      <h3 class="font-medium">{{ t('brief.hintsHeading') }}</h3>
      <p v-if="brief.brief.value.report.length === 0 && brief.brief.value.hints.length === 0" class="text-sm text-muted-foreground">{{ t('brief.noFacts') }}</p>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="text-left text-muted-foreground">
            <th scope="col">{{ t('brief.columns.hint') }}</th>
            <th scope="col">{{ t('brief.columns.kind') }}</th>
            <th scope="col">{{ t('brief.columns.state') }}</th>
            <th scope="col">{{ t('brief.columns.reason') }}</th>
            <th scope="col">{{ t('brief.columns.cost') }}</th>
            <th scope="col">{{ t('brief.columns.version') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in brief.brief.value.report" :key="`r-${entry.id}`" class="border-t">
            <td><code>{{ entry.id }}</code><span v-if="entry.template" class="ml-2 text-muted-foreground">{{ entry.template }}</span></td>
            <td>{{ label('brief.kind', entry.kind) }}</td>
            <td>{{ label('brief.state', entry.state) }}<span v-if="entry.stale" class="ml-1 text-muted-foreground">({{ t('brief.stale') }})</span></td>
            <td>{{ label('brief.reason', entry.reason) }}</td>
            <td>{{ entry.cost_usd === null ? '—' : formatUsd(entry.cost_usd, locale) }}</td>
            <td>{{ String(brief.brief.value.latest.version) }}</td>
          </tr>
        </tbody>
      </table>
      <h3 class="font-medium">{{ t('brief.versionsHeading') }}</h3>
      <ul class="flex flex-col gap-1 text-sm">
        <li v-for="v in brief.brief.value.versions" :key="v.strategy_version">
          {{
            v.brief_version === null
              ? t('brief.versionNone', { strategy: String(v.strategy_version) })
              : t('brief.versionUsed', { strategy: String(v.strategy_version), brief: String(v.brief_version), used: String(v.used), ignored: String(v.ignored) })
          }}
        </li>
      </ul>
    </template>
  </section>
</template>
