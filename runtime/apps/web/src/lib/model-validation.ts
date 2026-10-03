// SPDX-License-Identifier: AGPL-3.0-only
// Statut « modèle validé » (15 § 11) affiché en lecture seule dans Réglages > Modèles IA : la liste vient du serveur
// (copie de eval/validated-models.json). Un modèle absent, ou une liste absente, signifie « jamais mesuré » : non validé.
import type { components } from '@runtime/client';

export type ValidatedModel = components['schemas']['ValidatedModel'];

export function modelValidation(list: readonly ValidatedModel[] | undefined, modelId: string): { status: 'validated' | 'not_validated'; date: string | null } {
  const entry = (list ?? []).filter((m) => m.model_id === modelId).sort((a, b) => b.date.localeCompare(a.date))[0];
  return entry === undefined ? { status: 'not_validated', date: null } : { status: entry.status, date: entry.date };
}
