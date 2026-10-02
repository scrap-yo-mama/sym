// SPDX-License-Identifier: AGPL-3.0-only
// Statuts d'une API pour l'affichage (06 § 2 « Statut et raison »). La machine à états (INV3) vit dans `packages/core` :
// la console ne fait que présenter le statut reçu. Un statut n'est jamais porté par la couleur seule (WCAG 1.4.1) :
// chaque statut a une icône de forme distincte, un libellé et une raison en texte.
import type { components } from '@runtime/client';

export type ApiStatus = components['schemas']['ApiStatus'];

/** Ordre d'affichage des filtres : du plus actif au plus définitif. */
export const API_STATUSES: readonly ApiStatus[] = ['enquete', 'sain', 'warning', 'reparation', 'erreur', 'action_requise', 'bloquee'];

export type StatusIcon = 'hourglass' | 'check-circle' | 'triangle' | 'wrench' | 'octagon-x' | 'diamond-exclamation' | 'circle-slash';

/** Forme de l'icône de chaque statut (sablier, coche dans un cercle, triangle, clé, croix dans un octogone, point d'exclamation dans un losange, cercle barré). */
export const STATUS_ICON: Record<ApiStatus, StatusIcon> = {
  enquete: 'hourglass',
  sain: 'check-circle',
  warning: 'triangle',
  reparation: 'wrench',
  erreur: 'octagon-x',
  action_requise: 'diamond-exclamation',
  bloquee: 'circle-slash',
};

/**
 * Teinte du badge (classes Tailwind sur les jetons de packages/ui, qui changent avec le thème) : surface pleine et texte de
 * la famille du statut (20 § 1.2), bordure `status-border` ; une aide visuelle de plus, jamais la seule (forme d'icône,
 * libellé et raison). L’orange (`erreur`) n’est qu’une surface à texte anthracite. `sain`, `warning` et `reparation` prennent les
 * badges doux de la planche Catalogue (variante `-badge`, D-60, `assert_catalog_status_colors_match_planche`).
 */
export const STATUS_TONE: Record<ApiStatus, string> = {
  enquete: 'border-status-border bg-status-enquete text-status-enquete-foreground',
  sain: 'border-status-border bg-status-sain-badge text-status-sain-badge-foreground',
  warning: 'border-status-border bg-status-warning-badge text-status-warning-badge-foreground',
  reparation: 'border-status-border bg-status-reparation-badge text-status-reparation-badge-foreground',
  erreur: 'border-status-border bg-status-erreur text-status-erreur-foreground',
  action_requise: 'border-status-border bg-status-action-requise text-status-action-requise-foreground',
  bloquee: 'border-status-border bg-status-bloquee text-status-bloquee-foreground',
};

/**
 * `stale` est un drapeau, pas un statut : la pastille « Données anciennes » s'ajoute au badge d'une API `sain` ou
 * `warning` quand le contrôle de fraîcheur l'a levé (04 § 6). Aucun autre statut ne l'affiche.
 */
export function showsStaleFlag(status: ApiStatus, stale: boolean): boolean {
  return stale && (status === 'sain' || status === 'warning');
}


/** Niveaux d'exécution E1 à E6, du moins cher au plus cher (04 § 3.1), et modes réseau : valeurs des filtres du catalogue. */
export const EXECUTIONS = ['fetch', 'fetch_in_page', 'playwright', 'agent_fetch', 'hybrid', 'agent'] as const;
export const NETWORKS = ['direct', 'dc_proxy', 'res_proxy', 'tunnel'] as const;
