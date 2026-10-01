// SPDX-License-Identifier: AGPL-3.0-only
// Revue de F-20261001-R01 : sous node-worker (copie de Node à capacités de fichier), le noyau lance le worker en mode
// d'exécution sécurisé (AT_SECURE) ; Node y ignore NODE_OPTIONS et NODE_EXTRA_CA_CERTS, OpenSSL ses variables, en
// silence. Le worker le signale au démarrage (noms seulement, jamais les valeurs).
import { expect, test } from 'vitest';
import { isSecureExec, secureExecIgnoredWarning } from './secure-exec.js';

/** Vecteur auxiliaire 64 bits petit-boutiste : paires (type, valeur), terminé par AT_NULL. */
function auxv(pairs: [number, number][]): Buffer {
  const buf = Buffer.alloc((pairs.length + 1) * 16);
  pairs.forEach(([type, value], i) => {
    buf.writeBigUInt64LE(BigInt(type), i * 16);
    buf.writeBigUInt64LE(BigInt(value), i * 16 + 8);
  });
  return buf;
}

test('AT_SECURE (23) lu dans le vecteur auxiliaire ; illisible (hors Linux) : faux', () => {
  expect(isSecureExec(() => auxv([[6, 4096], [23, 1], [25, 1234]]))).toBe(true);
  expect(isSecureExec(() => auxv([[6, 4096], [23, 0]]))).toBe(false);
  expect(isSecureExec(() => auxv([[6, 4096]]))).toBe(false);
  expect(
    isSecureExec(() => {
      throw new Error('ENOENT');
    }),
  ).toBe(false);
});

test('avertissement : variables ignorées sous AT_SECURE nommées, valeurs jamais citées ; rien hors mode sécurisé', () => {
  const env = { NODE_OPTIONS: '--max-old-space-size=4096', NODE_EXTRA_CA_CERTS: '/run/secrets/zz_test_ca.pem', SSL_CERT_FILE: '/x', OPENSSL_CONF: '/y', PATH: '/bin' };
  const warning = secureExecIgnoredWarning(env, true);
  expect(warning).toMatch(/NODE_OPTIONS/);
  expect(warning).toMatch(/NODE_EXTRA_CA_CERTS/);
  expect(warning).toMatch(/SSL_CERT_FILE/);
  expect(warning).toMatch(/OPENSSL_CONF/);
  expect(warning).not.toMatch(/zz_test_ca|4096/);
  expect(warning).not.toMatch(/PATH/);
  expect(secureExecIgnoredWarning(env, false)).toBeUndefined();
  expect(secureExecIgnoredWarning({ PATH: '/bin', NODE_OPTIONS: '' }, true)).toBeUndefined();
});
