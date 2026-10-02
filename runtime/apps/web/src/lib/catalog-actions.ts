// SPDX-License-Identifier: AGPL-3.0-only
// Action utile d'une ligne du catalogue (20 § 5.2) : une seule, ou aucune. « Voir les alternatives » pour une API `bloquee`
// (ouvre le panneau « Bloquée » de la fiche) ; pour une `action_requise`, le bouton du bandeau de la fiche
// (`components/api/ActionRequiredBanner.vue`) : même libellé `actionRequired.<cause>.button`, même destination (écran de la
// console, ancre de la fiche ou site de l'éditeur) ; rien de plus sur une ligne saine. AUCUNE relance et AUCUN tunnel après
// un blocage (A7, X3) : une API bloquée n'offre que les alternatives, jamais un réglage réseau ni un bouton de reprise.
import type { RouteLocationRaw } from 'vue-router';
import { actionCause, actionTitleParams, publisherSiteUrl } from '@/lib/action-required';
import type { ApiStatus } from '@/lib/status';

export interface RowAction {
  /** Clé i18n du libellé. */
  labelKey: string;
  /** Destination dans la console. */
  to: RouteLocationRaw;
  /** Lien sortant (site de l'éditeur, cause « paiement ») : ouvert dans un nouvel onglet, jamais appelé par le serveur. */
  href?: string;
  /** `alternatives` : panneau « Bloquée » ; `task` : tâche d'une action requise. */
  kind: 'alternatives' | 'task';
}

/** Ancre du panneau « Bloquée » de la fiche (`components/api/BlockedPanel.vue`). */
const BLOCKED_PANEL_ANCHOR = 'blocked-panel';

type RowApi = {
  slug: string;
  status: ApiStatus;
  status_reason?: { code: string; params?: Readonly<Record<string, unknown>> | null } | null;
  requires?: { session_domain?: string | null } | null;
};

export function rowAction(api: RowApi): RowAction | null {
  const fiche = `/apis/${encodeURIComponent(api.slug)}`;
  if (api.status === 'bloquee') return { kind: 'alternatives', labelKey: 'catalog.rowAction.alternatives', to: { path: fiche, hash: `#${BLOCKED_PANEL_ANCHOR}` } };
  if (api.status !== 'action_requise') return null;
  const cause = actionCause(api.status_reason?.code);
  const primary = cause?.primary ?? null;
  if (cause !== null && primary !== null) {
    const labelKey = `actionRequired.${cause.cause}.button`;
    if (primary.kind === 'route') return { kind: 'task', labelKey, to: primary.to };
    // Bouton du bandeau sur la fiche elle-même (vérification affichée : nouvelle action de l'utilisateur, jamais automatique).
    if (primary.kind === 'hash') return { kind: 'task', labelKey, to: { path: fiche, hash: primary.hash } };
    const site = publisherSiteUrl(actionTitleParams(api.status_reason?.params, api.requires?.session_domain, '').domain);
    if (site !== null) return { kind: 'task', labelKey, to: fiche, href: site };
  }
  // Le bandeau de la fiche n'a aucun bouton (limite de compte, paiement sans site connu) : il n'y a pas de verbe à reprendre,
  // la ligne mène à la fiche, où le bandeau dit la tâche. Jamais de relance.
  return { kind: 'task', labelKey: 'catalog.rowAction.openTask', to: fiche };
}
