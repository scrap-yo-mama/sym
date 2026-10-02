// SPDX-License-Identifier: MIT
// Erreurs typées (cdc/sym-browser 04 § 6). `what_to_do` : phrase d'action en français ou en anglais selon `Accept-Language`.

export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'session_not_found',
  'profile_locked',
  'session_id_taken',
  'idempotency_conflict',
  'invalid_option',
  'playwright_version_mismatch',
  'quota_exceeded',
  'capacity_exceeded',
  'proxy_unreachable',
  'no_node',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

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
