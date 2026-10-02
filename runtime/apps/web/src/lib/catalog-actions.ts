// SPDX-License-Identifier: AGPL-3.0-only
// Action utile d'une ligne du catalogue (20 § 5.2) : une seule, ou aucune. « Voir les alternatives » pour une API `bloquee`
// (ouvre le panneau « Bloquée » de la fiche) ; pour une `action_requise`, le même verbe que le bandeau de la fiche
// (`actionRequired.<cause>.button`, même destination) ; rien de plus sur une ligne saine. AUCUNE relance et AUCUN tunnel après
// un blocage (A7, X3) : une API bloquée n'offre que les alternatives, jamais un réglage réseau ni un bouton de reprise.
import type { RouteLocationRaw } from 'vue-router';
import { actionCause } from '@/lib/action-required';
import type { ApiStatus } from '@/lib/status';

export interface RowAction {
  /** Clé i18n du libellé. */
  labelKey: string;
  to: RouteLocationRaw;
  /** `alternatives` : panneau « Bloquée » ; `task` : tâche d'une action requise. */
  kind: 'alternatives' | 'task';
}

/** Ancre du panneau « Bloquée » de la fiche (`components/api/BlockedPanel.vue`). */
const BLOCKED_PANEL_ANCHOR = 'blocked-panel';

export function rowAction(api: { slug: string; status: ApiStatus; status_reason?: { code: string } | null }): RowAction | null {
  const fiche = `/apis/${encodeURIComponent(api.slug)}`;
  if (api.status === 'bloquee') return { kind: 'alternatives', labelKey: 'catalog.rowAction.alternatives', to: { path: fiche, hash: `#${BLOCKED_PANEL_ANCHOR}` } };
  if (api.status !== 'action_requise') return null;
  const cause = actionCause(api.status_reason?.code);
  // Même verbe et même destination que le bandeau de la fiche ; une cause sans écran de la console (vérification affichée,
  // paiement, limite de compte) mène à la fiche, où le bandeau dit le détail : la ligne ne propose jamais de relance.
  if (cause?.primary?.kind === 'route') return { kind: 'task', labelKey: `actionRequired.${cause.cause}.button`, to: cause.primary.to };
  return { kind: 'task', labelKey: 'catalog.rowAction.openTask', to: fiche };
}
