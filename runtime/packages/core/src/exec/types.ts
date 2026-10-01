// SPDX-License-Identifier: AGPL-3.0-only
// Contrats communs des exécuteurs E1-E3 (tâche 1.6, 04 §3.1) : un échange HTTP, un transport, un échec classé.
import type { RenderedRequest } from '../dsl/template.js';
import type { FailureClass } from '../model/enums.js';

/** Réponse vue par l'interpréteur : statut, en-têtes (noms en minuscules), corps décodé, URL finale. */
export type HttpExchange = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly url: string;
};

/**
 * Transport d'un exécuteur : E1 = couche réseau (garde SSRF, barreau N1-N3), E2 = `fetch` injecté dans la page,
 * E3 = navigation Chromium (DOM rendu). Le transport ne classe rien : il rend l'échange ou lève une erreur.
 */
export type Transport = (request: RenderedRequest, signal: AbortSignal) => Promise<HttpExchange>;

/** Échec d'un essai : classe fermée (04b §1), réessai possible, code stable (jamais une valeur de la cible). */
export type ExecFailure = {
  readonly failure_class: FailureClass;
  readonly retryable: boolean;
  readonly detail: string;
  readonly status?: number;
};

/** Cadence (1.9) vue par l'interpréteur : une réservation avant chaque requête, un compte rendu après. */
export type RequestPacer = {
  acquire(url: string): Promise<{ readonly granted: true } | { readonly granted: false; readonly reason: string; readonly retryAt: Date }>;
  report(url: string, response: { readonly status: number; readonly retryAfter: string | null }): Promise<void>;
};
