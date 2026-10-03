// SPDX-License-Identifier: AGPL-3.0-only
// Chargement d'une ressource d'écran (tâche 3.6) : états chargement, erreur (code stable du contrat, traduit par l'écran)
// et données. Le premier chargement part dès la création du composant ; le rendu serveur (tests) l'attend.
import { onServerPrefetch, ref, type Ref } from 'vue';
import type { ApiResult } from '../api/client.js';

export type Loaded<T> = {
  data: Ref<T | undefined>;
  error: Ref<string | null>;
  loading: Ref<boolean>;
  reload(): Promise<void>;
};

export function useLoad<T>(loader: () => Promise<ApiResult<T>>): Loaded<T> {
  const data = ref<T>() as Ref<T | undefined>;
  const error = ref<string | null>(null);
  const loading = ref(true);
  let sequence = 0;
  async function reload(): Promise<void> {
    const mine = ++sequence;
    loading.value = true;
    const result = await loader();
    // Une réponse plus ancienne qu'un rechargement ultérieur est ignorée (filtres changés entre-temps).
    if (mine !== sequence) return;
    if (result.ok) {
      data.value = result.data;
      error.value = null;
    } else error.value = result.code;
    loading.value = false;
  }
  const first = reload();
  onServerPrefetch(() => first);
  return { data, error, loading, reload };
}
