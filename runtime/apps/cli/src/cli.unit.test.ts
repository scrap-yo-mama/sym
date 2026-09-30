import { expect, test } from 'vitest';
import { run } from './cli.js';

test('--version affiche la version', () => {
  expect(run(['--version'])).toEqual({ code: 0, out: '0.0.0' });
});

test('commande inconnue : code 1', () => {
  expect(run(['nope']).code).toBe(1);
});
