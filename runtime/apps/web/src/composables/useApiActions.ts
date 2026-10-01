// SPDX-License-Identifier: AGPL-3.0-only
// Actions de la fiche (06 § 2) : Lancer (run, avec le choix de version pour Relancer), Ré-enquêter (manuel, transitions 17
// et 18), Revenir à une version, Modifier la sortie (déclenche une ré-enquête, après confirmation). Chaque action garde
// son état d'attente et son erreur en code stable ; la console ne décide jamais d'un droit (le serveur répond 403 ou 409).
import { ref, toValue, type MaybeRefOrGetter } from 'vue';
import { getApi } from '@/lib/api';
import { toRequestError, unwrap, type ApiRequestError } from '@/lib/api-result';

export function useApiActions(slug: MaybeRefOrGetter<string>) {
  const pending = ref<'launch' | 'reinvestigate' | 'revert' | 'schema' | null>(null);
  const error = ref<ApiRequestError | null>(null);

  async function guard<T>(name: NonNullable<typeof pending.value>, action: () => Promise<T>): Promise<T | null> {
    pending.value = name;
    error.value = null;
    try {
      return await action();
    } catch (cause) {
      error.value = toRequestError(cause);
      return null;
    } finally {
      pending.value = null;
    }
  }

  return {
    pending,
    error,
    clearError: () => (error.value = null),
    /** Lance un run sans attendre (`wait=0`) : l'écran suit l'avancement par le flux et le détail du run. Renvoie l'identifiant du run. */
    launch: (input: Record<string, unknown>, strategyVersion?: number) =>
      guard('launch', async () => {
        const accepted = unwrap(
          await getApi().POST('/api/apis/{slug}/runs', {
            params: { path: { slug: toValue(slug) }, query: { wait: 0 } },
            body: { input, ...(strategyVersion ? { strategy_version: strategyVersion } : {}) },
          }),
        );
        return accepted.run_id;
      }),
    /** Ré-enquête manuelle : seule reprise offerte à une API bloquée. */
    reinvestigate: () =>
      guard('reinvestigate', async () => {
        const accepted = unwrap(await getApi().POST('/api/apis/{slug}/investigate', { params: { path: { slug: toValue(slug) } }, body: {} }));
        return accepted.run_id;
      }),
    /** Revient à une version : l'API passe en `warning`, raison `reverted`. Renvoie la fiche à jour. */
    revert: (version: number) => guard('revert', async () => unwrap(await getApi().POST('/api/apis/{slug}/versions/{version}/revert', { params: { path: { slug: toValue(slug), version } } }))),
    /** Modifie le schéma de sortie : le serveur déclenche une ré-enquête. Renvoie la fiche à jour. */
    updateOutputSchema: (outputSchema: Record<string, unknown>) =>
      guard('schema', async () => unwrap(await getApi().PATCH('/api/apis/{slug}', { params: { path: { slug: toValue(slug) } }, body: { output_schema: outputSchema } }))),
  };
}
