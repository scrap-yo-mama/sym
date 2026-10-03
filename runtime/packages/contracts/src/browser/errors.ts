// SPDX-License-Identifier: MIT
// Erreurs typées (cdc/sym-browser 04 § 6). `what_to_do` : phrase d'action en français ou en anglais selon `Accept-Language`.

export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'session_not_found',
  'profile_locked',
  'session_id_taken',
  'idempotency_conflict',
  'protocol_not_served',
  'invalid_option',
  'playwright_version_mismatch',
  'quota_exceeded',
  'capacity_exceeded',
  'proxy_unreachable',
  'no_node',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Statut HTTP de chaque code (04 § 6). `protocol_not_served` : WebSocket CDP demandée sur une session `shared` (04f § 2). */
export const ERROR_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  session_not_found: 404,
  profile_locked: 409,
  session_id_taken: 409,
  idempotency_conflict: 409,
  protocol_not_served: 409,
  invalid_option: 422,
  playwright_version_mismatch: 428,
  quota_exceeded: 429,
  capacity_exceeded: 429,
  proxy_unreachable: 502,
  no_node: 503,
} as const satisfies Record<ErrorCode, number>;

export type ApiError = {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    what_to_do: string;
    requestId: string;
    details?: Record<string, unknown> | { field: string; reason: string }[];
  };
};
