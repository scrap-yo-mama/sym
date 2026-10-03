// SPDX-License-Identifier: AGPL-3.0-only
// Chiffrement par enveloppe des objets, en flux (cdc/sym-browser 03 § 6, BINV6). Une clé d'objet aléatoire de 32 octets
// est scellée par l'enveloppe de 0.3 (`sealSecret` : DEK/KEK AES-256-GCM, AAD `object|<aad de l'objet>`) ; le contenu est
// découpé en segments chiffrés AES-256-GCM avec cette clé (construction STREAM : nonce = préfixe aléatoire ‖ compteur ‖
// drapeau « dernier »), chaque segment authentifiant aussi l'en-tête complet et l'AAD de l'objet. Un segment altéré,
// retiré, permuté, ajouté, ou une fin tronquée font échouer la lecture (`SecretDecryptError`). Mémoire bornée : un segment.
//
// Format v1 (octets) : magic `SYMBOBJ\x01` (8) ‖ kekVersion u32 BE (4) ‖ taille de segment u32 BE (4) ‖ préfixe de nonce (7)
// ‖ clé d'objet scellée : nonce (12) ‖ DEK enveloppée (60) ‖ clé chiffrée + tag (48) ; puis les segments (clair ‖ tag 16).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type Kek, openSecretBytes, SEAL_ALG, sealSecret, SecretDecryptError } from '../crypto/envelope.js';

export const OBJECT_MAGIC = Buffer.from('SYMBOBJ\x01', 'latin1');
/** Taille de segment par défaut : 64 Kio. */
export const OBJECT_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const NONCE_PREFIX_BYTES = 7;
const TAG_BYTES = 16;
const OBJECT_KEY_BYTES = 32;
const SEALED_NONCE = 12;
const SEALED_DEK = 12 + 32 + 16;
const SEALED_KEY = OBJECT_KEY_BYTES + 16;
/** Octets fixes de l'en-tête ; chaque segment ajoute un tag de 16 octets. */
export const OBJECT_FORMAT_OVERHEAD = OBJECT_MAGIC.length + 4 + 4 + NONCE_PREFIX_BYTES + SEALED_NONCE + SEALED_DEK + SEALED_KEY;
const MAX_CHUNKS = 2 ** 32 - 1;

/** Taille stockée d'un objet de `size` octets en clair (un segment au moins, même vide). */
export function encryptedObjectSize(size: number, chunkBytes = OBJECT_CHUNK_BYTES): number {
  const chunks = Math.max(1, Math.ceil(size / chunkBytes));
  return OBJECT_FORMAT_OVERHEAD + size + chunks * TAG_BYTES;
}

function checkChunkBytes(chunkBytes: number): void {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
    throw new RangeError(`taille de segment invalide : ${chunkBytes} (1 à ${MAX_CHUNK_BYTES} octets)`);
  }
}

const keyAad = (aad: string) => `object|${aad}`;

function chunkNonce(prefix: Buffer, index: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

/** File d'octets : accumule les morceaux reçus sans recopie quadratique. */
class ByteQueue {
  #parts: Buffer[] = [];
  length = 0;
  push(part: Buffer): void {
    if (part.length === 0) return;
    this.#parts.push(part);
    this.length += part.length;
  }
  take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const head = this.#parts[0]!;
      const used = Math.min(head.length, n - offset);
      head.copy(out, offset, 0, used);
      offset += used;
      if (used === head.length) this.#parts.shift();
      else this.#parts[0] = head.subarray(used);
    }
    this.length -= n;
    return out;
  }
}

const asBuffer = (part: Buffer | Uint8Array | string) => (Buffer.isBuffer(part) ? part : typeof part === 'string' ? Buffer.from(part) : Buffer.from(part.buffer, part.byteOffset, part.byteLength));

/** Chiffre un flux : rend l'en-tête puis chaque segment dès qu'il est complet. */
export async function* encryptObject(
  source: AsyncIterable<Buffer | Uint8Array | string>,
  kek: Kek,
  aad: string,
  opts: { chunkBytes?: number } = {},
): AsyncGenerator<Buffer> {
  const chunkBytes = opts.chunkBytes ?? OBJECT_CHUNK_BYTES;
  checkChunkBytes(chunkBytes);
  const objectKey = randomBytes(OBJECT_KEY_BYTES);
  try {
    const sealed = sealSecret(objectKey, kek, keyAad(aad));
    const prefix = randomBytes(NONCE_PREFIX_BYTES);
    const numbers = Buffer.alloc(8);
    numbers.writeUInt32BE(kek.version, 0);
    numbers.writeUInt32BE(chunkBytes, 4);
    const header = Buffer.concat([OBJECT_MAGIC, numbers, prefix, sealed.nonce, sealed.dekWrapped, sealed.ciphertext]);
    const chunkAad = Buffer.concat([header, Buffer.from(aad)]);
    yield header;

    let index = 0;
    const seal = (plain: Buffer, last: boolean): Buffer => {
      if (index >= MAX_CHUNKS) throw new RangeError('objet trop grand pour le format');
      const cipher = createCipheriv('aes-256-gcm', objectKey, chunkNonce(prefix, index++, last), { authTagLength: TAG_BYTES });
      cipher.setAAD(chunkAad);
      return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    };
    const queue = new ByteQueue();
    for await (const part of source) {
      queue.push(asBuffer(part));
      // Un segment n'est émis « non dernier » que si d'autres octets le suivent : la fin reste toujours un segment marqué.
      while (queue.length > chunkBytes) yield seal(queue.take(chunkBytes), false);
    }
    yield seal(queue.take(queue.length), true);
  } finally {
    objectKey.fill(0);
  }
}

/**
 * Déchiffre un flux produit par `encryptObject`. `keks(version)` rend la KEK de la version lue dans l'en-tête (clé
 * courante ou précédente) ; inconnue, ou toute incohérence : `SecretDecryptError`. Les segments sortent au fil de l'eau ;
 * une fin tronquée échoue au dernier segment.
 */
export async function* decryptObject(
  source: AsyncIterable<Buffer | Uint8Array | string>,
  keks: (version: number) => Kek | undefined,
  aad: string,
): AsyncGenerator<Buffer> {
  const queue = new ByteQueue();
  const iterator = source[Symbol.asyncIterator]();
  const pull = async (): Promise<boolean> => {
    const next = await iterator.next();
    if (next.done) return false;
    queue.push(asBuffer(next.value));
    return true;
  };

  while (queue.length < OBJECT_FORMAT_OVERHEAD) if (!(await pull())) throw new SecretDecryptError();
  const header = queue.take(OBJECT_FORMAT_OVERHEAD);
  if (!header.subarray(0, OBJECT_MAGIC.length).equals(OBJECT_MAGIC)) throw new SecretDecryptError();
  let offset = OBJECT_MAGIC.length;
  const kekVersion = header.readUInt32BE(offset);
  const chunkBytes = header.readUInt32BE(offset + 4);
  offset += 8;
  const prefix = header.subarray(offset, (offset += NONCE_PREFIX_BYTES));
  const nonce = header.subarray(offset, (offset += SEALED_NONCE));
  const dekWrapped = header.subarray(offset, (offset += SEALED_DEK));
  const ciphertext = header.subarray(offset, offset + SEALED_KEY);
  if (chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) throw new SecretDecryptError();
  const kek = keks(kekVersion);
  if (!kek || kek.version !== kekVersion) throw new SecretDecryptError();
  const objectKey = openSecretBytes({ ciphertext, nonce, dekWrapped, alg: SEAL_ALG, kekVersion }, kek, keyAad(aad));
  try {
    const chunkAad = Buffer.concat([header, Buffer.from(aad)]);
    const segment = chunkBytes + TAG_BYTES;
    let index = 0;
    const open = (data: Buffer, last: boolean): Buffer => {
      if (data.length < TAG_BYTES || index >= MAX_CHUNKS) throw new SecretDecryptError();
      try {
        const decipher = createDecipheriv('aes-256-gcm', objectKey, chunkNonce(prefix, index++, last), { authTagLength: TAG_BYTES });
        decipher.setAAD(chunkAad);
        decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
        return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]);
      } catch {
        throw new SecretDecryptError();
      }
    };
    let more = true;
    while (more) {
      while (queue.length > segment) yield open(queue.take(segment), false);
      more = await pull();
    }
    yield open(queue.take(queue.length), true);
  } finally {
    objectKey.fill(0);
  }
}
