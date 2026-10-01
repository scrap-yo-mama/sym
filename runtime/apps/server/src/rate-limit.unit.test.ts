// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import { AttemptLimiter, ipBucket } from './rate-limit.js';

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

test('clé de limite par adresse : IPv6 agrégée par préfixe /64, IPv4 (y compris mappée en IPv6) telle quelle', () => {
  expect(ipBucket('2001:db8:1:2:3:4:5:6')).toBe(ipBucket('2001:db8:1:2:ffff::1'));
  expect(ipBucket('2001:DB8:1:2::1')).toBe(ipBucket('2001:db8:1:2::2'));
  expect(ipBucket('2001:db8:1:2::1')).not.toBe(ipBucket('2001:db8:1:3::1'));
  expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
  expect(ipBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
  expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
});
