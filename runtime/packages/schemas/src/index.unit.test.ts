// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { healthResponseSchema } from './index.js';

test('le schéma de santé exige status "ok" et la version de l’application', () => {
  expect(healthResponseSchema.required).toEqual(['status', 'version']);
  expect(healthResponseSchema.properties.version).toEqual({ type: 'string', maxLength: 64 });
  expect(healthResponseSchema.properties.status.const).toBe('ok');
});
