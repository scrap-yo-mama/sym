<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiSchedulesTab.vue
 * @description « Planifications » (06 § 2, 08 § 5) : liste (phrase cron, fuseau, prochaines exécutions calculées par le
 * serveur, règles) et création (aide cron via `cronstrue`, fuseau, entrée JSON, `overlap`, reprise des exécutions
 * manquées, règles). La validation (fréquence minimale d'une minute) est celle du serveur. Sur une API `bloquee`, aucune
 * planification ne se reprend : la seule reprise est Ré-enquêter (06 § 2, transition 18) ; suspendre et supprimer restent.
 * @component
 * @example <ApiSchedulesTab slug="zz-books" status="sain" />
 */
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ErrorState from '@/components/ErrorState.vue';
import LoadingState from '@/components/LoadingState.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ApiDetail } from '@/composables/useApiDetail';
import { useSchedules, type ScheduleWrite } from '@/composables/useSchedules';
import { describeCron } from '@/lib/cron';
import { formatDateTime } from '@/lib/display-format';

const props = defineProps<{ slug: string; status: ApiDetail['status'] }>();
const { t, te, locale } = useI18n();
const schedules = useSchedules(() => props.slug);

/** Reprendre une planification suspendue : jamais sur une API bloquée (aucun bouton de relance, 06 § 2). */
const canResume = computed(() => props.status !== 'bloquee');

const browserZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

const form = reactive({ cron: '0 8 * * *', timezone: browserZone, input: '{}', overlap: 'skip', missed: 'once', maxRunsPerDay: '', onlyIfTunnelOnline: false });
const inputInvalid = ref(false);

// Phrase d'aide recalculée à chaque saisie ; null = expression invalide.
const cronHelp = ref<string | null>(null);
watch(
  [() => form.cron, locale],
  async ([expression]) => {
    cronHelp.value = await describeCron(expression, locale.value);
  },
  { immediate: true },
);

const cronStatus = computed(() => (form.cron.trim() === '' ? 'empty' : cronHelp.value === null ? 'invalid' : 'ok'));

const listed = ref<Record<string, string>>({});
watch(
  [() => schedules.schedules.value, locale],
  async ([items]) => {
    const next: Record<string, string> = {};
    for (const item of items ?? []) next[item.id] = (await describeCron(item.cron, locale.value)) ?? item.cron;
    listed.value = next;
  },
  { immediate: true },
);

async function create(): Promise<void> {
  inputInvalid.value = false;
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(form.input);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('object');
    input = parsed as Record<string, unknown>;
  } catch {
    inputInvalid.value = true;
    return;
  }
  const max = Number(form.maxRunsPerDay);
  const body: ScheduleWrite = {
    cron: form.cron.trim(),
    timezone: form.timezone.trim(),
    input,
    overlap: form.overlap as ScheduleWrite['overlap'],
    missed: form.missed as ScheduleWrite['missed'],
    rules: { ...(form.onlyIfTunnelOnline ? { only_if_tunnel_online: true } : {}), ...(form.maxRunsPerDay !== '' && Number.isInteger(max) && max >= 1 ? { max_runs_per_day: max } : {}) },
  };
  await schedules.create(body);
}

const saveError = computed(() => {
  const error = schedules.saveError.value;
  if (!error) return null;
  return error.code && te(`apiErrors.${error.code}`) ? t(`apiErrors.${error.code}`) : t('apiErrors.generic');
});

const selectClass = 'h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none';
</script>

<template>
  <div class="flex flex-col gap-6">
    <section aria-labelledby="schedules-list" class="flex flex-col gap-3">
      <h2 id="schedules-list" class="text-lg font-semibold">{{ t('schedules.list') }}</h2>
      <LoadingState v-if="schedules.loading.value && !schedules.schedules.value" />
      <ErrorState v-else-if="schedules.error.value" :error="schedules.error.value" @retry="schedules.refetch()" />
      <p v-else-if="!schedules.schedules.value || schedules.schedules.value.length === 0" class="text-sm text-muted-foreground">{{ t('schedules.empty') }}</p>
      <ul v-else class="flex flex-col gap-3" data-testid="schedules-list">
        <li v-for="item in schedules.schedules.value" :key="item.id" class="flex flex-col gap-2 rounded-lg border p-3">
          <p class="font-medium">{{ listed[item.id] ?? item.cron }}</p>
          <p class="text-sm text-muted-foreground"><code>{{ item.cron }}</code> · {{ item.timezone }} · {{ t(`schedules.overlap.${item.overlap}`) }}</p>
          <p v-if="!item.enabled" class="text-sm">{{ t('schedules.paused') }}<template v-if="item.paused_reason"> ({{ te(`reasons.${item.paused_reason}`) ? t(`reasons.${item.paused_reason}`) : item.paused_reason }})</template></p>
          <div v-if="item.next_runs.length > 0">
            <p class="text-sm font-medium">{{ t('schedules.nextRuns') }}</p>
            <ul class="text-sm text-muted-foreground">
              <li v-for="at in item.next_runs" :key="at">{{ formatDateTime(at, locale) }}</li>
            </ul>
          </div>
          <div class="flex gap-2">
            <Button v-if="item.enabled" variant="outline" size="xs" :disabled="schedules.saving.value" @click="schedules.setEnabled(item.id, false)">{{ t('schedules.pause') }}</Button>
            <Button v-else-if="canResume" variant="outline" size="xs" :disabled="schedules.saving.value" @click="schedules.setEnabled(item.id, true)">{{ t('schedules.resume') }}</Button>
            <Button variant="outline" size="xs" :disabled="schedules.saving.value" @click="schedules.remove(item.id)">{{ t('schedules.delete') }}</Button>
          </div>
        </li>
      </ul>
    </section>

    <section aria-labelledby="schedules-create" class="flex flex-col gap-3">
      <h2 id="schedules-create" class="text-lg font-semibold">{{ t('schedules.create') }}</h2>
      <form class="flex max-w-xl flex-col gap-4" @submit.prevent="create">
        <div class="flex flex-col gap-1">
          <label for="schedule-cron" class="text-sm font-medium">{{ t('schedules.cron') }}</label>
          <Input id="schedule-cron" v-model="form.cron" autocomplete="off" spellcheck="false" class="font-mono" aria-describedby="schedule-cron-help" :aria-invalid="cronStatus === 'invalid' ? 'true' : 'false'" />
          <p id="schedule-cron-help" class="text-sm text-muted-foreground" data-testid="cron-help">
            <template v-if="cronStatus === 'ok'">{{ cronHelp }}</template>
            <template v-else-if="cronStatus === 'invalid'">{{ t('schedules.cronInvalid') }}</template>
            <template v-else>{{ t('schedules.cronHint') }}</template>
          </p>
        </div>
        <div class="flex flex-col gap-1">
          <label for="schedule-timezone" class="text-sm font-medium">{{ t('schedules.timezone') }}</label>
          <Input id="schedule-timezone" v-model="form.timezone" autocomplete="off" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="schedule-input" class="text-sm font-medium">{{ t('schedules.input') }}</label>
          <p class="text-sm text-muted-foreground">{{ t('schedules.inputHint') }}</p>
          <textarea id="schedule-input" v-model="form.input" rows="4" spellcheck="false" class="rounded-md border border-input bg-transparent p-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" :aria-invalid="inputInvalid ? 'true' : 'false'" />
          <p v-if="inputInvalid" role="alert" class="text-sm text-destructive">{{ t('schedules.inputInvalid') }}</p>
        </div>
        <div class="flex flex-wrap gap-4">
          <div class="flex flex-col gap-1">
            <label for="schedule-overlap" class="text-sm font-medium">{{ t('schedules.overlapLabel') }}</label>
            <select id="schedule-overlap" v-model="form.overlap" :class="selectClass">
              <option value="skip">{{ t('schedules.overlap.skip') }}</option>
              <option value="queue">{{ t('schedules.overlap.queue') }}</option>
              <option value="allow">{{ t('schedules.overlap.allow') }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <label for="schedule-missed" class="text-sm font-medium">{{ t('schedules.missedLabel') }}</label>
            <select id="schedule-missed" v-model="form.missed" :class="selectClass">
              <option value="once">{{ t('schedules.missed.once') }}</option>
              <option value="skip">{{ t('schedules.missed.skip') }}</option>
            </select>
          </div>
        </div>
        <fieldset class="flex flex-col gap-3 rounded-lg border p-3">
          <legend class="px-1 text-sm font-medium">{{ t('schedules.rules') }}</legend>
          <div class="flex flex-col gap-1">
            <label for="schedule-max" class="text-sm font-medium">{{ t('schedules.maxRunsPerDay') }}</label>
            <Input id="schedule-max" v-model="form.maxRunsPerDay" type="number" min="1" step="1" />
          </div>
          <div class="flex items-center gap-2">
            <input id="schedule-tunnel" v-model="form.onlyIfTunnelOnline" type="checkbox" class="size-5" />
            <label for="schedule-tunnel" class="text-sm">{{ t('schedules.onlyIfOnline') }}</label>
          </div>
          <p class="text-sm text-muted-foreground">{{ t('schedules.skipHint') }}</p>
        </fieldset>
        <p v-if="saveError" role="alert" class="text-sm text-destructive">{{ saveError }}</p>
        <div><Button type="submit" :disabled="schedules.saving.value || cronStatus !== 'ok'">{{ t('schedules.submit') }}</Button></div>
      </form>
    </section>
  </div>
</template>
