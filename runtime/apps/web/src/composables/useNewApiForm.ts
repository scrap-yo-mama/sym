// SPDX-License-Identifier: AGPL-3.0-only
// Formulaire « Nouvelle API » (06 § 2) : description, URL, exemple de sortie facultatif, politique réseau. Les règles de
// saisie sont celles de l'OpenAPI (longueurs, URL http(s), pays à 2 lettres) ; le serveur valide à son tour (INV1, INV12).
// Avertissement A11 : si le site demande un compte (déclaré ici, ou signalé par le serveur), il doit être confirmé avant
// la création (`assert_account_site_warning`). Le tunnel est un réglage neutre de la politique réseau, jamais proposé
// après un blocage (A7).
import type { components } from '@runtime/client';
import { computed, reactive, ref } from 'vue';
import type { ApiCreateBody } from '@/composables/useInvestigation';

type Network = components['schemas']['Network'];

export interface NewApiFields {
  description: string;
  url: string;
  /** Exemple de sortie, JSON saisi à la main (vide : aucun). */
  example: string;
  direct: boolean;
  dcProxy: boolean;
  resProxy: boolean;
  /** Pays du proxy résidentiel, 2 lettres. */
  country: string;
  tunnel: boolean;
  /** L'utilisateur déclare que le site demande un compte. */
  accountDeclared: boolean;
  /** L'avertissement A11 a été confirmé. */
  accountConfirmed: boolean;
}

export type FieldErrors = Partial<Record<'description' | 'url' | 'example' | 'network' | 'country' | 'account', true>>;

export function useNewApiForm() {
  const form = reactive<NewApiFields>({
    description: '',
    url: '',
    example: '',
    direct: true,
    dcProxy: false,
    resProxy: false,
    country: '',
    tunnel: false,
    accountDeclared: false,
    accountConfirmed: false,
  });
  const errors = ref<FieldErrors>({});
  /** Le serveur a répondu `account_site_ack_required` : l'avertissement s'affiche même si rien n'a été déclaré. */
  const serverAsksAck = ref(false);
  const accountWarningShown = computed(() => form.accountDeclared || serverAsksAck.value);

  /** Corps de la requête si la saisie est valide, sinon `null` (les erreurs sont posées sur `errors`). */
  function build(): ApiCreateBody | null {
    const next: FieldErrors = {};
    const description = form.description.trim();
    if (description === '' || description.length > 2000) next.description = true;

    let url = form.url.trim();
    try {
      const parsed = new URL(url);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || url.length > 2048) next.url = true;
    } catch {
      next.url = true;
    }
    url = form.url.trim();

    let example: unknown;
    if (form.example.trim() !== '') {
      try {
        example = JSON.parse(form.example);
        if (typeof example !== 'object' || example === null) next.example = true;
      } catch {
        next.example = true;
      }
    }

    const allow: Network[] = [];
    if (form.direct) allow.push('direct');
    if (form.dcProxy) allow.push('dc_proxy');
    if (form.resProxy) allow.push('res_proxy');
    if (form.tunnel) allow.push('tunnel');
    if (allow.length === 0) next.network = true;
    const country = form.country.trim().toLowerCase();
    if (form.resProxy && country !== '' && !/^[a-z]{2}$/.test(country)) next.country = true;

    if (accountWarningShown.value && !form.accountConfirmed) next.account = true;

    errors.value = next;
    if (Object.keys(next).length > 0) return null;

    // La console garde la porte du schéma (Q2 du CDC UX : le serveur valide désormais par défaut) jusqu'à la tâche U2.4.
    const body: ApiCreateBody = { description, url, network_policy: { allow }, auto_validate: false };
    if (example !== undefined) body.example_output = example;
    if (form.resProxy && country !== '') body.network_policy = { allow, res_proxy_params: { country } };
    if (accountWarningShown.value) body.account_site_acknowledged = true;
    return body;
  }

  return { form, errors, serverAsksAck, accountWarningShown, build };
}
