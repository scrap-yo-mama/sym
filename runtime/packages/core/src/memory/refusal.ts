// SPDX-License-Identifier: AGPL-3.0-only
// Mémoire négative : un refus est un arrêt (tâche 2.12, 19 §2, r1 R14). Lue par le code AVANT tout appel LLM et toute
// requête : `robots_disallowed` → arrêt sans requête ; `forbidden` ou `bloquee` → arrêt préventif, statut `bloquee` par
// la transition 4, raison `prior_refusal`. Seule une ré-enquête MANUELLE (transition 18, raison `reinvestigate_manual`)
// autorise un essai de confirmation au couple le moins cher, sans changement de réseau ; un refus observé relève alors
// du classifieur (04 §7).

export type PriorRefusal = { readonly domain: string; readonly at: string; readonly class: 'robots_disallowed' | 'forbidden' | 'bloquee' };

export type PriorRefusalDecision =
  | { readonly action: 'proceed' }
  | { readonly action: 'stop'; readonly reason: 'robots_disallowed' | 'prior_refusal'; readonly refusal: PriorRefusal }
  | { readonly action: 'confirm_once'; readonly refusal: PriorRefusal };

/** `statusReason` : raison du statut de l'API au départ de l'enquête (`reinvestigate_manual` après la transition 18). */
export function priorRefusalDecision(refusals: readonly PriorRefusal[], domain: string, statusReason: string | null): PriorRefusalDecision {
  const mine = refusals.filter((r) => r.domain === domain);
  if (mine.length === 0) return { action: 'proceed' };
  const refusal = [...mine].sort((a, b) => b.at.localeCompare(a.at))[0]!;
  if (statusReason === 'reinvestigate_manual') return { action: 'confirm_once', refusal };
  return { action: 'stop', reason: mine.some((r) => r.class === 'robots_disallowed') ? 'robots_disallowed' : 'prior_refusal', refusal };
}
