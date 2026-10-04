// SPDX-License-Identifier: AGPL-3.0-only
// Dossier d'enquête d'une API (tâche 2.14, 19c § 7) : faits du code par indice (état, raison, coût, version du dossier) et
// version du dossier lue par chaque version de stratégie. Propriétaire seulement : sur une API partagée d'un autre membre,
// le serveur répond 404, lu ici comme « aucun dossier ». Aucun texte du dossier n'arrive dans la console par cette route.
import type { components } from '@runtime/client';
import { ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { getApi } from '@/lib/api';
import { toRequestError, unwrap, type ApiRequestError } from '@/lib/api-result';

export type ApiBriefView = components['schemas']['ApiBriefView'];

export function useApiBrief(slug: MaybeRefOrGetter<string>) {
  const brief = ref<ApiBriefView | null>(null);
  const loading = ref(false);
  const error = ref<ApiRequestError | null>(null);
  async function refetch(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      brief.value = unwrap(await getApi().GET('/api/apis/{slug}/brief', { params: { path: { slug: toValue(slug) } } }));
    } catch (cause) {
      const failure = toRequestError(cause);
      brief.value = null;
      // 404 uniforme : API d'un autre membre (ou sans propriétaire visible) : rien à montrer, pas une erreur.
      if (failure.status !== 404) error.value = failure;
    } finally {
      loading.value = false;
    }
  }
  watch(() => toValue(slug), () => void refetch(), { immediate: true });
  return { brief, loading, error, refetch };
}
