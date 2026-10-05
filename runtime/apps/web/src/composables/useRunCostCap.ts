// SPDX-License-Identifier: AGPL-3.0-only
// Coût max par run d'une API (D-123) : facultatif, vide par défaut (aucun plafond par run ; le budget du jour du compte
// reste la limite). `PATCH /api/apis/{slug}` avec `max_cost_usd` : un nombre fixe le plafond, `null` le retire. La console
// ne décide d'aucun plafond d'instance : le serveur répond 400 `cost_cap_exceeded` au-delà de `MAX_COST_USD_PER_RUN`.
import { ref, toValue, type MaybeRefOrGetter } from 'vue';
import type { ApiDetail } from '@/composables/useApiDetail';
import { getApi } from '@/lib/api';
import { toRequestError, unwrap, type ApiRequestError } from '@/lib/api-result';

/** Saisie du champ : vide → `null` (aucun plafond) ; montant ≥ 0 (point ou virgule décimale) → nombre ; sinon `invalid`. */
export function parseCostCap(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+(?:[.,]\d+)?$/.test(trimmed)) return 'invalid';
  const value = Number(trimmed.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : 'invalid';
}

export function useRunCostCap(slug: MaybeRefOrGetter<string>) {
  const pending = ref(false);
  const invalid = ref(false);
  const error = ref<ApiRequestError | null>(null);

  /** Enregistre la saisie ; renvoie la fiche à jour, ou null (saisie refusée localement, ou refus du serveur). */
  async function save(text: string): Promise<ApiDetail | null> {
    const value = parseCostCap(text);
    invalid.value = value === 'invalid';
    error.value = null;
    if (value === 'invalid') return null;
    pending.value = true;
    try {
      return unwrap(await getApi().PATCH('/api/apis/{slug}', { params: { path: { slug: toValue(slug) } }, body: { max_cost_usd: value } }));
    } catch (cause) {
      error.value = toRequestError(cause);
      return null;
    } finally {
      pending.value = false;
    }
  }

  return { pending, invalid, error, save };
}
