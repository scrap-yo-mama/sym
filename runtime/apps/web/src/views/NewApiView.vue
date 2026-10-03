<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file NewApiView.vue
 * @description Page « Nouvelle API » (enquête en direct, 06 § 2) : formulaire (description, URL, exemple facultatif,
 * politique réseau, avertissement des sites à compte à confirmer), puis suivi de l'enquête en trois colonnes avec compteur
 * de budget, Pause et « Arrêter l'enquête ». `/apis/new` est le formulaire ; `/apis/new/:runId` rouvre une enquête
 * (le journal se rejoue depuis le début).
 * @page
 */
import { providersReceiving, type ProviderNoticeSettings } from '@/lib/provider-notice';
import { computed, nextTick, onMounted, onServerPrefetch, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import InstanceContactBanner from '@/components/InstanceContactBanner.vue';
import AccountSiteWarning from '@/components/investigation/AccountSiteWarning.vue';
import InvestigationBoard from '@/components/investigation/InvestigationBoard.vue';
import PhaseTimeline from '@/components/investigation/PhaseTimeline.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useInvestigation } from '@/composables/useInvestigation';
import { useLlmSettings } from '@/composables/useSettings';
import { useNewApiForm } from '@/composables/useNewApiForm';
import { emptyInvestigation, milestoneView } from '@/lib/investigation';
import { focusRouteHeading } from '@/router';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const investigation = useInvestigation();
const { state, busy, paused, cancelled, failure, elapsedS } = investigation;
const { form, errors, serverAsksAck, accountWarningShown, build } = useNewApiForm();

// Une enquête rouverte (`/apis/new/:runId`) montre l'écran de suivi dès l'ouverture, jamais le formulaire un instant.
const showBoard = computed(() => state.runId !== null || state.apiId !== null || typeof route.params.runId === 'string');

// Fournisseur de modèle qui recevra les extraits de trafic nettoyés (S2) : lu dans les réglages, réservés à l'admin.
// Un refus (403) n'est pas une panne : le message générique s'affiche, sans nom.
const llm = useLlmSettings();
onMounted(() => void llm.load());
onServerPrefetch(() => llm.load());
// Mention étendue (2.12) : `judge` s'il est activé, `reflect`, et `embed` si l'étage 4 de la mémoire l'est.
const providerNotice = computed(() => {
  const receiving = providersReceiving(llm.data.value as ProviderNoticeSettings | null);
  if (receiving.length > 1) return t('newApi.providerNoticeMany', { providers: receiving.join(', ') });
  const roleProvider = receiving[0] ?? llm.roles.investigate?.provider;
  const named = llm.providers.value.find((provider) => provider.id === roleProvider) ?? llm.providers.value[0];
  return named ? t('newApi.providerNotice', { provider: named.id }) : t('newApi.providerNoticeGeneric');
});

const submitting = computed(() => busy.value === 'create');
const formMilestones = milestoneView(emptyInvestigation(), { created: false });
const submitError = ref<string | null>(null);

async function openFromRoute(): Promise<void> {
  const id = route.params.runId;
  if (typeof id === 'string' && id !== '' && state.runId !== id) await investigation.open(id);
}
onMounted(openFromRoute);
watch(() => route.params.runId, () => void openFromRoute());

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitError.value = null;
  const body = build();
  if (!body) return;
  const result = await investigation.create(body);
  if (!result.ok) {
    if (result.code === 'account_site_ack_required') serverAsksAck.value = true;
    submitError.value = result.messageKey;
    return;
  }
  if (state.runId) await router.replace({ name: 'new-api-run', params: { runId: state.runId } });
  await nextTick();
  focusRouteHeading();
}

async function reinvestigate(): Promise<void> {
  if (await investigation.reinvestigate()) {
    if (state.runId) await router.replace({ name: 'new-api-run', params: { runId: state.runId } });
  }
}

const inputError = 'sym-error';
</script>

<template>
  <InvestigationBoard
    v-if="showBoard"
    :state="state"
    :elapsed-s="elapsedS"
    :paused="paused"
    :cancelled="cancelled"
    :busy="busy"
    :failure="failure"
    @pause="investigation.pause()"
    @resume="investigation.resume()"
    @cancel="investigation.cancel()"
    @validate="(payload) => investigation.validate(payload)"
    @reinvestigate="reinvestigate()"
  />
  <section v-else class="mx-auto flex max-w-2xl flex-col gap-6 py-10">
    <!-- Jalon 1 « Décrire » en cours : la frise est la même que pendant l'enquête (20 § 5.3). -->
    <PhaseTimeline :states="formMilestones" />
    <InstanceContactBanner />
    <Card>
      <CardHeader>
        <h1 data-route-heading tabindex="-1" class="text-2xl leading-none font-semibold tracking-tight">{{ t('newApi.title') }}</h1>
        <CardDescription>{{ t('newApi.intro') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="flex flex-col gap-5" novalidate data-testid="new-api-form" @submit.prevent="submit">
          <Alert v-if="submitError" variant="destructive" data-testid="new-api-error">
            <AlertDescription>{{ t(submitError) }}</AlertDescription>
          </Alert>

          <div class="flex flex-col gap-2">
            <Label for="api-description">{{ t('newApi.description') }}</Label>
            <textarea
              id="api-description"
              v-model="form.description"
              rows="3"
              maxlength="2000"
              required
              class="rounded-md border border-input bg-background p-2 text-sm"
              :aria-invalid="errors.description === true"
              :aria-describedby="errors.description ? 'api-description-hint api-description-error' : 'api-description-hint'"
            />
            <p id="api-description-hint" class="text-sm text-muted-foreground">{{ t('newApi.descriptionHint') }} {{ t('newApi.descriptionTemplate') }}</p>
            <p v-if="errors.description" id="api-description-error" :class="inputError" role="alert">{{ t('newApi.descriptionRequired') }}</p>
          </div>

          <div class="flex flex-col gap-2">
            <Label for="api-url">{{ t('newApi.url') }}</Label>
            <Input
              id="api-url"
              type="url"
              name="url"
              required
              autocomplete="off"
              :model-value="form.url"
              :aria-invalid="errors.url === true"
              :aria-describedby="errors.url ? 'api-url-error' : undefined"
              @update:model-value="(value: string | number) => (form.url = String(value))"
            />
            <p v-if="errors.url" id="api-url-error" :class="inputError" role="alert">{{ t('newApi.urlInvalid') }}</p>
          </div>

          <div class="flex flex-col gap-2">
            <Label for="api-example">{{ t('newApi.example') }}</Label>
            <textarea
              id="api-example"
              v-model="form.example"
              rows="4"
              spellcheck="false"
              class="rounded-md border border-input bg-background p-2 font-mono text-xs"
              :aria-invalid="errors.example === true"
              :aria-describedby="errors.example ? 'api-example-error' : undefined"
            />
            <p v-if="errors.example" id="api-example-error" :class="inputError" role="alert">{{ t('newApi.exampleInvalid') }}</p>
          </div>

          <fieldset class="flex flex-col gap-1" :aria-describedby="errors.network ? 'api-network-error' : undefined">
            <legend class="mb-1 text-sm font-medium">{{ t('newApi.network.legend') }}</legend>
            <label class="flex min-h-11 items-center gap-2 text-sm"><input v-model="form.direct" type="checkbox" class="size-4" />{{ t('newApi.network.direct') }}</label>
            <label class="flex min-h-11 items-center gap-2 text-sm"><input v-model="form.dcProxy" type="checkbox" class="size-4" />{{ t('newApi.network.dcProxy') }}</label>
            <label class="flex min-h-11 items-start gap-2 text-sm"><input v-model="form.resProxy" type="checkbox" class="mt-1 size-4" />{{ t('newApi.network.resProxy') }}</label>
            <div v-if="form.resProxy" class="ml-6 flex flex-col gap-1">
              <Label for="api-country">{{ t('newApi.network.country') }}</Label>
              <Input
                id="api-country"
                class="w-24"
                maxlength="2"
                :model-value="form.country"
                :aria-invalid="errors.country === true"
                :aria-describedby="errors.country ? 'api-country-error' : undefined"
                @update:model-value="(value: string | number) => (form.country = String(value))"
              />
              <p v-if="errors.country" id="api-country-error" :class="inputError" role="alert">{{ t('newApi.countryInvalid') }}</p>
            </div>
            <label class="flex min-h-11 items-start gap-2 text-sm"><input v-model="form.tunnel" type="checkbox" class="mt-1 size-4" />{{ t('newApi.network.tunnel') }}</label>
            <p v-if="errors.network" id="api-network-error" :class="inputError" role="alert">{{ t('newApi.network.atLeastOne') }}</p>
          </fieldset>

          <div class="flex flex-col gap-2">
            <label class="flex min-h-11 items-center gap-2 text-sm"><input v-model="form.accountDeclared" type="checkbox" class="size-4" data-testid="account-declare" />{{ t('newApi.account.declare') }}</label>
            <AccountSiteWarning v-if="accountWarningShown" v-model="form.accountConfirmed" :error="errors.account === true" />
          </div>

          <p class="text-sm text-muted-foreground" data-testid="provider-notice">{{ providerNotice }}</p>

          <!-- aria-disabled et non disabled : le bouton garde le focus pendant l'envoi -->
          <Button type="submit" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="submitting" :aria-busy="submitting">
            {{ submitting ? t('newApi.submitting') : t('newApi.submit') }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </section>
</template>
