// SPDX-License-Identifier: AGPL-3.0-only
// Écran Catalogue (20 § 5.2) : le tableau (pagination serveur, filtres) et la vue d'ensemble (santé, pastilles), lus ensemble.
// À l'ouverture, la vue d'ensemble est lue d'abord : si des API sont « à traiter », le tableau s'ouvre sur cette pastille
// (u3 R16), sauf si l'utilisateur a déjà touché à un filtre ; sinon le tableau est lu tel quel. Suivi suspendu : les deux se taisent.
import { tryOnMounted } from '@vueuse/core';
import { ref } from 'vue';
import { useApiCatalog } from '@/composables/useApiCatalog';
import { useCatalogOverview } from '@/composables/useCatalogOverview';

export function useCatalogScreen(options: { pollMs?: number; searchDebounceMs?: number } = {}) {
  const catalog = useApiCatalog({ ...options, immediate: false });
  const overview = useCatalogOverview({ ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }), immediate: false, suspended: () => catalog.suspended.value });
  /** Vrai une fois la première lecture de la vue d'ensemble revenue (réussie ou non) et le tableau lancé : jusque-là, l'écran est en chargement (rendu côté serveur ou de test : aucune lecture en attente). */
  const opened = ref(import.meta.env.SSR === true);

  tryOnMounted(async () => {
    await overview.refetch();
    if (!catalog.touched.value && (overview.health.value?.attention ?? 0) > 0) catalog.setPill('attention', { user: false });
    else void catalog.refetch();
    opened.value = true;
  });

  return { catalog, overview, opened };
}
