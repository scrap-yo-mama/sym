// SPDX-License-Identifier: AGPL-3.0-only
// Chargement d'une ressource REST avec ses trois états (06 § 2 : chargement, erreur avec relance, vide) et le bouton
// **Tester** des réglages, dont le résultat est lisible (« non testé » tant qu'il ne l'a pas été).
import { readonly, ref, shallowRef } from 'vue';
import type { CallResult } from '@/lib/api-call';

export function useResource<T>(loader: () => Promise<CallResult<T>>) {
  const data = shallowRef<T | null>(null);
  const loading = ref(false);
  /** Clé i18n de l'erreur de chargement, sinon null. */
  const failure = ref<string | null>(null);
  /** Vrai quand le serveur refuse (403) : l'écran explique qu'il faut être admin plutôt que d'afficher une panne. */
  const forbidden = ref(false);
  let sequence = 0;

  async function reload(): Promise<boolean> {
    const mine = ++sequence;
    loading.value = true;
    failure.value = null;
    forbidden.value = false;
    const result = await loader();
    if (mine !== sequence) return false;
    loading.value = false;
    if (!result.ok) {
      forbidden.value = result.status === 403;
      failure.value = result.messageKey;
      return false;
    }
    data.value = result.data;
    return true;
  }

  return { data, loading: readonly(loading), failure: readonly(failure), forbidden: readonly(forbidden), reload };
}

/** Résultat affiché d'un bouton **Tester**. */
export type TestOutcome =
  | { state: 'running' }
  | { state: 'done'; ok: boolean; testedAt: string | null; reason: { code: string; params: Record<string, string | number> } | null; detail: Record<string, string | null> }
  | { state: 'failed'; messageKey: string };

/** Suit les tests en cours et leurs résultats, par clé (identifiant du proxy, du fournisseur, de l'abonnement…). */
export function useTester() {
  const outcomes = ref<Record<string, TestOutcome>>({});

  async function run(
    key: string,
    runTest: () => Promise<CallResult<{ ok: boolean; tested_at: string; error?: { code: string; params: Record<string, string | number> } | null } & Record<string, unknown>>>,
    detailKeys: string[] = [],
  ): Promise<void> {
    outcomes.value = { ...outcomes.value, [key]: { state: 'running' } };
    const result = await runTest();
    if (!result.ok) {
      outcomes.value = { ...outcomes.value, [key]: { state: 'failed', messageKey: result.messageKey } };
      return;
    }
    const detail: Record<string, string | null> = {};
    for (const name of detailKeys) {
      const value = result.data[name];
      detail[name] = typeof value === 'string' ? value : null;
    }
    outcomes.value = {
      ...outcomes.value,
      [key]: { state: 'done', ok: result.data.ok, testedAt: result.data.tested_at ?? null, reason: result.data.error ?? null, detail },
    };
  }

  return { outcomes, run };
}
