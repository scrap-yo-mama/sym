// SPDX-License-Identifier: AGPL-3.0-only
// Portes de promotion d'une reprise par étape (19 §4, r2 06, tâche 2.13) et détecteurs de faux succès SANS LLM.
// V0 classification (aucun refus), V1 `post` respectée, V2 identité de l'élément (rôle et nom : unique, sinon
// `intent_changed`), V3 schéma et champs stables, V4 fraîcheur, V5 étape recompilée rejouée seule sans LLM N fois.
// vN+1 ne devient courante que si TOUTES passent ; si seule V5 échoue, les données du run sont livrées (V0 à V4) et vN+1
// est archivée non courante (`repair_not_validated`, transition 12). `post` est évaluée par l'hôte sur ses observations,
// jamais par un modèle.
import type { FailureClass } from '../model/enums.js';
import { STEP_REPAIR_DEFAULTS, type StepPost } from './spec.js';

/** Observation bornée de la page par l'hôte (avant et après une étape). */
export type PageObservation = {
  readonly url: string;
  /** Éléments sémantiques visibles (rôle + nom accessible), bornés. */
  readonly elements: readonly { readonly role: string; readonly name: string }[];
  /** Texte visible borné. */
  readonly text: string;
  /** Empreinte du contenu (texte et éléments). */
  readonly digest: string;
  /** Epoch ms de la dernière réponse du document. */
  readonly fetchedAt: number;
};

export type Identity = 'ok' | 'missing' | 'ambiguous';

export function checkElementIdentity(target: { readonly role: string; readonly name: string }, elements: readonly { readonly role: string; readonly name: string }[]): Identity {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const n = elements.filter((e) => e.role === target.role && norm(e.name) === norm(target.name)).length;
  return n === 0 ? 'missing' : n === 1 ? 'ok' : 'ambiguous';
}

/** `post` d'une étape sur les observations avant / après ; `failed` : indice de la première condition non tenue. */
export function checkPost(post: readonly StepPost[], before: PageObservation, after: PageObservation): { ok: true } | { ok: false; failed: number } {
  for (const [i, p] of post.entries()) {
    let ok: boolean;
    switch (p.kind) {
      case 'url_changed':
        ok = after.url !== before.url;
        break;
      case 'url_contains':
        ok = after.url.includes(p.value);
        break;
      case 'text_present':
        ok = after.text.includes(p.value);
        break;
      case 'element_present':
        ok = checkElementIdentity(p, after.elements) !== 'missing';
        break;
      case 'element_absent':
        ok = checkElementIdentity(p, after.elements) === 'missing';
        break;
    }
    if (!ok) return { ok: false, failed: i };
  }
  return { ok: true };
}

export type FalseSuccess = 'no_effect' | 'pagination_stalled' | 'stale';

/**
 * Faux succès d'une étape, sans LLM : une action qui ne change rien (même URL, même contenu), une pagination qui revient
 * sur une page déjà vue, une réponse plus ancienne que le run (`fetched_at`, cache). Le défilement et l'attente peuvent
 * ne rien changer.
 */
export function detectFalseSuccess(args: {
  readonly op: string;
  readonly before: PageObservation;
  readonly after: PageObservation;
  readonly runStartedAt: number;
  readonly pagination?: boolean;
  readonly previousPageDigest?: string;
}): FalseSuccess | null {
  const { op, before, after } = args;
  if (op === 'click' || op === 'goto' || op === 'select') {
    if (after.fetchedAt < args.runStartedAt) return 'stale';
    if (after.url === before.url && after.digest === before.digest) return 'no_effect';
    if (args.pagination === true && args.previousPageDigest !== undefined && after.digest === args.previousPageDigest) return 'pagination_stalled';
  }
  return null;
}

export type GateInput = {
  /** V0 : classe retenue par la garde sur le rejeu (`null` : aucun refus). */
  readonly classification: FailureClass | null;
  readonly post: boolean;
  readonly identity: Identity;
  readonly schema: boolean;
  readonly freshness: boolean;
  /** V5 : issue de chaque rejeu sans LLM de la candidate. */
  readonly llmFreeReplays: readonly boolean[];
};

export type GateDecision = 'promote' | 'deliver_not_validated' | 'intent_changed' | 'reject';

export function evaluateGates(input: GateInput, options: { replaysRequired?: number } = {}): { gates: Record<'V0' | 'V1' | 'V2' | 'V3' | 'V4' | 'V5', boolean>; decision: GateDecision } {
  const n = options.replaysRequired ?? STEP_REPAIR_DEFAULTS.llmFreeReplays;
  const gates = {
    V0: input.classification === null,
    V1: input.post,
    V2: input.identity === 'ok',
    V3: input.schema,
    V4: input.freshness,
    V5: input.llmFreeReplays.length >= n && input.llmFreeReplays.slice(0, n).every(Boolean),
  };
  let decision: GateDecision;
  if (!gates.V0 || !gates.V1 || !gates.V3 || !gates.V4) decision = 'reject';
  else if (!gates.V2) decision = 'intent_changed';
  else decision = gates.V5 ? 'promote' : 'deliver_not_validated';
  return { gates, decision };
}
