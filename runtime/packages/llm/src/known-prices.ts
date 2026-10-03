// SPDX-License-Identifier: AGPL-3.0-only
// Table VERSIONNÉE des prix connus (UX-11) : sert à pré-remplir, dans Réglages > Modèles IA, le prix d'un modèle reconnu par
// son nom ; l'utilisateur le modifie à volonté, et seul `settings.llm` (`providers[].models[m].price`) fait foi pour le worker.
// Prix en USD par million de jetons (même forme que `ModelPrice`, 08 § 1).
//
// Règle : un prix n'entre ici que s'il est DÉJÀ relevé dans le dépôt (la source est nommée). Un modèle dont aucun prix n'est
// relevé est « à valider » : pas de chiffre, jamais 0, jamais une valeur inventée. Pour ajouter un prix : l'entrée, sa source,
// puis incrémenter `KNOWN_PRICES_VERSION`.
import type { ModelPrice } from './usage.js';

export const KNOWN_PRICES_VERSION = 1;

export interface KnownModelPrice {
  /** Identifiant du modèle chez le fournisseur (comparé sans la casse). */
  model: string;
  /** Fournisseur du relevé (information : la recherche se fait par le seul nom du modèle). */
  provider: string;
  /** `verified` : prix relevé dans le dépôt ; `to_validate` : aucun prix relevé, à saisir par l'utilisateur. */
  status: 'verified' | 'to_validate';
  price: Pick<ModelPrice, 'in' | 'out' | 'in_cached'> | null;
  /** Où le prix est relevé dans le dépôt (chemin relatif à `runtime/`) ; pour un modèle à valider, ce qui manque. */
  source: string;
  /** Date du relevé (AAAA-MM-JJ) ; absente pour un modèle à valider. */
  as_of?: string;
}

export const KNOWN_PRICES: readonly KnownModelPrice[] = [
  { model: 'claude-opus-4-8', provider: 'anthropic', status: 'verified', price: { in: 5, out: 25, in_cached: 0.5 }, source: 'tests/agent/agent-live.security.test.ts (PROVIDERS.anthropic)', as_of: '2026-10-01' },
  { model: 'claude-opus-5-5', provider: 'anthropic', status: 'to_validate', price: null, source: 'aucun prix relevé dans le dépôt' },
  { model: 'claude-sonnet-5-5', provider: 'anthropic', status: 'to_validate', price: null, source: 'aucun prix relevé dans le dépôt' },
  { model: 'claude-haiku-4-5', provider: 'anthropic', status: 'to_validate', price: null, source: 'aucun prix relevé dans le dépôt' },
  { model: 'zai-org/GLM-5.3', provider: 'deepinfra', status: 'verified', price: { in: 0.9, out: 4, in_cached: 0.2 }, source: 'docs/adr/0001-agent-engine.md : prix CATALOGUE (champ pricing de deepinfra). Le prix affiché au 2026-10-01 (0,563 / 2,5 / 0,125, tests/agent/agent-live.security.test.ts) est remisé de 37,5 % temporairement : pré-remplir le catalogue ne sous-estime ni coût ni plafond une fois la remise finie', as_of: '2026-10-01' },
  { model: 'z-ai/glm-5.3-flash', provider: 'openrouter', status: 'verified', price: { in: 0.15, out: 0.5, in_cached: 0.04 }, source: 'tests/agent/agent-live.security.test.ts (PROVIDERS.openrouter)', as_of: '2026-10-01' },
];

/** Entrée de la table pour ce nom de modèle (casse et espaces de bord ignorés), ou null si le modèle n'est pas connu. */
export function knownPriceOf(model: string): KnownModelPrice | null {
  const wanted = model.trim().toLowerCase();
  return KNOWN_PRICES.find((entry) => entry.model.toLowerCase() === wanted) ?? null;
}
