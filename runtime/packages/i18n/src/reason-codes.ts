// SPDX-License-Identifier: AGPL-3.0-only
// Codes de la table de 06 § 4.2 (le drapeau `stale` compris), dans l'ordre de la table : liste figée, source de
// `reasons.<code>` et `reasonLabel.<code>` (`assert_reason_codes_stable`). Un code ajouté ou retiré se voit dans la revue.
// D-91 (2026-10-03) : sans robots_disallowed ni robots_unreachable ; même liste que apps/web/src/testing/spec-reason-codes.json.
export const SPEC_REASON_CODES = [
  'retried', 'escalated', 'repaired', 'optional_fields_missing', 'volume_anomaly', 'pagination_short', 'slow', 'cost_anomaly',
  'stale', 'unavailable', 'reverted', 'reinvestigation_failed', 'rate_limited', 'geo_restriction', 'blocked_by_protection',
  'forbidden', 'payment_required', 'auth_required', 'cookie_expired', 'session_device_bound', 'challenge_in_tunnel',
  'secret_unreadable', 'instance_contact_missing', 'llm_price_missing', 'account_limit', 'session_owner_required', 'llm_refused',
] as const;
