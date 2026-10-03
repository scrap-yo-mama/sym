// SPDX-License-Identifier: AGPL-3.0-only
// Réglages BYO (06 § 2, 08 § 7) : modèles IA, proxys, alertes (SMTP, webhooks), extension et sessions. Les secrets sont en
// écriture seule : la console ne les relit jamais (le serveur ne les renvoie pas, INV8) et vide le champ dès l'envoi. Les droits
// sont ceux du serveur : un 403 devient un message, jamais une décision locale (06 § 4.1).
import type { components } from '@runtime/client';
import { computed, nextTick, reactive, ref } from 'vue';
import { call, type CallResult } from '@/lib/api-call';
import { getApi } from '@/lib/api';
import { useResource, useTester } from '@/composables/useResource';

type Schemas = components['schemas'];
export type LlmSettings = Schemas['LlmSettings'];
export type LlmRoleName = 'investigate' | 'repair' | 'extract' | 'agent';
export const LLM_ROLES: readonly LlmRoleName[] = ['investigate', 'repair', 'extract', 'agent'];
export type LlmPreset = Schemas['LlmPreset'];
export const LLM_PRESETS: readonly LlmPreset[] = ['zai', 'openrouter', 'vllm', 'ollama', 'deepseek', 'qwen', 'openai', 'anthropic', 'gemini', 'mistral', 'groq', 'custom'];

/** URL de base pré-remplie par préréglage (points d'accès compatibles OpenAI). `custom`, `vllm` et `ollama` : à saisir. */
export const LLM_PRESET_BASE_URLS: Partial<Record<LlmPreset, string>> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
};

/** Fournisseur en cours d'édition ; `newApiKey` est le seul endroit où une clé vit, et seulement le temps de la saisie. */
export interface ProviderDraft {
  id: string;
  preset: LlmPreset;
  base_url: string;
  timeout_ms?: number;
  max_retries?: number;
  models?: Schemas['LlmProviderBase']['models'];
  apiKeySet: boolean;
  apiKeyUnreadable: boolean;
  newApiKey: string;
}

export function useLlmSettings() {
  const resource = useResource<LlmSettings>(() => call(() => getApi().GET('/api/settings/llm')));
  const providers = ref<ProviderDraft[]>([]);
  const roles = reactive<Partial<Record<LlmRoleName, { provider: string; model: string }>>>({});
  /** Statut du banc (lecture seule, 15 § 11) : jamais renvoyé au serveur. */
  const validatedModels = ref<Schemas['ValidatedModel'][]>([]);
  const saving = ref(false);
  const saveFailure = ref<string | null>(null);
  const saved = ref(false);
  const tester = useTester();
  let loaded: LlmSettings | null = null;

  function adopt(settings: LlmSettings): void {
    loaded = settings;
    validatedModels.value = settings.validated_models ?? [];
    providers.value = settings.providers.map((provider) => ({
      id: provider.id,
      preset: provider.preset,
      base_url: provider.base_url,
      timeout_ms: provider.timeout_ms,
      max_retries: provider.max_retries,
      models: provider.models,
      apiKeySet: provider.api_key_set,
      apiKeyUnreadable: provider.api_key_unreadable === true,
      newApiKey: '',
    }));
    for (const name of LLM_ROLES) {
      const role = settings.roles?.[name];
      if (role) roles[name] = { provider: role.provider, model: role.model };
      else delete roles[name];
    }
  }

  async function load(): Promise<void> {
    if (await resource.reload()) adopt(resource.data.value as LlmSettings);
  }

  function addProvider(): void {
    providers.value = [...providers.value, { id: '', preset: 'custom', base_url: '', apiKeySet: false, apiKeyUnreadable: false, newApiKey: '' }];
  }

  /** Change de préréglage et pré-remplit l'URL de base, sauf si l'utilisateur en a saisi une autre à la main. */
  function setPreset(index: number, preset: LlmPreset): void {
    const provider = providers.value[index];
    if (!provider) return;
    const previous = LLM_PRESET_BASE_URLS[provider.preset];
    const next = LLM_PRESET_BASE_URLS[preset];
    if (next && (provider.base_url.trim() === '' || provider.base_url === previous)) provider.base_url = next;
    provider.preset = preset;
  }

  function removeProvider(index: number): void {
    providers.value = providers.value.filter((_, at) => at !== index);
  }

  /** Corps du PUT : une clé n'est envoyée que si elle vient d'être saisie, sinon l'ancienne est conservée côté serveur. */
  function payload(): Schemas['LlmSettingsWrite'] {
    const body: Schemas['LlmSettingsWrite'] = {
      providers: providers.value.map((provider) => {
        const entry: Schemas['LlmProviderWrite'] = { id: provider.id.trim(), preset: provider.preset, base_url: provider.base_url.trim() };
        if (provider.timeout_ms !== undefined) entry.timeout_ms = provider.timeout_ms;
        if (provider.max_retries !== undefined) entry.max_retries = provider.max_retries;
        if (provider.models) entry.models = provider.models;
        if (provider.newApiKey !== '') entry.api_key = provider.newApiKey;
        return entry;
      }),
    };
    const nextRoles: Schemas['LlmRoles'] = {};
    for (const name of LLM_ROLES) {
      const choice = roles[name];
      if (choice && choice.provider && choice.model.trim()) nextRoles[name] = { ...loaded?.roles?.[name], provider: choice.provider, model: choice.model.trim() };
    }
    // Rôles hors de l'écran (`judge`, `reflect`, `embed`, 2.12) et réglages du juge et de la mémoire : gardés tels quels.
    for (const [name, role] of Object.entries(loaded?.roles ?? {})) {
      if (!(LLM_ROLES as readonly string[]).includes(name) && role) (nextRoles as Record<string, unknown>)[name] = role;
    }
    body.roles = nextRoles;
    if (loaded?.judge) body.judge = loaded.judge;
    if (loaded?.catalog_memory) body.catalog_memory = loaded.catalog_memory;
    if (loaded?.redact) body.redact = loaded.redact;
    if (loaded?.log_prompts) body.log_prompts = loaded.log_prompts;
    return body;
  }

  async function save(): Promise<boolean> {
    saving.value = true;
    saveFailure.value = null;
    saved.value = false;
    const body = payload();
    for (const provider of providers.value) provider.newApiKey = ''; // le champ est vidé dès l'envoi : la clé ne reste pas en mémoire d'écran
    const result = await call(() => getApi().PUT('/api/settings/llm', { body }));
    saving.value = false;
    if (!result.ok) {
      saveFailure.value = result.messageKey;
      return false;
    }
    resource.data.value = result.data;
    adopt(result.data);
    saved.value = true;
    return true;
  }

  function test(role: LlmRoleName): Promise<void> {
    const choice = roles[role];
    if (!choice) return Promise.resolve();
    return tester.run(role, () => call(() => getApi().POST('/api/settings/llm/test', { body: { provider: choice.provider, model: choice.model } })));
  }

  return { ...resource, providers, roles, validatedModels, saving, saveFailure, saved, outcomes: tester.outcomes, load, addProvider, removeProvider, setPreset, save, test };
}

export type ProxyWrite = Schemas['ProxyWrite'];

export function useProxies() {
  const resource = useResource<Schemas['ProxyList']>(() => call(() => getApi().GET('/api/settings/proxies')));
  const tester = useTester();
  const failure = ref<string | null>(null);
  const busy = ref(false);

  async function create(body: ProxyWrite): Promise<boolean> {
    busy.value = true;
    failure.value = null;
    const result = await call(() => getApi().POST('/api/settings/proxies', { body }));
    busy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    await resource.reload();
    return true;
  }

  async function remove(id: string): Promise<boolean> {
    failure.value = null;
    const result = await call<undefined>(() => getApi().DELETE('/api/settings/proxies/{id}', { params: { path: { id } } }));
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    await resource.reload();
    return true;
  }

  function test(id: string): Promise<void> {
    return tester.run(id, () => call(() => getApi().POST('/api/settings/proxies/{id}/test', { params: { path: { id } } })), ['exit_ip', 'exit_country']);
  }

  return { ...resource, failureAction: failure, busy, outcomes: tester.outcomes, create, remove, test };
}

export type SmtpSettings = Schemas['SmtpSettings'];

export function useSmtp() {
  const resource = useResource<SmtpSettings | null>(() => call(() => getApi().GET('/api/settings/smtp')));
  const tester = useTester();
  const saving = ref(false);
  const saveFailure = ref<string | null>(null);
  const saved = ref(false);

  async function save(body: Schemas['SmtpSettingsWrite']): Promise<boolean> {
    saving.value = true;
    saveFailure.value = null;
    saved.value = false;
    const result = await call(() => getApi().PUT('/api/settings/smtp', { body }));
    saving.value = false;
    if (!result.ok) {
      saveFailure.value = result.messageKey;
      return false;
    }
    resource.data.value = result.data;
    saved.value = true;
    return true;
  }

  function test(to: string): Promise<void> {
    return tester.run('smtp', () => call(() => getApi().POST('/api/settings/smtp/test', { body: { to } })));
  }

  return { ...resource, saving, saveFailure, saved, outcomes: tester.outcomes, save, test };
}

export type WebhookEvent = Schemas['WebhookEvent'];
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = ['run.succeeded', 'run.failed', 'api.status_changed', 'items.new'];

export function useWebhooks() {
  const resource = useResource<Schemas['WebhookSubscriptionList']>(() => call(() => getApi().GET('/api/webhook-subscriptions')));
  const tester = useTester();
  const failure = ref<string | null>(null);
  const busy = ref(false);
  /** Secret `whsec_…` : renvoyé une seule fois, à la création ; effacé dès que l'utilisateur l'a lu. */
  const createdSecret = ref<string | null>(null);

  async function create(body: Schemas['WebhookSubscriptionWrite']): Promise<boolean> {
    busy.value = true;
    failure.value = null;
    const result = await call(() => getApi().POST('/api/webhook-subscriptions', { body }));
    busy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    createdSecret.value = result.data.secret ?? null;
    await resource.reload();
    return true;
  }

  async function remove(id: string): Promise<boolean> {
    failure.value = null;
    const result = await call<undefined>(() => getApi().DELETE('/api/webhook-subscriptions/{id}', { params: { path: { id } } }));
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    await resource.reload();
    return true;
  }

  function test(id: string): Promise<void> {
    return tester.run(id, () => call(() => getApi().POST('/api/webhook-subscriptions/{id}/test', { params: { path: { id } } })));
  }

  return { ...resource, failureAction: failure, busy, createdSecret, outcomes: tester.outcomes, create, remove, test, dismissSecret: () => (createdSecret.value = null) };
}


/** Clé i18n du message affiché quand le mot de passe actuel n'est pas saisi. */
const PASSWORD_REQUIRED = 'settings.extension.passwordRequired';
/** Messages qui portent sur le champ « mot de passe actuel » : le champ est alors marqué invalide (WCAG 3.3.1). */
const PASSWORD_FAILURES = new Set([PASSWORD_REQUIRED, 'errors.reauth_failed', 'errors.invalid_request']);

/** Extension et sessions : code d'appairage (mot de passe exigé), appareils, domaines connectés, révocation. */
export function useExtensionSettings() {
  const devices = useResource<Schemas['ExtensionDeviceList']>(() => call(() => getApi().GET('/api/extension/devices')));
  const sites = useResource<Schemas['ConnectedSiteList']>(() => call(() => getApi().GET('/api/sites')));
  const failure = ref<string | null>(null);
  const pairing = ref<{ code: string; expiresAt: string } | null>(null);
  const pairingBusy = ref(false);

  const passwordInvalid = computed(() => failure.value !== null && PASSWORD_FAILURES.has(failure.value));

  async function createPairingCode(currentPassword: string): Promise<boolean> {
    const hadFailure = failure.value !== null;
    failure.value = null;
    // Champ vide : le serveur répondrait 400 (schéma) ; on le dit ici, sans requête (F-20261001-UX01). Seule la chaîne vide
    // est refusée : un mot de passe peut contenir des espaces, et un mot de passe fait d'espaces part au serveur, qui le
    // juge (403 `reauth_failed` s'il est faux).
    if (currentPassword === '') {
      // Un rendu sans message avant de le remettre : un role="alert" laissé en place n'est pas réannoncé par un lecteur
      // d'écran au second envoi à vide (le focus, lui, ne bouge pas : 06 § 3).
      if (hadFailure) await nextTick();
      failure.value = PASSWORD_REQUIRED;
      return false;
    }
    pairingBusy.value = true;
    const result: CallResult<Schemas['ExtensionPairingCode']> = await call(() =>
      getApi().POST('/api/extension/pairing-codes', { body: { currentPassword } }),
    );
    pairingBusy.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    pairing.value = { code: result.data.code, expiresAt: result.data.expiresAt };
    return true;
  }

  async function revokeDevice(id: string): Promise<boolean> {
    failure.value = null;
    const result = await call<undefined>(() => getApi().DELETE('/api/extension/devices/{id}', { params: { path: { id } } }));
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    await devices.reload();
    return true;
  }

  async function disconnectSite(id: string): Promise<boolean> {
    failure.value = null;
    const result = await call<undefined>(() => getApi().DELETE('/api/sites/{id}', { params: { path: { id } } }));
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    await sites.reload();
    return true;
  }

  return { devices, sites, failure, passwordInvalid, pairing, pairingBusy, createPairingCode, revokeDevice, disconnectSite, dismissPairing: () => (pairing.value = null) };
}
