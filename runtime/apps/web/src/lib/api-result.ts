// SPDX-License-Identifier: AGPL-3.0-only
// Résultat d'un appel du client généré (openapi-fetch) ramené à « une valeur ou une erreur typée » : les composables
// de la console travaillent avec des promesses, les écrans affichent le code stable de l'erreur (jamais une phrase du
// serveur, 06 § 4.1).

/** Erreur d'un appel REST : statut HTTP et code stable `{ error: { code } }` du serveur (null si absent). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(code ?? `HTTP ${status}`);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const inner = body.error;
  return typeof inner === 'object' && inner !== null && 'code' in inner && typeof inner.code === 'string' ? inner.code : null;
}

type CallResult<T> = { data?: T; error?: unknown; response: Response };

/** Valeur d'une réponse réussie ; lève `ApiRequestError` sinon. Une réponse sans corps (204) renvoie `undefined`. */
export function unwrap<T>(result: CallResult<T>): T {
  if (!result.response.ok) throw new ApiRequestError(result.response.status, errorCode(result.error));
  return result.data as T;
}

/** Erreur quelconque (réseau coupé, exception) ramenée à `ApiRequestError` ; le statut 0 signifie « pas de réponse ». */
export function toRequestError(cause: unknown): ApiRequestError {
  return cause instanceof ApiRequestError ? cause : new ApiRequestError(0, null);
}
