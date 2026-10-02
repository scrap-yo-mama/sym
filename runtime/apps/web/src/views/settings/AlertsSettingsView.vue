<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file AlertsSettingsView.vue
 * @description Réglages > Alertes (06 § 2, 08 § 5) : SMTP et webhooks, chacun avec son bouton **Tester** ; « non testé » tant
 * qu'il ne l'a pas été. Mot de passe SMTP en écriture seule ; secret de signature d'un webhook affiché une seule fois.
 * @page
 */
import { computed, onMounted, onServerPrefetch, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import TestOutcome from '@/components/settings/TestOutcome.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WEBHOOK_EVENTS, useSmtp, useWebhooks, type WebhookEvent } from '@/composables/useSettings';
import { selectClass } from '@/lib/classes';

const { t } = useI18n();
const smtp = useSmtp();
const webhooks = useWebhooks();

const smtpDraft = reactive({ host: '', port: 587, security: 'starttls' as 'tls' | 'starttls' | 'none', from: '', username: '', password: '', testTo: '' });

/** Charge SMTP et webhooks ; le formulaire SMTP reprend les réglages enregistrés (jamais le mot de passe, écriture seule). */
async function load(): Promise<void> {
  await Promise.all([smtp.reload(), webhooks.reload()]);
  const current = smtp.data.value;
  if (current) Object.assign(smtpDraft, { host: current.host, port: current.port, security: current.security, from: current.from });
}
onMounted(() => void load());
onServerPrefetch(load);

async function saveSmtp(): Promise<void> {
  const body = { host: smtpDraft.host.trim(), port: Number(smtpDraft.port), security: smtpDraft.security, from: smtpDraft.from.trim() } as {
    host: string;
    port: number;
    security: 'tls' | 'starttls' | 'none';
    from: string;
    username?: string;
    password?: string;
  };
  if (smtpDraft.username !== '') body.username = smtpDraft.username;
  if (smtpDraft.password !== '') body.password = smtpDraft.password;
  smtpDraft.password = ''; // écriture seule : le champ est vidé dès l'envoi
  await smtp.save(body);
}

const hook = reactive({ url: '', apiSlug: '', events: ['run.failed'] as WebhookEvent[] });
const hooks = computed(() => webhooks.data.value?.subscriptions ?? []);

/** Clé de traduction d'un événement (`run.failed` devient `run_failed` : un point séparerait le chemin de la clé). */
const eventKey = (event: WebhookEvent): string => `settings.alerts.event.${event.replace('.', '_')}`;

function toggleEvent(event: WebhookEvent, checked: boolean): void {
  hook.events = checked ? [...hook.events, event] : hook.events.filter((entry) => entry !== event);
}

async function addHook(): Promise<void> {
  if (hook.events.length === 0) return;
  const ok = await webhooks.create({ url: hook.url.trim(), events: hook.events, api_slug: hook.apiSlug.trim() || null });
  if (ok) hook.url = '';
}

</script>

<template>
  <section class="flex flex-col gap-6" aria-labelledby="alerts-heading">
    <header class="flex flex-col gap-1">
      <h1 id="alerts-heading" data-route-heading tabindex="-1" class="sym-title">{{ t('settings.alerts.title') }}</h1>
      <p class="text-sm text-muted-foreground">{{ t('settings.alerts.intro') }}</p>
    </header>

    <Alert v-if="smtp.forbidden.value && webhooks.forbidden.value" data-testid="settings-forbidden"><AlertDescription>{{ t('settings.adminOnly') }}</AlertDescription></Alert>
    <template v-else>
      <form class="flex flex-col gap-3 rounded-xl border bg-card p-4" novalidate data-testid="smtp-form" @submit.prevent="saveSmtp">
        <h2 class="text-lg font-semibold">{{ t('settings.alerts.smtp') }}</h2>
        <p v-if="!smtp.data.value && !smtp.loading.value" class="text-sm text-muted-foreground">{{ t('settings.alerts.smtpEmpty') }}</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="flex flex-col gap-1">
            <Label for="smtp-host">{{ t('settings.alerts.host') }}</Label>
            <Input id="smtp-host" autocomplete="off" :model-value="smtpDraft.host" @update:model-value="(value: string | number) => (smtpDraft.host = String(value))" />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="smtp-port">{{ t('settings.alerts.port') }}</Label>
            <Input id="smtp-port" type="number" min="1" max="65535" :model-value="smtpDraft.port" @update:model-value="(value: string | number) => (smtpDraft.port = Number(value))" />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="smtp-security">{{ t('settings.alerts.security') }}</Label>
            <select id="smtp-security" v-model="smtpDraft.security" :class="selectClass">
              <option value="tls">{{ t('settings.alerts.securityTls') }}</option>
              <option value="starttls">{{ t('settings.alerts.securityStarttls') }}</option>
              <option value="none">{{ t('settings.alerts.securityNone') }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label for="smtp-from">{{ t('settings.alerts.from') }}</Label>
            <Input id="smtp-from" type="email" autocomplete="off" :model-value="smtpDraft.from" @update:model-value="(value: string | number) => (smtpDraft.from = String(value))" />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="smtp-username">{{ t('settings.alerts.username') }}</Label>
            <Input id="smtp-username" autocomplete="off" :model-value="smtpDraft.username" @update:model-value="(value: string | number) => (smtpDraft.username = String(value))" />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="smtp-password">{{ t('settings.alerts.password') }}</Label>
            <Input
              id="smtp-password"
              type="password"
              autocomplete="new-password"
              aria-describedby="smtp-password-hint"
              :model-value="smtpDraft.password"
              @update:model-value="(value: string | number) => (smtpDraft.password = String(value))"
            />
            <p id="smtp-password-hint" class="text-sm text-muted-foreground">{{ smtp.data.value?.password_set ? t('settings.secret.set') : t('settings.secret.unset') }}</p>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="smtp.saving.value">{{ smtp.saving.value ? t('common.saving') : t('common.save') }}</Button>
          <p role="status" class="text-sm text-muted-foreground">{{ smtp.saved.value ? t('common.saved') : '' }}</p>
        </div>
        <Alert v-if="smtp.saveFailure.value" variant="destructive"><AlertDescription>{{ t(smtp.saveFailure.value) }}</AlertDescription></Alert>
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <Label for="smtp-test-to">{{ t('settings.alerts.testTo') }}</Label>
            <Input id="smtp-test-to" type="email" autocomplete="off" :model-value="smtpDraft.testTo" @update:model-value="(value: string | number) => (smtpDraft.testTo = String(value))" />
          </div>
          <Button type="button" variant="outline" :disabled="smtpDraft.testTo.trim() === '' || smtp.outcomes.value.smtp?.state === 'running'" @click="smtp.test(smtpDraft.testTo.trim())">{{ t('settings.test') }}</Button>
        </div>
        <TestOutcome :outcome="smtp.outcomes.value.smtp" :tested-at="smtp.data.value?.tested_at ?? null" />
      </form>

      <div class="flex flex-col gap-3">
        <h2 class="text-lg font-semibold">{{ t('settings.alerts.webhooks') }}</h2>
        <Alert v-if="webhooks.failureAction.value" variant="destructive"><AlertDescription>{{ t(webhooks.failureAction.value) }}</AlertDescription></Alert>
        <div v-if="webhooks.createdSecret.value" class="flex flex-col gap-2 rounded-lg border-2 p-3" role="status" data-testid="webhook-secret">
          <p class="font-medium">{{ t('settings.alerts.secretTitle') }}</p>
          <p class="font-mono text-sm break-all">{{ webhooks.createdSecret.value }}</p>
          <p class="text-sm text-muted-foreground">{{ t('settings.alerts.secretText') }}</p>
          <div><Button type="button" variant="outline" size="sm" @click="webhooks.dismissSecret()">{{ t('settings.alerts.dismissSecret') }}</Button></div>
        </div>
        <p v-if="hooks.length === 0" class="text-sm text-muted-foreground" data-testid="webhooks-empty">{{ t('settings.alerts.webhooksEmpty') }}</p>
        <div v-else class="relative overflow-x-auto rounded-xl border">
          <table class="w-full text-left text-sm">
            <caption class="sr-only">{{ t('settings.alerts.webhooks') }}</caption>
            <thead class="border-b bg-muted/50">
              <tr>
                <th scope="col" class="p-3 font-medium">{{ t('settings.alerts.url') }}</th>
                <th scope="col" class="p-3 font-medium">{{ t('settings.alerts.events') }}</th>
                <th scope="col" class="p-3 font-medium"><span class="sr-only">{{ t('settings.test') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="subscription in hooks" :key="subscription.id" class="border-b align-top last:border-0" data-testid="webhook-row">
                <th scope="row" class="p-3 font-medium break-all">
                  {{ subscription.url }}
                  <span class="block text-xs font-normal text-muted-foreground">{{ t(`settings.alerts.status.${subscription.status}`) }}</span>
                </th>
                <td class="p-3">{{ subscription.events.map((event) => t(eventKey(event))).join(', ') }}</td>
                <td class="flex flex-col gap-1 p-3">
                  <div class="flex gap-2">
                    <Button type="button" variant="outline" size="sm" :disabled="webhooks.outcomes.value[subscription.id]?.state === 'running'" @click="webhooks.test(subscription.id)">{{ t('settings.test') }}</Button>
                    <Button type="button" variant="outline" size="sm" @click="webhooks.remove(subscription.id)">{{ t('settings.alerts.remove') }}</Button>
                  </div>
                  <TestOutcome :outcome="webhooks.outcomes.value[subscription.id]" :tested-at="subscription.tested_at" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <form class="flex flex-col gap-3 rounded-xl border bg-card p-4" novalidate data-testid="webhook-form" @submit.prevent="addHook">
          <div class="flex flex-col gap-1">
            <Label for="webhook-url">{{ t('settings.alerts.url') }}</Label>
            <Input id="webhook-url" type="url" autocomplete="off" :model-value="hook.url" @update:model-value="(value: string | number) => (hook.url = String(value))" />
          </div>
          <fieldset class="flex flex-wrap gap-x-4">
            <legend class="mb-1 text-sm font-medium">{{ t('settings.alerts.events') }}</legend>
            <label v-for="event in WEBHOOK_EVENTS" :key="event" class="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" class="size-4" :checked="hook.events.includes(event)" @change="toggleEvent(event, ($event.target as HTMLInputElement).checked)" />
              {{ t(eventKey(event)) }}
            </label>
          </fieldset>
          <div class="flex flex-col gap-1">
            <Label for="webhook-api">{{ t('settings.alerts.apiSlug') }}</Label>
            <Input id="webhook-api" class="max-w-xs" autocomplete="off" :model-value="hook.apiSlug" @update:model-value="(value: string | number) => (hook.apiSlug = String(value))" />
          </div>
          <div>
            <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="webhooks.busy.value">{{ t('settings.alerts.add') }}</Button>
          </div>
        </form>
      </div>
    </template>
  </section>
</template>
