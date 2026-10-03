// SPDX-License-Identifier: AGPL-3.0-only
// Santé du catalogue (20 § 5.2, u3 R15 et R16) : comptes par statut, barre de santé, pastilles-filtres. Aucune logique métier
// (06 § 4.1) : la machine à états vit dans `packages/core` ; ici on ne fait que compter les statuts reçus. Une API `bloquee`
// est un arrêt volontaire (INV6), pas une panne : elle est affichée À PART et n'entre jamais dans le dénominateur de la
// santé (`assert_catalog_health_excludes_blocked`). « À traiter » regroupe ce qu'un humain peut avoir à regarder.
import { API_STATUSES, type ApiStatus } from '@/lib/status';

export type StatusCounts = Record<ApiStatus, number>;

/** Statuts qui demandent l'attention de l'utilisateur : à surveiller, en erreur, action requise. */
export const ATTENTION_STATUSES = ['warning', 'erreur', 'action_requise'] as const satisfies readonly ApiStatus[];

/** Segments de la barre de santé, dans l'ordre d'affichage : tout sauf `bloquee`, qui est à part. */
const HEALTH_SEGMENTS: readonly ApiStatus[] = ['sain', 'warning', 'enquete', 'reparation', 'erreur', 'action_requise'];

export const PILLS = ['all', 'attention', 'healthy', 'stopped'] as const;
export type PillId = (typeof PILLS)[number];
export type PillCounts = Record<PillId, number>;

function emptyCounts(): StatusCounts {
  return Object.fromEntries(API_STATUSES.map((status) => [status, 0])) as StatusCounts;
}

export function countByStatus(apis: readonly { status: ApiStatus }[]): StatusCounts {
  const counts = emptyCounts();
  for (const api of apis) if (api.status in counts) counts[api.status] += 1;
  return counts;
}

export interface CatalogHealth {
  /** Toutes les API, arrêts volontaires compris. */
  total: number;
  /** API en service : le dénominateur de la santé, SANS les API bloquées. */
  inService: number;
  /** API saines (`sain` seulement : « à surveiller » n'est pas « saine »). */
  healthy: number;
  /** Arrêts volontaires (`bloquee`), affichés à part. */
  stopped: number;
  /** API qui demandent l'attention de l'utilisateur. */
  attention: number;
  /** Segments de la barre : un par statut non nul, `bloquee` exclu. */
  segments: { status: ApiStatus; count: number }[];
}

export function catalogHealth(counts: StatusCounts): CatalogHealth {
  const total = API_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  const stopped = counts.bloquee;
  return {
    total,
    inService: total - stopped,
    healthy: counts.sain,
    stopped,
    attention: ATTENTION_STATUSES.reduce((sum, status) => sum + counts[status], 0),
    segments: HEALTH_SEGMENTS.filter((status) => counts[status] > 0).map((status) => ({ status, count: counts[status] })),
  };
}

export function pillCounts(counts: StatusCounts): PillCounts {
  const health = catalogHealth(counts);
  return { all: health.total, attention: health.attention, healthy: health.healthy, stopped: health.stopped };
}

/** Pastille active pour l'état des filtres, ou nulle (statut précis choisi dans la liste, par exemple « En réparation »). */
export function activePill(filters: { status: ApiStatus | ''; attention: boolean }): PillId | null {
  if (filters.attention) return 'attention';
  if (filters.status === '') return 'all';
  if (filters.status === 'sain') return 'healthy';
  if (filters.status === 'bloquee') return 'stopped';
  return null;
}

/** Pastilles dont le compteur a changé entre deux lectures : c'est ce que la région `status` annonce. */
export function countChanges(before: PillCounts | null, after: PillCounts): { pill: PillId; count: number }[] {
  if (!before) return [];
  return PILLS.filter((pill) => before[pill] !== after[pill]).map((pill) => ({ pill, count: after[pill] }));
}
