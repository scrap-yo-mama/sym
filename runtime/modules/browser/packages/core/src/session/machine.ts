// SPDX-License-Identifier: AGPL-3.0-only
// Machine à états des sessions (cdc/sym-browser 04 § 5, tâche 1.2) : source unique de la table des transitions, partagée
// par la passerelle, le nœud et la persistance (packages/db). Toute écriture d'état passe par `checkTransition` ; la base
// garde en plus ses CHECK de cohérence (0001_schema), mais seule cette table dit d'où vers où une session peut aller.
import type { EndReason, SessionState } from '@sym/contracts/browser';

export type { EndReason, SessionState } from '@sym/contracts/browser';

export type SessionTransition = { readonly from: SessionState; readonly to: SessionState; readonly reason: EndReason | null };

/**
 * Table de 04 § 5. Ajout de 04b § 6 : les sessions `pending` d'un nœud déclaré mort passent aussi `failed` raison
 * `node_lost` (le diagramme de 04 § 5 ne montre que `running`).
 */
export const SESSION_TRANSITIONS: readonly SessionTransition[] = Object.freeze([
  { from: 'pending', to: 'running', reason: null },
  { from: 'pending', to: 'failed', reason: 'crash' },
  { from: 'pending', to: 'failed', reason: 'quota' },
  { from: 'pending', to: 'failed', reason: 'node_lost' },
  { from: 'running', to: 'ended', reason: 'released' },
  { from: 'running', to: 'ended', reason: 'budget_exceeded' },
  { from: 'running', to: 'ended', reason: 'node_shutdown' },
  { from: 'running', to: 'ended', reason: 'quota' },
  { from: 'running', to: 'timed_out', reason: 'timeout' },
  { from: 'running', to: 'timed_out', reason: 'idle' },
  { from: 'running', to: 'failed', reason: 'crash' },
  { from: 'running', to: 'failed', reason: 'node_lost' },
] as const);

const TERMINAL: ReadonlySet<SessionState> = new Set(['ended', 'timed_out', 'failed']);

export function isTerminal(state: SessionState): boolean {
  return TERMINAL.has(state);
}

export type TransitionCheck = { ok: true } | { ok: false; code: 'invalid_transition' };

export function checkTransition(from: SessionState, to: SessionState, reason: EndReason | null): TransitionCheck {
  return SESSION_TRANSITIONS.some((t) => t.from === from && t.to === to && t.reason === reason) ? { ok: true } : { ok: false, code: 'invalid_transition' };
}

/** États depuis lesquels `to` (avec `reason`) est permis : la garde des écritures conditionnelles en base. */
export function sourcesFor(to: SessionState, reason: EndReason | null): SessionState[] {
  return SESSION_TRANSITIONS.filter((t) => t.to === to && t.reason === reason).map((t) => t.from);
}

/** État final d'une fin de raison `reason` depuis `from` (ex. `quota` : `ended` en cours, `failed` en file). */
export function endStateFor(from: SessionState, reason: EndReason): SessionState | undefined {
  return SESSION_TRANSITIONS.find((t) => t.from === from && t.reason === reason)?.to;
}

/**
 * Nouvelle fin au plus tard après `POST /v1/sessions/{id}/extend` (04 § 3) : `seconds` ajoutées, plafonnées par la durée
 * maximale du client depuis la création ; jamais en arrière. Dates en millisecondes.
 */
export function extendedExpiry(input: { createdAt: number; expiresAt: number; seconds: number; maxDurationSeconds: number }): number {
  if (!Number.isInteger(input.seconds) || input.seconds <= 0) throw new RangeError(`seconds : entier positif attendu (reçu ${input.seconds})`);
  const ceiling = input.createdAt + input.maxDurationSeconds * 1000;
  return Math.max(input.expiresAt, Math.min(input.expiresAt + input.seconds * 1000, ceiling));
}
