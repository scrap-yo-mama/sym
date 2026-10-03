// SPDX-License-Identifier: AGPL-3.0-only
// Mode « agent instruit » d'une API (19 § 4, arbitrage n° 5, tâche 2.13) : confirmation HUMAINE des étapes instruites
// affichées (`POST /api/apis/{slug}/instructed-steps/confirm`, version et empreinte reçues de la fiche) et opt-in explicite
// (`PUT /api/apis/{slug}/instructed-mode`). La console ne décide d'aucun droit : l'état affiché est celui que le serveur
// renvoie. Un refus (409 `instructed_steps_unconfirmed`, `compilable`, `no_instructed_steps`) laisse le mode éteint.
import { ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import type { ApiDetail } from '@/composables/useApiDetail';
import { getApi } from '@/lib/api';
import { toRequestError, unwrap, type ApiRequestError } from '@/lib/api-result';

export function useInstructedMode(slug: MaybeRefOrGetter<string>, detail: MaybeRefOrGetter<ApiDetail>) {
  /** État affiché de l'interrupteur : celui de la fiche (faux par défaut), puis celui que renvoie le serveur. */
  const enabled = ref(toValue(detail).instructed_mode === true);
  const pending = ref<'confirm' | 'toggle' | null>(null);
  const error = ref<ApiRequestError | null>(null);
  watch(
    () => toValue(detail).instructed_mode,
    (value) => {
      enabled.value = value === true;
    },
  );

  async function guard(name: 'confirm' | 'toggle', action: () => Promise<ApiDetail>): Promise<ApiDetail | null> {
    pending.value = name;
    error.value = null;
    try {
      const updated = await action();
      enabled.value = updated.instructed_mode === true;
      return updated;
    } catch (cause) {
      error.value = toRequestError(cause);
      return null;
    } finally {
      pending.value = null;
    }
  }

  return {
    enabled,
    pending,
    error,
    /** Confirme les étapes affichées : `version` et `sha256` de la fiche, jamais recalculés par la console. */
    confirm: () =>
      guard('confirm', async () => {
        const instructed = toValue(detail).instructed;
        if (!instructed) throw toRequestError(null);
        return unwrap(
          await getApi().POST('/api/apis/{slug}/instructed-steps/confirm', {
            params: { path: { slug: toValue(slug) } },
            body: { version: instructed.version, sha256: instructed.sha256 },
          }),
        );
      }),
    /** Active ou désactive le mode. Refus du serveur : l'interrupteur reste (ou revient) éteint si l'activation est refusée. */
    setEnabled: async (on: boolean) => {
      const updated = await guard('toggle', async () => unwrap(await getApi().PUT('/api/apis/{slug}/instructed-mode', { params: { path: { slug: toValue(slug) } }, body: { enabled: on } })));
      if (updated === null && on) enabled.value = false;
      return updated;
    },
  };
}
