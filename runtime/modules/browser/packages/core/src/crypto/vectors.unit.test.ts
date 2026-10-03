// SPDX-License-Identifier: AGPL-3.0-only
// Vecteurs de SYM rejoués (cdc/sym-browser 03 § 1, ligne Chiffrement) : même schéma, octet pour octet. Les vecteurs sont
// produits par runtime/packages/core/src/crypto (voir `source` dans vectors/sym-crypto.json) ; le module ne l'importe pas.
import type * as NodeCrypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { kekFor, openSecret, openSecretBytes, rotate, SEAL_ALG, sealSecret, SecretDecryptError, type SealedValue } from './envelope.js';
import { createKeyCheck, verifyKeyCheck, type KeyCheckRecord } from './key-check.js';
import { MasterKey } from './master-key.js';
import { LOG_REDACT_PATHS, MIN_SCAN_LENGTH, redact, redactArtifactText, REDACTED, redactUrl, SecretValueRegistry } from './redact.js';

/** Tirages imposés à `randomBytes` (file vide : aléa réel). */
const draws = vi.hoisted(() => [] as Buffer[]);
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    randomBytes: (n: number) => {
      const next = draws.shift();
      if (next === undefined) return actual.randomBytes(n);
      if (next.length !== n) throw new Error(`tirage de ${n} octets attendu, ${next.length} fourni`);
      return Buffer.from(next);
    },
  };
});

type HexSealed = { alg: string; kekVersion: number; nonce: string; ciphertext: string; dekWrapped: string };
type Draws = { dek: string; nonce: string; wrapNonce: string };
type Plain = { utf8?: string; hex?: string };
type Vectors = {
  constants: { alg: string; REDACTED: string; MIN_SCAN_LENGTH: number };
  masterKeys: { seed: string; fingerprint: string; kekSecrets: string }[];
  seal: { name: string; key: number; version: number; aad: string; plaintext: Plain; draws: Draws; sealed: HexSealed }[];
  rotate: { from: { key: number; version: number }; to: { key: number; version: number }; aad: string; plaintext: Plain; source: HexSealed; draws: Draws; sealed: HexSealed };
  keyCheck: { key: number; version: number; draws: Draws; record: KeyCheckRecord; verify: { key1: boolean; key2: boolean } };
  redaction: {
    registryValues: string[];
    redactText: { input: string; output: string }[];
    redactUrl: { input: string; output: string }[];
    redactArtifactText: { input: string; output: string }[];
    redact: { input: unknown; output: unknown }[];
    logRedactPaths: string[];
  };
};

const vectors = JSON.parse(readFileSync(new URL('../../vectors/sym-crypto.json', import.meta.url), 'utf8')) as Vectors;

const keyOf = (index: number): MasterKey => {
  const entry = vectors.masterKeys[index - 1];
  if (!entry) throw new Error(`clé de test ${index} absente`);
  return MasterKey.parse(createHash('sha256').update(entry.seed).digest().toString('base64'));
};
const fromHex = (s: HexSealed): SealedValue => ({
  alg: s.alg,
  kekVersion: s.kekVersion,
  nonce: Buffer.from(s.nonce, 'hex'),
  ciphertext: Buffer.from(s.ciphertext, 'hex'),
  dekWrapped: Buffer.from(s.dekWrapped, 'hex'),
});
const toHex = (s: SealedValue): HexSealed => ({
  alg: s.alg,
  kekVersion: s.kekVersion,
  nonce: s.nonce.toString('hex'),
  ciphertext: s.ciphertext.toString('hex'),
  dekWrapped: s.dekWrapped.toString('hex'),
});
const plainBytes = (p: Plain): Buffer => (p.hex !== undefined ? Buffer.from(p.hex, 'hex') : Buffer.from(p.utf8 ?? '', 'utf8'));
const impose = (d: Draws) => draws.splice(0, draws.length, Buffer.from(d.dek, 'hex'), Buffer.from(d.nonce, 'hex'), Buffer.from(d.wrapNonce, 'hex'));

describe('vecteurs de SYM : clé maîtresse et KEK', () => {
  test('constantes du format identiques', () => {
    expect(SEAL_ALG).toBe(vectors.constants.alg);
    expect(REDACTED).toBe(vectors.constants.REDACTED);
    expect(MIN_SCAN_LENGTH).toBe(vectors.constants.MIN_SCAN_LENGTH);
  });

  test.each(vectors.masterKeys.map((k, i) => [i + 1, k] as const))('clé %i : empreinte et KEK `secrets` identiques', (index, entry) => {
    const key = keyOf(index);
    expect(key.fingerprint).toBe(entry.fingerprint);
    expect(key.kek('secrets').toString('hex')).toBe(entry.kekSecrets);
  });
});

describe('vecteurs de SYM : enveloppe', () => {
  test.each(vectors.seal.map((v) => [v.name, v] as const))('%s : SYM → module, le scellé de SYM s’ouvre', (_name, v) => {
    const kek = kekFor(keyOf(v.key), v.version);
    expect(openSecretBytes(fromHex(v.sealed), kek, v.aad).equals(plainBytes(v.plaintext))).toBe(true);
    if (v.plaintext.utf8 !== undefined) expect(openSecret(fromHex(v.sealed), kek, v.aad)).toBe(v.plaintext.utf8);
  });

  test.each(vectors.seal.map((v) => [v.name, v] as const))('%s : module → SYM, mêmes tirages, mêmes octets', (_name, v) => {
    impose(v.draws);
    const sealed = sealSecret(plainBytes(v.plaintext), kekFor(keyOf(v.key), v.version), v.aad);
    expect(draws).toHaveLength(0);
    expect(toHex(sealed)).toEqual(v.sealed);
  });

  test.each(vectors.seal.map((v) => [v.name, v] as const))('%s : autre AAD, autre clé ou autre version de KEK → échec', (_name, v) => {
    const sealed = fromHex(v.sealed);
    expect(() => openSecret(sealed, kekFor(keyOf(v.key), v.version), `${v.aad}x`)).toThrow(SecretDecryptError);
    expect(() => openSecret(sealed, kekFor(keyOf(v.key === 1 ? 2 : 1), v.version), v.aad)).toThrow(SecretDecryptError);
  });

  test('rotate : le scellé de SYM re-scellé par le module donne les octets de SYM', () => {
    const r = vectors.rotate;
    const from = kekFor(keyOf(r.from.key), r.from.version);
    const to = kekFor(keyOf(r.to.key), r.to.version);
    impose(r.draws);
    const next = rotate(fromHex(r.source), from, to, r.aad);
    expect(toHex(next)).toEqual(r.sealed);
    expect(openSecret(fromHex(r.sealed), to, r.aad)).toBe(r.plaintext.utf8);
    expect(() => openSecret(fromHex(r.sealed), from, r.aad)).toThrow(SecretDecryptError);
  });
});

describe('vecteurs de SYM : key_check', () => {
  test('le témoin de SYM est vérifié par le module (bonne clé seulement)', () => {
    const v = vectors.keyCheck;
    expect(verifyKeyCheck(v.record, keyOf(1))).toBe(v.verify.key1);
    expect(verifyKeyCheck(v.record, keyOf(2))).toBe(v.verify.key2);
  });

  test('le témoin créé par le module avec les mêmes tirages est celui de SYM', () => {
    const v = vectors.keyCheck;
    impose(v.draws);
    expect(createKeyCheck(keyOf(v.key), v.version)).toEqual(v.record);
  });
});

describe('vecteurs de SYM : masquage', () => {
  const registry = () => {
    const reg = new SecretValueRegistry();
    for (const value of vectors.redaction.registryValues) reg.add(value);
    return reg;
  };

  test.each(vectors.redaction.redactText.map((v) => [v.input, v.output] as const))('couche 3 : %j', (input, output) => {
    expect(registry().redactText(input)).toBe(output);
  });

  test.each(vectors.redaction.redactUrl.map((v) => [v.input, v.output] as const))('URL : %j', (input, output) => {
    expect(redactUrl(input, registry())).toBe(output);
  });

  test.each(vectors.redaction.redactArtifactText.map((v) => [v.input, v.output] as const))('artefact : %j', (input, output) => {
    expect(redactArtifactText(input, registry())).toBe(output);
  });

  test('redact (copie profonde) : sortie de SYM', () => {
    for (const v of vectors.redaction.redact) expect(redact(v.input, registry())).toEqual(v.output);
  });

  test('couche 2 : les chemins de SYM sont tous repris', () => {
    for (const path of vectors.redaction.logRedactPaths) expect(LOG_REDACT_PATHS, path).toContain(path);
  });
});
