<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file AuditView.vue
 * @description Audit (admin, 06 § 2, 13 § 9) : journal des actions d'administration et des connexions, filtres (action, compte, résultat,
 * période), pagination à curseur, export NDJSON (owner). Le journal ne porte que des métadonnées (jamais de secret, de cookie, de contenu
 * de dataset ni d'argument d'outil) : l'admin n'y voit que l'état, le coût ou la durée d'une opération, jamais le contenu d'un autre
 * (INV5, A3, `assert_admin_metadata_only`). Le résultat se lit en texte, pas seulement en couleur (WCAG 1.4.1).
 * @page
 */
import { onMounted, onServerPrefetch } from 'vue';
import { useI18n } from 'vue-i18n';
import TextField from '@/components/account/TextField.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AUDIT_OUTCOMES, useAudit, type AuditEvent } from '@/composables/useAudit';
import { useSession } from '@/composables/useSession';
import { selectClass } from '@/lib/classes';
import { formatDateTime } from '@/lib/format';

const { t, te, locale } = useI18n();
const { can } = useSession();
const audit = useAudit();
const { filters, events, actors } = audit;

onMounted(() => void audit.loadActors());
onServerPrefetch(async () => {
  await Promise.all([audit.loadActors(), events.refetch()]);
});

const date = (iso: string): string => formatDateTime(iso, locale.value) ?? iso;
/** Libellé d'une action d'audit ; un code sans traduction s'affiche tel quel (clés avec « _ » au lieu de « . »). */
const actionLabel = (action: string): string => {
  const key = `audit.action.${action.replaceAll('.', '_')}`;
  return te(key) ? t(key) : action;
};
const actorLabel = (event: AuditEvent): string => {
  if (event.actor_user_id) return actors.value.find((actor) => actor.id === event.actor_user_id)?.label ?? event.actor_user_id;
  return event.actor_via === 'system' ? t('audit.system') : (event.actor_ref ?? t('audit.unknownActor'));
};
const targetLabel = (event: AuditEvent): string => (event.target_type ? `${event.target_type}${event.target_id ? ` ${event.target_id}` : ''}` : '—');
const metaKeys = (event: AuditEvent): [string, string][] => Object.entries(event.meta).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]);
/** Icône de forme distincte par résultat : le statut ne dépend pas de la couleur seule (1.4.1). */
const OUTCOME_MARK: Record<string, string> = { success: '✓', denied: '✕', error: '!' };
</script>

<template>
  <section class="mx-auto flex max-w-7xl flex-col gap-4 py-8" aria-labelledby="audit-heading">
    <header class="flex flex-col gap-1">
      <h1 id="audit-heading" data-route-heading tabindex="-1" class="text-2xl font-semibold tracking-tight">{{ t('audit.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('audit.intro') }}</p>
    </header>

    <form class="flex flex-wrap items-end gap-3" novalidate data-testid="audit-filters" @submit.prevent="events.refetch()">
      <fieldset class="flex flex-wrap items-end gap-3">
        <legend class="sr-only">{{ t('audit.filters.legend') }}</legend>
        <TextField id="audit-action" v-model="filters.action" :label="t('audit.filters.action')" :hint="t('audit.filters.actionHint')" name="action" class="w-56" autocomplete="off" />
        <div class="flex flex-col gap-1">
          <Label for="audit-actor">{{ t('audit.filters.actor') }}</Label>
          <select id="audit-actor" v-model="filters.actor" class="max-w-64" :class="selectClass">
            <option value="">{{ t('audit.filters.all') }}</option>
            <option v-for="actor in actors" :key="actor.id" :value="actor.id">{{ actor.label }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <Label for="audit-outcome">{{ t('audit.filters.outcome') }}</Label>
          <select id="audit-outcome" v-model="filters.outcome" :class="selectClass">
            <option value="">{{ t('audit.filters.all') }}</option>
            <option v-for="outcome in AUDIT_OUTCOMES" :key="outcome" :value="outcome">{{ t(`audit.outcomes.${outcome}`) }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <Label for="audit-since">{{ t('audit.filters.since') }}</Label>
          <Input id="audit-since" type="date" :model-value="filters.since" @update:model-value="(value: string | number) => (filters.since = String(value))" />
        </div>
        <div class="flex flex-col gap-1">
          <Label for="audit-until">{{ t('audit.filters.until') }}</Label>
          <Input id="audit-until" type="date" :model-value="filters.until" @update:model-value="(value: string | number) => (filters.until = String(value))" />
        </div>
      </fieldset>
      <Button type="submit">{{ t('audit.filters.apply') }}</Button>
      <Button type="button" variant="outline" @click="audit.reset()">{{ t('audit.filters.reset') }}</Button>
      <Button v-if="can('audit:export')" type="button" variant="outline" data-testid="audit-export" :disabled="audit.exporting.value" @click="audit.exportNdjson()">
        {{ audit.exporting.value ? t('audit.exporting') : t('audit.export') }}
      </Button>
    </form>

    <Alert v-if="audit.exportFailure.value" variant="destructive"><AlertDescription>{{ t(audit.exportFailure.value) }}</AlertDescription></Alert>

    <p v-if="events.loading.value && !events.loaded.value" role="status" class="text-sm text-muted-foreground">{{ t('ui.loading') }}</p>
    <div v-else-if="events.error.value" class="flex flex-wrap items-center gap-3">
      <Alert variant="destructive" class="w-auto" data-testid="audit-error"><AlertDescription>{{ t(events.error.value.status === 403 ? 'errors.forbidden' : 'errors.generic') }}</AlertDescription></Alert>
      <Button type="button" variant="outline" size="sm" @click="events.refetch()">{{ t('ui.retry') }}</Button>
    </div>
    <p v-else-if="events.items.value.length === 0" class="text-sm text-muted-foreground" data-testid="audit-empty">{{ t('audit.empty') }}</p>
    <div v-else class="relative overflow-x-auto rounded-xl border">
      <table class="w-full text-left text-sm" data-testid="audit-table" :aria-busy="events.loading.value">
        <caption class="sr-only">{{ t('audit.caption') }}</caption>
        <thead class="border-b bg-muted/50">
          <tr>
            <th scope="col" class="p-3 font-medium">{{ t('audit.columns.at') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('audit.columns.actor') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('audit.columns.via') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('audit.columns.action') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('audit.columns.target') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('audit.columns.outcome') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('audit.columns.address') }}</th>
            <th scope="col" class="p-3 font-medium">{{ t('audit.columns.details') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="event in events.items.value" :key="event.id" class="border-b align-top last:border-0" data-testid="audit-row">
            <th scope="row" class="p-3 font-normal whitespace-nowrap">{{ date(event.at) }}</th>
            <td class="p-3 break-all">{{ actorLabel(event) }}</td>
            <td class="p-3">{{ t(`audit.via.${event.actor_via}`) }}</td>
            <td class="p-3">
              {{ actionLabel(event.action) }}
              <code v-if="actionLabel(event.action) !== event.action" class="block text-xs text-muted-foreground">{{ event.action }}</code>
            </td>
            <td class="p-3 break-all">{{ targetLabel(event) }}</td>
            <td class="p-3 whitespace-nowrap"><span aria-hidden="true">{{ OUTCOME_MARK[event.outcome] }}</span> {{ t(`audit.outcomes.${event.outcome}`) }}</td>
            <td class="p-3">{{ event.ip ?? '—' }}</td>
            <td class="p-3">
              <details v-if="metaKeys(event).length > 0">
                <summary class="min-h-6 cursor-pointer text-sm underline underline-offset-4">{{ t('audit.columns.details') }}</summary>
                <dl class="mt-1 text-xs">
                  <template v-for="[key, value] in metaKeys(event)" :key="key">
                    <dt class="font-medium">{{ key }}</dt>
                    <dd class="break-all text-muted-foreground">{{ value }}</dd>
                  </template>
                </dl>
              </details>
              <span v-else class="text-muted-foreground">{{ t('audit.noDetails') }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="events.hasMore()"><Button type="button" variant="outline" :disabled="events.loadingMore.value" @click="events.loadMore()">{{ t('audit.loadMore') }}</Button></div>
  </section>
</template>
