import { expect, test } from 'vitest';
import { healthResponseSchema } from './index.js';

test('le schéma de santé exige status "ok"', () => {
  expect(healthResponseSchema.required).toEqual(['status']);
  expect(healthResponseSchema.properties.status.const).toBe('ok');
});
