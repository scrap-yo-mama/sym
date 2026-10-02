// SPDX-License-Identifier: AGPL-3.0-only
// Enveloppe DEK/KEK (cdc/sym-browser 03 § 1, BINV6) : AES-256-GCM (node:crypto), nonce aléatoire de 12 octets par
// chiffrement, tag de 16 octets explicite, AAD liée à la ligne. Une DEK aléatoire par valeur, enveloppée par la KEK.
// Même format et même ordre des tirages que SYM (runtime/packages/core/src/crypto/envelope.ts) : vecteurs partagés.
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

/** AAD à partir de ses composants : `|` interdit dans chacun et composant vide refusé, pour qu'aucune AAD ne soit ambiguë. */
export function buildAad(parts: readonly string[]): string {
  for (const p of parts) if (p === '' || p.includes('|')) throw new Error(`composant d'AAD invalide : « ${p} »`);
  return parts.join('|');
}

/** Identifiants d'un profil de proxy nommé (04c § 2) : `proxy_profile|tenant_id|profile_id`. */
export function proxyProfileAad(row: { tenantId: string; profileId: string }): string {
  return buildAad(['proxy_profile', row.tenantId, row.profileId]);
}

/** Identifiants de proxy portés en ligne par une session (`sessions.options`, 04c § 2) : `session_proxy|tenant_id|session_id`. */
export function sessionProxyAad(row: { tenantId: string; sessionId: string }): string {
  return buildAad(['session_proxy', row.tenantId, row.sessionId]);
}

/** Archive d'un profil persistant (04c § 4) : `profile|tenant_id|profile_id|version`. */
export function profileAad(row: { tenantId: string; profileId: string; version: number }): string {
  if (!Number.isSafeInteger(row.version) || row.version < 0) throw new Error(`version de profil invalide : ${row.version}`);
  return buildAad(['profile', row.tenantId, row.profileId, String(row.version)]);
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

/** Rotation : ouvre avec `from`, rescelle entièrement avec `to` (nouvelle DEK, nouveaux nonces). */
export function rotate(sealed: SealedValue, from: Kek, to: Kek, aad: string): SealedValue {
  const plaintext = openSecretBytes(sealed, from, aad);
  try {
    return sealSecret(plaintext, to, aad);
  } finally {
    plaintext.fill(0);
  }
}
