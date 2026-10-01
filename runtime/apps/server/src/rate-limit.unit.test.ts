// SPDX-License-Identifier: AGPL-3.0-only
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

test('tentative comptée avant l’opération, annulée d’une seule unité en cas de succès (jamais remise à zéro)', () => {
  const limiter = new AttemptLimiter({ max: 3, windowMs: 1000, now: () => 0 });
  limiter.fail('ip');
  limiter.fail('ip');
  limiter.fail('ip'); // tentative en cours, comptée d'avance
  limiter.cancel('ip'); // elle a réussi : annulée, les deux échecs restent
  expect(limiter.blocked('ip')).toBe(false);
  limiter.fail('ip');
  expect(limiter.blocked('ip')).toBe(true);
  limiter.cancel('absent');
  expect(limiter.size).toBe(1);
});
