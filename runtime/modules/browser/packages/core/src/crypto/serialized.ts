// SPDX-License-Identifier: AGPL-3.0-only
// Forme texte d'une valeur scellée (colonnes `text` : secret de webhook, tâche 2.5) : JSON versionné, champs binaires en base64.
// Une forme illisible lève `SecretDecryptError`, comme une valeur altérée.
import { SecretDecryptError, type Kek, type SealedValue } from './envelope.js';

export function serializeSealed(sealed: SealedValue): string {
  return JSON.stringify({
    v: 1,
    alg: sealed.alg,
    kekVersion: sealed.kekVersion,
    nonce: sealed.nonce.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    dekWrapped: sealed.dekWrapped.toString('base64'),
  });
}

export function parseSealed(text: string): SealedValue {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new SecretDecryptError();
  }
  const { v, alg, kekVersion, nonce, ciphertext, dekWrapped } = raw;
  if (v !== 1 || typeof alg !== 'string' || typeof kekVersion !== 'number' || typeof nonce !== 'string' || typeof ciphertext !== 'string' || typeof dekWrapped !== 'string') {
    throw new SecretDecryptError();
  }
  return { alg, kekVersion, nonce: Buffer.from(nonce, 'base64'), ciphertext: Buffer.from(ciphertext, 'base64'), dekWrapped: Buffer.from(dekWrapped, 'base64') };
}

/** KEK courante et, pendant un changement de `MASTER_KEY`, la précédente : la version du scellé choisit la bonne. */
export type Keys = { current: Kek; previous?: Kek };

export function kekForSealed(keys: Keys, sealed: SealedValue): Kek {
  const kek = [keys.current, keys.previous].find((k) => k?.version === sealed.kekVersion);
  if (kek === undefined) throw new SecretDecryptError();
  return kek;
}
