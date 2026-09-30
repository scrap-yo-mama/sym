import { expect, test } from 'vitest';
import { assertNever, PACKAGE_NAME } from './index.js';

test('core expose son nom et assertNever lève', () => {
  expect(PACKAGE_NAME).toBe('@runtime/core');
  expect(() => assertNever('x' as never)).toThrow('Valeur inattendue');
});
