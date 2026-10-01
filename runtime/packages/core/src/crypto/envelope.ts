// SPDX-License-Identifier: AGPL-3.0-only
// Enveloppe DEK/KEK (INV8, 08 § 3) : AES-256-GCM (node:crypto), nonce aléatoire de 12 octets par chiffrement,
// tag de 16 octets explicite, AAD liée à la ligne. Une DEK aléatoire par valeur, enveloppée par la KEK.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KekPurpose, MasterKey } from './master-key.js';

/** Identifiant du format (colonne `alg`). Un nouveau format = une nouvelle valeur. */
export const SEAL_ALG = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

/** Valeur scellée, telle que stockée : `ciphertext` = chiffré ‖ tag ; `dekWrapped` = nonce ‖ DEK chiffrée ‖ tag. */
export type SealedValue = {
  ciphertext: Buffer;
  nonce: Buffer;
  dekWrapped: Buffer;
  alg: string;
  kekVersion: number;
};

/** KEK d'un usage pour une génération de clé maîtresse (`version` = `kek_version` stockée). */
export type Kek = { key: Buffer; version: number };

export function kekFor(master: MasterKey, version: number, purpose: KekPurpose = 'secrets'): Kek {
  return { key: master.kek(purpose), version };
}

/** Échec d'ouverture : message volontairement générique (ni clé, ni AAD, ni fragment de valeur). */
export class SecretDecryptError extends Error {
  override name = 'SecretDecryptError';
  constructor() {
    super('déchiffrement impossible (clé différente, données associées différentes ou valeur altérée)');
  }
}

/** Composants de l'AAD : `|` interdit dans chacun, pour qu'aucune AAD ne soit ambiguë. */
function aadString(parts: string[]): string {
  for (const p of parts) if (p === '' || p.includes('|')) throw new Error(`composant d'AAD invalide : « ${p} »`);
  return parts.join('|');
}

/** AAD d'une ligne de `secrets` : `secret|id|kind|owner_id` (`instance` si owner_id NULL). */
export function secretAad(row: { id: string; kind: string; ownerId: string | null }): string {
  return aadString(['secret', row.id, row.kind, row.ownerId ?? 'instance']);
}

/** AAD d'une ligne de `run_artifacts` : `artifact|id|run_id|owner_id|kind` (l'artefact est lié à son run et à son propriétaire). */
export function artifactAad(row: { id: string; runId: string; ownerId: string; kind: string }): string {
  return aadString(['artifact', row.id, row.runId, row.ownerId, row.kind]);
}

/**
 * AAD d'une ligne de `site_sessions` (13 § 12, INV5) : `site_session|owner_id|domain|key_version`. Une valeur
 * déplacée vers un autre utilisateur ou un autre domaine ne s'ouvre plus (assert_identity_pinned).
 */
export function siteSessionAad(row: { ownerId: string; domain: string; keyVersion: number }): string {
  return aadString(['site_session', row.ownerId, row.domain, String(row.keyVersion)]);
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): { nonce: Buffer; data: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { nonce, data };
}

function gcmDecrypt(key: Buffer, nonce: Buffer, data: Buffer, aad: Buffer): Buffer {
  if (nonce.length !== NONCE_BYTES || data.length < TAG_BYTES) throw new SecretDecryptError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new SecretDecryptError();
  }
}

const dekAad = (aad: string) => Buffer.from(`dek|${aad}`);

/** Scelle `plaintext` : nouvelle DEK, nouveau nonce, AAD `aad` sur la valeur et sur l'enveloppe de la DEK. */
export function sealSecret(plaintext: string | Buffer, kek: Kek, aad: string): SealedValue {
  const dek = randomBytes(DEK_BYTES);
  try {
    const value = gcmEncrypt(dek, Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8'), Buffer.from(aad));
    const wrapped = gcmEncrypt(kek.key, dek, dekAad(aad));
    return {
      ciphertext: value.data,
      nonce: value.nonce,
      dekWrapped: Buffer.concat([wrapped.nonce, wrapped.data]),
      alg: SEAL_ALG,
      kekVersion: kek.version,
    };
  } finally {
    dek.fill(0);
  }
}

/** Ouvre une valeur scellée ; `SecretDecryptError` si la KEK, l'AAD ou une donnée diffère. */
export function openSecretBytes(sealed: SealedValue, kek: Kek, aad: string): Buffer {
  if (sealed.alg !== SEAL_ALG) throw new SecretDecryptError();
  const dek = gcmDecrypt(kek.key, sealed.dekWrapped.subarray(0, NONCE_BYTES), sealed.dekWrapped.subarray(NONCE_BYTES), dekAad(aad));
  try {
    return gcmDecrypt(dek, sealed.nonce, sealed.ciphertext, Buffer.from(aad));
  } finally {
    dek.fill(0);
  }
}

export function openSecret(sealed: SealedValue, kek: Kek, aad: string): string {
  return openSecretBytes(sealed, kek, aad).toString('utf8');
}

/** Rotation (`rekey`) : ouvre avec `from`, rescelle entièrement avec `to` (nouvelle DEK, nouveaux nonces). */
export function rotate(sealed: SealedValue, from: Kek, to: Kek, aad: string): SealedValue {
  const plaintext = openSecretBytes(sealed, from, aad);
  try {
    return sealSecret(plaintext, to, aad);
  } finally {
    plaintext.fill(0);
  }
}
