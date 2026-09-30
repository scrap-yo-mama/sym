// SPDX-License-Identifier: AGPL-3.0-only
// Valeur témoin `settings.key_check` (14 § 7) : une constante scellée avec la KEK `secrets` + empreinte courte.
// Vérifiée au démarrage de `server` et `worker` : une autre clé est détectée avant toute lecture ou écriture de secret.
import { kekFor, openSecret, sealSecret, SecretDecryptError } from './envelope.js';
import type { MasterKey } from './master-key.js';

const WITNESS = 'scrapyomama-runtime:key_check:v1';
const witnessAad = (version: number) => `settings|key_check|${version}`;

/** Contenu JSON de `settings.key_check` : aucune clé, seulement le témoin scellé et l'empreinte. */
export type KeyCheckRecord = {
  format: 1;
  version: number;
  fingerprint: string;
  alg: string;
  nonce: string;
  ciphertext: string;
  dekWrapped: string;
};

export function createKeyCheck(master: MasterKey, version: number): KeyCheckRecord {
  const sealed = sealSecret(WITNESS, kekFor(master, version), witnessAad(version));
  return {
    format: 1,
    version,
    fingerprint: master.fingerprint,
    alg: sealed.alg,
    nonce: sealed.nonce.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    dekWrapped: sealed.dekWrapped.toString('base64'),
  };
}

/** Vrai si `master` ouvre le témoin (l'empreinte seule ne suffit pas : le déchiffrement fait foi). */
export function verifyKeyCheck(record: KeyCheckRecord, master: MasterKey): boolean {
  try {
    const plaintext = openSecret(
      {
        alg: record.alg,
        kekVersion: record.version,
        nonce: Buffer.from(record.nonce, 'base64'),
        ciphertext: Buffer.from(record.ciphertext, 'base64'),
        dekWrapped: Buffer.from(record.dekWrapped, 'base64'),
      },
      kekFor(master, record.version),
      witnessAad(record.version),
    );
    return plaintext === WITNESS;
  } catch (error) {
    if (error instanceof SecretDecryptError) return false;
    throw error;
  }
}
