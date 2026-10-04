// SPDX-License-Identifier: AGPL-3.0-only
// Appel d'API sans exception : une réponse d'erreur ou une coupure réseau deviennent un résultat typé, avec la clé i18n du
// message à afficher. Le serveur renvoie des codes stables (`{ error: { code } }`), jamais des phrases : la console les
// traduit (06 § 4.1). Un code inconnu retombe sur le message du statut HTTP. `invalid_input` : entrée d'un run hors
// `input_schema` (05 § 4.2) ; `invalid_request` : validation du schéma d'une requête de l'API de la console (corps ou paramètres).

export type CallResult<T> = { ok: true; data: T; status: number } | { ok: false; status: number; code: string | null; messageKey: string };

/** Codes d'erreur ayant leur propre message (`errors.<code>`) ; un 403 `reauth_failed` n'est pas un défaut de droit. */
const KNOWN_CODES = new Set([
  'invalid_input',
  'invalid_request',
  'queue_full',
  'account_site_ack_required',
  'not_found',
  'conflict',
  'rate_limited',
  'forbidden',
  'reauth_failed',
  'too_many_attempts',
  'too_many_pairing_codes',
  // Comptes (3.8) : ré-authentification, second facteur, invitations, utilisateurs, réglages d'instance.
  'reauth_required',
  'current_password_required',
  'mfa_code_required',
  'invalid_code',
  'mfa_enforced',
  'mfa_already_enabled',
  'mfa_not_enabled',
  'no_enrollment',
  'mfa_required',
  'mfa_enrollment_required',
  'weak_password',
  'no_local_password',
  'invitation_invalid',
  'invalid_email',
  'email_domain_not_allowed',
  'user_exists',
  'invitation_pending',
  'user_not_disabled',
  'user_not_active',
  'smtp_configured',
  'sso_required',
  'sso_disabled',
  'last_login_method',
  'invalid_settings',
  'invalid_instance_contact',
  'lifetime_too_long',
  'reset_link_invalid',
  'idp_unreachable',
  'invalid_status',
  'invalid_cursor',
  // UX-04 : contact du robot absent ou invalide, refus avant toute création (variante membre : useInvestigation).
  'instance_contact_missing',
]);

/** Code stable d'une erreur `{ error: { code } }`, sinon null. */
export function errorCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const inner = body.error;
  return typeof inner === 'object' && inner !== null && 'code' in inner && typeof inner.code === 'string' ? inner.code : null;
}

function messageKeyFor(status: number, code: string | null): string {
  if (code && KNOWN_CODES.has(code)) return `errors.${code}`;
  if (status === 401) return 'errors.unauthorized';
  if (status === 403) return 'errors.forbidden';
  if (status === 404) return 'errors.not_found';
  if (status === 409) return 'errors.conflict';
  if (status === 429) return 'errors.rate_limited';
  return status >= 500 ? 'errors.server' : 'errors.generic';
}

/** Exécute un appel openapi-fetch ; ne lève jamais. `data` vaut `undefined` pour une réponse sans corps (204). */
export async function call<T>(run: () => Promise<{ data?: T; error?: unknown; response: Response }>): Promise<CallResult<T>> {
  try {
    const { data, error, response } = await run();
    if (response.ok) return { ok: true, data: data as T, status: response.status };
    const code = errorCodeOf(error);
    return { ok: false, status: response.status, code, messageKey: messageKeyFor(response.status, code) };
  } catch {
    return { ok: false, status: 0, code: null, messageKey: 'errors.network' };
  }
}
