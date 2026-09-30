// SPDX-License-Identifier: MIT
// JSON Schema publics : API, stratégie, export (MIT). Squelette tâche 0.1.
export const PACKAGE_NAME = '@runtime/schemas';

export const healthResponseSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { status: { const: 'ok' } },
  required: ['status'],
  additionalProperties: false,
} as const;
