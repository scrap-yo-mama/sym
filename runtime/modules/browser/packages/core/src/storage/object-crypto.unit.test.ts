// SPDX-License-Identifier: AGPL-3.0-only
// Chiffrement par enveloppe des objets en flux (cdc/sym-browser 03 § 6, BINV6) et assert_secrets_protected, partie objets
// de la tâche 3.0 : clé d'objet scellée par l'enveloppe de 0.3, segments AES-256-GCM authentifiés, ordre et fin protégés.
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { kekFor, SecretDecryptError } from '../crypto/envelope.js';
import { generateMasterKey, MasterKey } from '../crypto/master-key.js';
import { decryptObject, encryptObject, OBJECT_CHUNK_BYTES, OBJECT_FORMAT_OVERHEAD, encryptedObjectSize } from './object-crypto.js';
import { artifactObjectKey, objectAad } from './keys.js';

const newKey = () => MasterKey.parse(generateMasterKey());
const kek = kekFor(newKey(), 1);
const keks = (k = kek) => (version: number) => (version === k.version ? k : undefined);
const aad = objectAad(artifactObjectKey({ kind: 'download', tenantId: randomUUID(), sessionId: randomUUID(), artifactId: randomUUID() }));

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

async function* pieces(data: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

const seal = (data: Buffer, opts?: { chunkBytes?: number }, k = kek, a = aad) => collect(encryptObject(pieces(data, 777), k, a, opts));
const open = (data: Buffer, k = kek, a = aad) => collect(decryptObject(pieces(data, 1000), keks(k), a));

describe('assert_secrets_protected (3.0) : chiffrement des objets en flux', () => {
  test('aller-retour à toutes les frontières de segment, taille chiffrée prévisible', async () => {
    const chunkBytes = 1024;
    for (const size of [0, 1, chunkBytes - 1, chunkBytes, chunkBytes + 1, 3 * chunkBytes, 3 * chunkBytes + 5]) {
      const data = randomBytes(size);
      const sealed = await seal(data, { chunkBytes });
      expect(sealed.length, `taille ${size}`).toBe(encryptedObjectSize(size, chunkBytes));
      expect((await open(sealed)).equals(data), `taille ${size}`).toBe(true);
    }
  });

  test('segment par défaut de 64 Kio ; un objet de 1 Mio passe en flux', async () => {
    expect(OBJECT_CHUNK_BYTES).toBe(64 * 1024);
    const data = randomBytes(1024 * 1024 + 3);
    const sealed = await seal(data);
    expect(sealed.length).toBe(encryptedObjectSize(data.length));
    expect(sealed.length - data.length).toBe(OBJECT_FORMAT_OVERHEAD + 17 * 16);
    expect((await open(sealed)).equals(data)).toBe(true);
  });

  test('le chiffré ne contient pas le clair (ni en clair, ni en base64, ni en hexadécimal)', async () => {
    const canary = `zz_test_canary_${randomBytes(8).toString('hex')}`;
    const data = Buffer.from(`cookie=${canary};`.repeat(5000));
    const sealed = await seal(data);
    for (const form of [canary, Buffer.from(canary).toString('base64'), Buffer.from(canary).toString('hex')]) {
      expect(sealed.includes(Buffer.from(form))).toBe(false);
    }
  });

  test('deux chiffrements du même clair diffèrent (clé d’objet et nonces neufs)', async () => {
    const data = Buffer.from('même contenu');
    expect((await seal(data)).equals(await seal(data))).toBe(false);
  });

  test('illisible sans la clé maîtresse : autre clé → SecretDecryptError, aucun octet rendu', async () => {
    const sealed = await seal(randomBytes(5000), { chunkBytes: 1024 });
    const other = kekFor(newKey(), 1);
    const out: Buffer[] = [];
    await expect(
      (async () => {
        for await (const part of decryptObject(pieces(sealed, 999), keks(other), aad)) out.push(part);
      })(),
    ).rejects.toBeInstanceOf(SecretDecryptError);
    expect(Buffer.concat(out).length).toBe(0);
  });

  test('version de clé inconnue → SecretDecryptError', async () => {
    const sealed = await seal(Buffer.from('x'));
    await expect(collect(decryptObject(pieces(sealed, 50), () => undefined, aad))).rejects.toBeInstanceOf(SecretDecryptError);
  });

  test('lié à sa clé d’objet : un objet déplacé sous une autre clé ne s’ouvre pas', async () => {
    const sealed = await seal(Buffer.from('contenu'));
    const elsewhere = objectAad(artifactObjectKey({ kind: 'download', tenantId: randomUUID(), sessionId: randomUUID(), artifactId: randomUUID() }));
    await expect(open(sealed, kek, elsewhere)).rejects.toBeInstanceOf(SecretDecryptError);
  });

  test('altérations détectées : octet modifié, troncature, segment retiré, permuté ou ajouté', async () => {
    const chunkBytes = 1024;
    const data = randomBytes(4 * chunkBytes + 10);
    const sealed = await seal(data, { chunkBytes });
    const header = OBJECT_FORMAT_OVERHEAD;
    const seg = chunkBytes + 16;
    const segment = (i: number) => sealed.subarray(header + i * seg, header + (i + 1) * seg);
    const variants: [string, Buffer][] = [
      ['octet d’en-tête', Buffer.from(sealed).fill(sealed[10]! ^ 1, 10, 11)],
      ['octet de segment', Buffer.from(sealed).fill(sealed[header + 5]! ^ 1, header + 5, header + 6)],
      ['dernier octet', Buffer.from(sealed).fill(sealed.at(-1)! ^ 1, sealed.length - 1)],
      ['troncature au milieu', sealed.subarray(0, sealed.length - 7)],
      ['dernier segment retiré', sealed.subarray(0, header + 4 * seg)],
      ['segments permutés', Buffer.concat([sealed.subarray(0, header), segment(1), segment(0), sealed.subarray(header + 2 * seg)])],
      ['octets ajoutés', Buffer.concat([sealed, randomBytes(20)])],
      ['en-tête seul', sealed.subarray(0, header)],
      ['vide', Buffer.alloc(0)],
    ];
    for (const [name, bytes] of variants) await expect(open(bytes), name).rejects.toBeInstanceOf(SecretDecryptError);
  });

  test('déchiffrement en flux : les premiers segments sortent avant la fin de la source', async () => {
    const chunkBytes = 1024;
    const sealed = await seal(randomBytes(10 * chunkBytes), { chunkBytes });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* slow(): AsyncGenerator<Buffer> {
      yield sealed.subarray(0, OBJECT_FORMAT_OVERHEAD + 3 * (chunkBytes + 16));
      await gate;
      yield sealed.subarray(OBJECT_FORMAT_OVERHEAD + 3 * (chunkBytes + 16));
    }
    const it = decryptObject(slow(), keks(), aad)[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value).toHaveLength(chunkBytes);
    release();
    let total = first.value.length;
    for (let r = await it.next(); !r.done; r = await it.next()) total += r.value.length;
    expect(total).toBe(10 * chunkBytes);
  });

  test('taille de segment hors bornes refusée', async () => {
    await expect(seal(Buffer.from('x'), { chunkBytes: 0 })).rejects.toThrow(/segment/);
    await expect(seal(Buffer.from('x'), { chunkBytes: 32 * 1024 * 1024 })).rejects.toThrow(/segment/);
  });
});
