// SPDX-License-Identifier: AGPL-3.0-only
// Scopes des clés d'API (cdc/sym-browser 04 § 1, 03 § 5) : ensemble fermé, même liste que le CHECK de `api_keys` (0.2).
// Aucun scope n'en implique un autre : `admin` ne vaut pas `sessions:write`.

export const API_SCOPES = ['sessions:write', 'sessions:read', 'profiles:write', 'admin'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === 'string' && (API_SCOPES as readonly string[]).includes(value);
}

/** Liste de scopes non vide, sans doublon, dans l'ensemble fermé ; sinon une erreur qui nomme la valeur refusée. */
export function parseScopes(value: unknown): ApiScope[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('scopes : liste non vide attendue (sessions:write, sessions:read, profiles:write, admin).');
  const out: ApiScope[] = [];
  for (const item of value) {
    if (!isApiScope(item)) throw new Error(`scope inconnu : ${JSON.stringify(item)} (attendu : ${API_SCOPES.join(', ')}).`);
    if (out.includes(item)) throw new Error(`scope en double : ${item}.`);
    out.push(item);
  }
  return out;
}
