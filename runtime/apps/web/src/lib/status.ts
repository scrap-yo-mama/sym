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

/** Teinte du badge (classes Tailwind, clair et sombre) : une aide visuelle de plus, jamais la seule. */
export const STATUS_TONE: Record<ApiStatus, string> = {
  enquete: 'border-sky-700 text-sky-800 dark:border-sky-400 dark:text-sky-300',
  sain: 'border-emerald-700 text-emerald-800 dark:border-emerald-400 dark:text-emerald-300',
  warning: 'border-amber-700 text-amber-800 dark:border-amber-400 dark:text-amber-300',
  reparation: 'border-violet-700 text-violet-800 dark:border-violet-400 dark:text-violet-300',
  erreur: 'border-red-700 text-red-800 dark:border-red-400 dark:text-red-300',
  action_requise: 'border-orange-700 text-orange-800 dark:border-orange-400 dark:text-orange-300',
  bloquee: 'border-zinc-700 text-zinc-800 dark:border-zinc-400 dark:text-zinc-300',
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
