// SPDX-License-Identifier: AGPL-3.0-only
// Réglages BYO (06 § 2, 08 § 7) : modèles IA, proxys, alertes (SMTP, webhooks), extension et sessions. Les secrets sont en
// écriture seule : la console ne les relit jamais (le serveur ne les renvoie pas, INV8) et vide le champ dès l'envoi. Les droits
// sont ceux du serveur : un 403 devient un message, jamais une décision locale (06 § 4.1).
import type { components } from '@runtime/client';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { call, type CallResult } from '@/lib/api-call';
import { getApi } from '@/lib/api';
import { useResource, useTester } from '@/composables/useResource';

type Schemas = components['schemas'];
export type LlmSettings = Schemas['LlmSettings'];
export type LlmRoleName = 'investigate' | 'repair' | 'extract' | 'agent';
export const LLM_ROLES: readonly LlmRoleName[] = ['investigate', 'repair', 'extract', 'agent'];
export type LlmPreset = Schemas['LlmPreset'];
export const LLM_PRESETS: readonly LlmPreset[] = ['zai', 'openrouter', 'vllm', 'ollama', 'deepseek', 'qwen', 'openai', 'custom'];

/** Champs d'un prix de modèle (USD par million de jetons) : entrée, sortie, entrée mise en cache (facultative). */
export type PriceField = 'in' | 'out' | 'in_cached';
/** Saisie brute d'un prix (texte des champs) : le serveur ne reçoit un nombre qu'après validation à l'enregistrement. */
type PriceInputs = Record<PriceField, string>;
export type KnownModelPrice = Schemas['KnownModelPrice'];

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
  /** Saisie des prix par modèle (UX-11) : une entrée par modèle utilisé, pré-remplie par le prix enregistré ou, à défaut, le prix connu. */
  priceInputs: Record<string, PriceInputs>;
}

const text = (n: number | undefined): string => (n === undefined ? '' : String(n));
/** Nombre saisi (virgule ou point) ; null si illisible ou négatif. */
function parsePrice(raw: string): number | null {
  const value = Number(raw.trim().replace(',', '.'));
  return raw.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function useLlmSettings() {
  const resource = useResource<LlmSettings>(() => call(() => getApi().GET('/api/settings/llm')));
  const providers = ref<ProviderDraft[]>([]);
  const roles = reactive<Partial<Record<LlmRoleName, { provider: string; model: string }>>>({});
  /** Statut du banc (lecture seule, 15 § 11) : jamais renvoyé au serveur. */
  const validatedModels = ref<Schemas['ValidatedModel'][]>([]);
  /** Prix connus du serveur (table versionnée de @runtime/llm, lecture seule) : pré-remplissent le prix d'un modèle reconnu. */
  const knownPrices = ref<KnownModelPrice[]>([]);
  const saving = ref(false);
  const saveFailure = ref<string | null>(null);
  const saved = ref(false);
  const tester = useTester();
  let loaded: LlmSettings | null = null;

  function adopt(settings: LlmSettings): void {
    loaded = settings;
    validatedModels.value = settings.validated_models ?? [];
    knownPrices.value = settings.known_prices ?? [];
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
      priceInputs: {},
    }));
    for (const name of LLM_ROLES) {
      const role = settings.roles?.[name];
      if (role) roles[name] = { provider: role.provider, model: role.model };
      else delete roles[name];
    }
    syncPriceRows();
  }

  /** Prix connu (avec chiffres) d'un modèle reconnu par son nom, ou null. */
  function knownPrice(model: string): KnownModelPrice | null {
    const wanted = model.trim().toLowerCase();
    return knownPrices.value.find((entry) => entry.model.toLowerCase() === wanted) ?? null;
  }

  /** Modèles utilisés d'un fournisseur : ceux des rôles qui le choisissent, puis ceux déjà déclarés dans ses réglages. */
  function modelRows(provider: ProviderDraft): string[] {
    const id = provider.id.trim();
    const names: string[] = [];
    if (id !== '') for (const name of LLM_ROLES) if (roles[name]?.provider === id && roles[name]!.model.trim() !== '') names.push(roles[name]!.model.trim());
    names.push(...Object.keys(provider.models ?? {}));
    return [...new Set(names)];
  }

  /** Crée la saisie d'un modèle utilisé qui n'en a pas : prix enregistré, sinon prix connu, sinon champs vides (jamais 0). */
  function syncPriceRows(): void {
    for (const provider of providers.value) {
      for (const model of modelRows(provider)) {
        if (provider.priceInputs[model] !== undefined) continue;
        const saved = provider.models?.[model]?.price;
        const known = saved ? null : knownPrice(model)?.price ?? null;
        const source = saved ?? known;
        provider.priceInputs[model] = { in: text(source?.in), out: text(source?.out), in_cached: text(source?.in_cached) };
      }
    }
  }

  function setModelPrice(providerIndex: number, model: string, field: PriceField, raw: string): void {
    const provider = providers.value[providerIndex];
    if (!provider) return;
    syncPriceRows();
    const inputs = provider.priceInputs[model] ?? { in: '', out: '', in_cached: '' };
    provider.priceInputs[model] = { ...inputs, [field]: raw };
  }

  /** Un modèle de rôle sans prix complet : le worker refuserait de l'appeler (`llm_price_missing`). */
  function priceMissing(roleName: LlmRoleName): boolean {
    const choice = roles[roleName];
    const provider = choice ? providers.value.find((p) => p.id.trim() === choice.provider) : undefined;
    const model = choice?.model.trim() ?? '';
    if (!choice || !provider || model === '') return false;
    const inputs = provider.priceInputs[model];
    return !inputs || parsePrice(inputs.in) === null || parsePrice(inputs.out) === null;
  }

  /** Tester a abouti pour un rôle dont le modèle n'a pas de prix : le résultat doit le dire (UX-11), le worker ne l'appellerait pas. */
  function testPriceWarning(roleName: LlmRoleName): boolean {
    return tester.outcomes.value[roleName]?.state === 'done' && priceMissing(roleName);
  }

  watch([providers, roles], syncPriceRows, { deep: true });

  async function load(): Promise<void> {
    if (await resource.reload()) adopt(resource.data.value as LlmSettings);
  }

  function addProvider(): void {
    providers.value = [...providers.value, { id: '', preset: 'custom', base_url: '', apiKeySet: false, apiKeyUnreadable: false, newApiKey: '', priceInputs: {} }];
  }

  function removeProvider(index: number): void {
    providers.value = providers.value.filter((_, at) => at !== index);
  }

  /** Modèles du fournisseur avec les prix saisis (profil, `extra_body` et autres champs du prix conservés) ; null si aucun. */
  function modelsOf(provider: ProviderDraft): Schemas['LlmProviderBase']['models'] | undefined {
    const models: NonNullable<Schemas['LlmProviderBase']['models']> = { ...(provider.models ?? {}) };
    for (const [model, inputs] of Object.entries(provider.priceInputs)) {
      if (!(model in models) && inputs.in.trim() === '' && inputs.out.trim() === '') continue;
      const { price: previous, ...rest } = models[model] ?? {};
      if (inputs.in.trim() === '' && inputs.out.trim() === '') {
        // Retrait explicite (UX-17) : le serveur fusionne `models[m]` et ne retire un prix que s'il reçoit `price: null`.
        if (previous) models[model] = { ...rest, price: null };
        continue;
      }
      const price: NonNullable<Schemas['LlmModel']['price']> = { ...(previous ?? {}), in: parsePrice(inputs.in)!, out: parsePrice(inputs.out)! };
      const cached = parsePrice(inputs.in_cached);
      if (cached === null) delete price.in_cached;
      else price.in_cached = cached;
      models[model] = { ...rest, price };
    }
    return Object.keys(models).length > 0 || provider.models ? models : undefined;
  }

  /** Clé de message du premier prix saisi illisible ou incomplet, ou null : un prix partiel n'est jamais envoyé. */
  function priceProblem(): string | null {
    for (const provider of providers.value) {
      for (const inputs of Object.values(provider.priceInputs)) {
        const filled = (['in', 'out', 'in_cached'] as const).filter((field) => inputs[field].trim() !== '');
        if (filled.some((field) => parsePrice(inputs[field]) === null)) return 'settings.models.price.invalid';
        if (filled.length > 0 && (inputs.in.trim() === '' || inputs.out.trim() === '')) return 'settings.models.price.incomplete';
      }
    }
    return null;
  }

  /** Corps du PUT : une clé n'est envoyée que si elle vient d'être saisie, sinon l'ancienne est conservée côté serveur. */
  function payload(): Schemas['LlmSettingsWrite'] {
    const body: Schemas['LlmSettingsWrite'] = {
      providers: providers.value.map((provider) => {
        const entry: Schemas['LlmProviderWrite'] = { id: provider.id.trim(), preset: provider.preset, base_url: provider.base_url.trim() };
        if (provider.timeout_ms !== undefined) entry.timeout_ms = provider.timeout_ms;
        if (provider.max_retries !== undefined) entry.max_retries = provider.max_retries;
        const models = modelsOf(provider);
        if (models) entry.models = models;
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
    syncPriceRows();
    const problem = priceProblem();
    if (problem !== null) {
      saveFailure.value = problem;
      saved.value = false;
      return false;
    }
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

  return { ...resource, providers, roles, validatedModels, knownPrices, saving, saveFailure, saved, outcomes: tester.outcomes, load, addProvider, removeProvider, save, test, modelRows, knownPrice, setModelPrice, priceMissing, testPriceWarning };
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
