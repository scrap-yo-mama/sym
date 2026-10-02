// SPDX-License-Identifier: AGPL-3.0-only
// Réglages d'instance réservés à l'owner (13 § 7, § 13.1) : sécurité (durées de session, domaines, plafond de clés, rétention
// de l'audit) et SSO OIDC. Le secret du client OIDC est en écriture seule : la console ne le relit jamais (le serveur ne le
// renvoie pas, INV8), le champ est vidé dès l'envoi et seul « secret enregistré » est affiché.
import type { components } from '@runtime/client';
import { reactive, ref } from 'vue';
import { useResource } from '@/composables/useResource';
import { call } from '@/lib/api-call';
import { getApi } from '@/lib/api';

type Schemas = components['schemas'];
export type SecuritySettings = Schemas['SecuritySettings'];

/** Une ligne par domaine, espaces et casse ignorés, sans doublon. */
export function parseDomains(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

export function useSecuritySettings() {
  const resource = useResource<SecuritySettings>(() => call(() => getApi().GET('/api/settings/security')));
  const form = reactive({ idle: 0, absolute: 0, domains: '', keyMax: 0, retention: '' as number | '' });
  const saving = ref(false);
  const saved = ref(false);
  const failure = ref<string | null>(null);

  function adopt(settings: SecuritySettings): void {
    form.idle = settings.session_idle_minutes;
    form.absolute = settings.session_absolute_hours;
    form.domains = settings.allowed_email_domains.join('\n');
    form.keyMax = settings.api_key_max_lifetime_days;
    form.retention = settings.audit_retention_months ?? '';
  }

  async function load(): Promise<void> {
    if (await resource.reload()) adopt(resource.data.value as SecuritySettings);
  }

  async function save(): Promise<boolean> {
    saving.value = true;
    saved.value = false;
    failure.value = null;
    const body: SecuritySettings = {
      session_idle_minutes: Number(form.idle),
      session_absolute_hours: Number(form.absolute),
      allowed_email_domains: parseDomains(form.domains),
      api_key_max_lifetime_days: Number(form.keyMax),
    };
    if (form.retention !== '') body.audit_retention_months = Number(form.retention);
    const result = await call(() => getApi().PUT('/api/settings/security', { body }));
    saving.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    resource.data.value = result.data;
    adopt(result.data);
    saved.value = true;
    return true;
  }

  return { ...resource, form, saving, saved, failure, load, save };
}

type SsoRole = 'member' | 'admin';
type GroupRole = { group: string; role: SsoRole };

export function useSsoSettings() {
  const resource = useResource<Schemas['SsoSettings'] | null>(() => call(() => getApi().GET('/api/settings/sso')));
  const form = reactive({
    enabled: false,
    label: '',
    slug: '',
    issuer: '',
    clientId: '',
    /** Seul endroit où un secret vit, le temps de la saisie. */
    clientSecret: '',
    required: false,
    jit: false,
    jitDomains: '',
    groups: [] as GroupRole[],
  });
  const secretSet = ref(false);
  const configured = ref(false);
  const saving = ref(false);
  const saved = ref(false);
  const failure = ref<string | null>(null);

  function adopt(settings: Schemas['SsoSettings'] | null): void {
    configured.value = settings !== null;
    secretSet.value = settings?.client_secret_set === true;
    form.enabled = settings?.enabled === true;
    form.label = settings?.label ?? '';
    form.slug = settings?.slug ?? '';
    form.issuer = settings?.issuer_url ?? '';
    form.clientId = settings?.client_id ?? '';
    form.clientSecret = '';
    form.required = settings?.sso_required === true;
    form.jit = settings?.jit_provisioning?.enabled === true;
    form.jitDomains = (settings?.jit_provisioning?.domains ?? []).join('\n');
    form.groups = (settings?.group_roles ?? []).map((entry) => ({ group: entry.group, role: entry.role }));
  }

  async function load(): Promise<void> {
    if (await resource.reload()) adopt(resource.data.value ?? null);
  }

  const addGroup = (): void => void form.groups.push({ group: '', role: 'member' });
  const removeGroup = (index: number): void => void form.groups.splice(index, 1);

  async function save(): Promise<boolean> {
    saving.value = true;
    saved.value = false;
    failure.value = null;
    const body: Schemas['SsoSettingsWrite'] = {
      enabled: form.enabled,
      slug: form.slug.trim(),
      issuer_url: form.issuer.trim(),
      client_id: form.clientId.trim(),
      label: form.label.trim(),
      sso_required: form.required,
      jit_provisioning: { enabled: form.jit, domains: parseDomains(form.jitDomains) },
      group_roles: form.groups.filter((entry) => entry.group.trim() !== '').map((entry) => ({ group: entry.group.trim(), role: entry.role })),
    };
    if (form.clientSecret !== '') body.client_secret = form.clientSecret;
    form.clientSecret = ''; // vidé dès l'envoi : le secret ne reste pas en mémoire d'écran
    const result = await call(() => getApi().PUT('/api/settings/sso', { body }));
    saving.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    resource.data.value = result.data;
    adopt(result.data);
    saved.value = true;
    return true;
  }

  return { ...resource, form, secretSet, configured, saving, saved, failure, load, addGroup, removeGroup, save };
}

/**
 * Identité du robot (admin ou owner, 17 §5) : interrupteur `identify_instance` et contact d'instance sont modifiables ; le
 * User-Agent réel du moteur est en lecture seule (le serveur ne l'accepte jamais en écriture). `null` pour l'interrupteur :
 * jamais posé, le worker retombe sur la variable d'environnement puis sur « désactivé ».
 */
export type IdentitySettings = Schemas['IdentitySettings'];

/**
 * État de l'interrupteur à afficher : le réglage s'il est posé, sinon ce que le worker applique (son IDENTIFY_INSTANCE), sinon
 * désactivé. C'est aussi la référence de l'enregistrement : seul un écart à cette valeur est écrit.
 */
function appliedIdentify(settings: IdentitySettings): boolean {
  return settings.identify_instance ?? settings.identify_effective ?? false;
}

export function useIdentitySettings() {
  const resource = useResource<IdentitySettings>(() => call(() => getApi().GET('/api/settings/identity')));
  const form = reactive({ identify: false, contact: '' });
  const saving = ref(false);
  const saved = ref(false);
  const failure = ref<string | null>(null);

  function adopt(settings: IdentitySettings): void {
    form.identify = appliedIdentify(settings);
    form.contact = settings.instance_contact ?? '';
  }

  async function load(): Promise<void> {
    if (await resource.reload()) adopt(resource.data.value as IdentitySettings);
  }

  async function save(): Promise<boolean> {
    saving.value = true;
    saved.value = false;
    failure.value = null;
    const current = resource.data.value;
    const body: Schemas['IdentitySettingsWrite'] = {};
    // Interrupteur renvoyé seulement s'il diffère de la valeur affichée : un réglage jamais posé reste null, et la variable
    // IDENTIFY_INSTANCE du worker continue de s'appliquer (un simple changement de contact ne la neutralise pas).
    if (current === null || current === undefined || form.identify !== appliedIdentify(current)) body.identify_instance = form.identify;
    const contact = form.contact.trim();
    // Contact vidé = réglage effacé (null) ; inchangé = non renvoyé (le serveur ne le réécrit pas).
    if (contact !== (current?.instance_contact ?? '')) body.instance_contact = contact === '' ? null : contact;
    if (Object.keys(body).length === 0) {
      // Rien de modifié : aucune écriture (ni audit) ; l'état affiché est déjà celui du serveur.
      saving.value = false;
      saved.value = true;
      return true;
    }
    const result = await call(() => getApi().PUT('/api/settings/identity', { body }));
    saving.value = false;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    resource.data.value = result.data;
    adopt(result.data);
    saved.value = true;
    return true;
  }

  // `failure` : échec de l'enregistrement ; l'échec de chargement garde son propre nom (le spread le masquerait).
  return { ...resource, loadFailure: resource.failure, form, saving, saved, failure, load, save };
}
