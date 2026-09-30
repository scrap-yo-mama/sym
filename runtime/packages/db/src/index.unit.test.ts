import { expect, test } from 'vitest';
import { databaseName } from './index.js';

test('databaseName extrait le nom de base', () => {
  expect(databaseName('postgres://u:p@localhost:5432/runtime')).toBe('runtime');
});
