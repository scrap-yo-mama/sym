import { expect, test } from 'vitest';
import { AttemptLimiter } from './rate-limit.js';

test('compteur d’échecs : seuil dans la fenêtre, remise à zéro, fenêtre glissante', () => {
  let now = 0;
  const limiter = new AttemptLimiter({ max: 3, windowMs: 1000, maxEntries: 100, now: () => now });
  expect(limiter.blocked('a')).toBe(false);
  for (let i = 0; i < 3; i += 1) limiter.fail('a');
  expect(limiter.blocked('a')).toBe(true);
  expect(limiter.blocked('b')).toBe(false);
  now = 1001;
  expect(limiter.blocked('a')).toBe(false);
  limiter.fail('a');
  limiter.reset('a');
  expect(limiter.blocked('a')).toBe(false);
});

test('mémoire plafonnée : les entrées les plus anciennes sont évincées', () => {
  const limiter = new AttemptLimiter({ max: 1, windowMs: 60_000, maxEntries: 3 });
  for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) limiter.fail(k);
  expect(limiter.size).toBe(3);
  expect(limiter.blocked('k1')).toBe(false);
  expect(limiter.blocked('k5')).toBe(true);
});
