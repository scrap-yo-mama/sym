// SPDX-License-Identifier: AGPL-3.0-only
// Fusion de `settings.llm.providers[].models` (UX-17). Le prix d'un modèle (`price`, USD par million de jetons) est ce qui
// permet au worker de l'appeler : une écriture qui ne le mentionne pas ne l'efface jamais. Une requête change une clé d'un
// modèle en la nommant ; `null` la retire explicitement ; un modèle absent de la requête est gardé tel quel.

export type StoredModels = Record<string, Record<string, unknown>>;

/** `old` fusionné avec `incoming`, modèle par modèle puis clé par clé (`profile`, `price`, `extra_body`). Ne modifie aucun argument. */
export function mergeModels(old: StoredModels | undefined, incoming: Record<string, Record<string, unknown>> | undefined): StoredModels {
  const merged: StoredModels = Object.fromEntries(Object.entries(old ?? {}).map(([id, model]) => [id, { ...model }]));
  for (const [id, change] of Object.entries(incoming ?? {})) {
    const next: Record<string, unknown> = { ...(merged[id] ?? {}), ...change };
    for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
    merged[id] = next;
  }
  return merged;
}
