// SPDX-License-Identifier: AGPL-3.0-only
// ObjectStore `s3` (cdc/sym-browser 03 § 6, 04b § 11 `S3_*`) contre un MinIO en conteneur : suite commune + propriétés S3
// (envoi en plusieurs parties, pagination de la liste, envoi interrompu abandonné, identifiants refusés).
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Secret } from '../crypto/redact.js';
import { createBucket, dockerAvailable, startS3, type S3Fixture } from './minio.testkit.js';
import { ObjectStore } from './object-store.js';
import { S3BlobStore, S3_MIN_PART_BYTES } from './s3-store.js';
import { downloadKey, newMaster, readAll, storeSuite } from './store-suite.testkit.js';

const available = dockerAvailable();
if (!available && process.env.CI) throw new Error('ObjectStore s3 : Docker requis sous CI (MinIO en conteneur).');
if (!available) process.stderr.write('Avertissement : Docker indisponible, tests ObjectStore s3 (MinIO) sautés.\n');

describe.skipIf(!available)('ObjectStore s3 (MinIO)', { timeout: 120_000 }, () => {
  let fixture: S3Fixture;
  let blobs: S3BlobStore;
  const bucket = `symb-${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    fixture = await startS3();
    blobs = new S3BlobStore(fixture.options(bucket));
    await createBucket(blobs);
  }, 300_000);

  afterAll(() => fixture?.stop());

  describe('suite commune', () => {
    storeSuite({ blobs: () => blobs });
  });

  test('objet de 12 Mio : envoi en plusieurs parties, relu à l’octet près', async () => {
    const store = new ObjectStore({ blobs, master: newMaster(), kekVersion: 1 });
    const key = downloadKey();
    const data = randomBytes(12 * 1024 * 1024 + 123);
    const put = await store.put(key, Readable.from((async function* () {
      for (let i = 0; i < data.length; i += 256 * 1024) yield data.subarray(i, i + 256 * 1024);
    })()));
    expect(put.storedBytes).toBeGreaterThan(2 * S3_MIN_PART_BYTES);
    expect((await readAll(await store.get(key))).equals(data)).toBe(true);
  });

  test('envoi en plusieurs parties interrompu : abandonné, aucun objet ni envoi en attente', async () => {
    const store = new ObjectStore({ blobs, master: newMaster(), kekVersion: 1 });
    const key = downloadKey();
    async function* failing(): AsyncGenerator<Buffer> {
      yield randomBytes(S3_MIN_PART_BYTES + 1024);
      yield randomBytes(1024);
      throw new Error('source coupée');
    }
    await expect(store.put(key, Readable.from(failing()))).rejects.toThrow('source coupée');
    expect(await blobs.pendingUploads(key)).toEqual([]);
    expect(await store.list(key.split('/').slice(0, 3).join('/') + '/')).toEqual([]);
  });

  test('liste paginée (continuation) : tous les objets du préfixe, dans l’ordre', async () => {
    const paged = new S3BlobStore({ ...fixture.options(bucket), pageSize: 2 });
    const store = new ObjectStore({ blobs: paged, master: newMaster(), kekVersion: 1 });
    const tenantId = randomUUID();
    const keys = Array.from({ length: 5 }, () => downloadKey(tenantId)).sort();
    for (const key of keys) await store.put(key, Buffer.from(key));
    expect((await store.list(`artifacts/download/${tenantId}/`)).map((o) => o.key)).toEqual(keys);
  });

  test('identifiants refusés : erreur explicite, sans le secret', async () => {
    const wrongSecret = `zz_test_canary_${randomBytes(8).toString('hex')}`;
    const options = fixture.options(bucket);
    const bad = new S3BlobStore({ ...options, credentials: { accessKeyId: options.credentials.accessKeyId, secretAccessKey: new Secret(wrongSecret) } });
    const error = await bad.get(downloadKey()).then(() => undefined, (e: unknown) => e as Error);
    expect(error?.message).toMatch(/S3 GET .* 403/);
    expect(error?.message).not.toContain(wrongSecret);
  });
});
