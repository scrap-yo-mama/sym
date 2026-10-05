// SPDX-License-Identifier: AGPL-3.0-only
// Porte « promotion » (tâche 3.14, 19 §6, décision Q4 et Q12) : un acte HUMAIN, pas un rappel d'outil. Le code, une
// planification ou un agent interne ne promeuvent jamais. Fonction pure : la route lui donne le contexte (canal, élicitation).
import type { SchemaChangeLevel } from './schema-version.js';

export const PROMOTION_GATES = ['major_in_console', 'all_in_console'] as const;
export type PromotionGate = (typeof PROMOTION_GATES)[number];

/** Résultat de l'élicitation de promotion : acceptée par la personne, refusée, ou non disponible (client sans élicitation). */
export type Elicitation = 'accepted' | 'declined' | 'unavailable';

export type PromotionContext = {
  /** `ui` : session de console (acte humain direct) ; `key` : clé d'API (MCP ou REST). */
  readonly via: 'ui' | 'key';
  /** Niveau du changement de schéma du brouillon, ou du retour vers une autre version de schéma. */
  readonly level: SchemaChangeLevel;
  readonly gate: PromotionGate;
  /** Élicitation du canal MCP, honorée seulement pour une clé passée par le serveur MCP (jamais lue d'un client REST). */
  readonly elicitation: Elicitation;
  readonly acknowledgeBreaking: boolean;
};

export type PromotionDecision =
  | { readonly ok: true; readonly human: 'console' | 'elicitation' | 'explicit_owner_call' }
  | { readonly ok: false; readonly status: 400 | 403 | 409; readonly code: 'human_confirmation_required' | 'breaking_change_requires_ack' | 'promotion_declined' };

export function decidePromotion(ctx: PromotionContext): PromotionDecision {
  // Élicitation refusée : aucune promotion, quel que soit le reste.
  if (ctx.elicitation === 'declined') return { ok: false, status: 403, code: 'promotion_declined' };
  if (ctx.via === 'ui') {
    if (ctx.level === 'major' && !ctx.acknowledgeBreaking) return { ok: false, status: 409, code: 'breaking_change_requires_ack' };
    return { ok: true, human: 'console' };
  }
  // Clé d'API. `all_in_console` : jamais par une clé, élicitation comprise.
  if (ctx.gate === 'all_in_console') return { ok: false, status: 403, code: 'human_confirmation_required' };
  if (ctx.elicitation === 'accepted') return { ok: true, human: 'elicitation' };
  // Sans élicitation : minor et patch par un appel explicite du propriétaire ; major (ou changement de schéma) en console seulement,
  // et rejouer l'appel avec `acknowledge_breaking` n'y change rien.
  if (ctx.level === 'major') return { ok: false, status: 403, code: 'human_confirmation_required' };
  return { ok: true, human: 'explicit_owner_call' };
}
