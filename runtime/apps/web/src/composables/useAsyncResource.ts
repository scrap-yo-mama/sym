// SPDX-License-Identifier: AGPL-3.0-only
// Base des composables de données de la console : `{ data, loading, error, refetch }` (modèle `use{Entity}`), un seul
// appel utile à la fois (le dernier lancé gagne, une réponse en retard est ignorée). `silent` relit sans repasser par
// l'état de chargement : l'écran garde ses données pendant un rafraîchissement (catalogue toutes les 15 s, SSE).
import { tryOnMounted } from '@vueuse/core';
import { readonly, ref, shallowRef, type Ref } from 'vue';
import { toRequestError, type ApiRequestError } from '@/lib/api-result';

export type AsyncResource<T> = {
  data: Readonly<Ref<T | null>>;
  loading: Readonly<Ref<boolean>>;
  error: Readonly<Ref<ApiRequestError | null>>;
  /** Relit la ressource ; `silent` garde `loading` à faux et ne vide pas l'erreur affichée avant la réponse. */
  refetch: (options?: { silent?: boolean }) => Promise<void>;
  /** Remplace la valeur courante (réponse d'une action qui renvoie la ressource à jour). */
  set: (value: T | null) => void;
};

export function useAsyncResource<T>(load: () => Promise<T>, options: { immediate?: boolean } = {}): AsyncResource<T> {
  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  const error = shallowRef<ApiRequestError | null>(null);
  let ticket = 0;

  async function refetch({ silent = false }: { silent?: boolean } = {}): Promise<void> {
    const mine = ++ticket;
    if (!silent) {
      loading.value = true;
      error.value = null;
    }
    try {
      const value = await load();
      if (mine !== ticket) return;
      data.value = value;
      error.value = null;
    } catch (cause) {
      if (mine === ticket) error.value = toRequestError(cause);
    } finally {
      if (mine === ticket) loading.value = false;
    }
  }

  if (options.immediate !== false) tryOnMounted(() => void refetch());
  return { data: readonly(data) as Readonly<Ref<T | null>>, loading: readonly(loading), error: readonly(error) as Readonly<Ref<ApiRequestError | null>>, refetch, set: (value) => (data.value = value) };
}
