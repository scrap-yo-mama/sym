// SPDX-License-Identifier: AGPL-3.0-only
// Refus d'accès décidé AVANT toute connexion (module d'accès, tâche 1.11, INV11) : robots.txt interdit le chemin, ou
// robots.txt est injoignable (on s'abstient). Levé par le contrôle d'URL de `guardedFetch` (`checkUrl`), à chaque saut
// de redirection : aucun octet ne part vers un chemin interdit. Classé par `classifyTransportError` sur sa propre classe.
export type AccessRefusalClass = 'robots_disallowed' | 'robots_unreachable' | 'rate_limited' | 'forbidden';

export class AccessRefusedError extends Error {
  readonly failureClass: AccessRefusalClass;
  readonly retryable: boolean;
  /** Code stable (jamais une valeur de la cible). */
  readonly detail: string;
  constructor(failure: { readonly failure_class: AccessRefusalClass; readonly retryable: boolean; readonly detail: string }) {
    super(`accès refusé avant connexion : ${failure.failure_class} (${failure.detail})`);
    this.name = 'AccessRefusedError';
    this.failureClass = failure.failure_class;
    this.retryable = failure.retryable;
    this.detail = failure.detail;
  }
}

/** `AccessRefusedError` dans la chaîne des causes (undici enveloppe les erreurs), sinon `undefined`. */
export function findAccessRefused(error: unknown): AccessRefusedError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof AccessRefusedError) return current;
    current = current.cause;
  }
  return undefined;
}
