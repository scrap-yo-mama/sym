// SPDX-License-Identifier: AGPL-3.0-only
// ObjectStore `disk` (cdc/sym-browser 03 § 6, 04b § 11 `OBJECT_DIR`) : suite commune + propriétés propres au disque.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, test } from 'vitest';
import { DiskBlobStore } from './disk-store.js';
import { ObjectStore } from './object-store.js';
import { canary, downloadKey, newMaster, readAll, storeSuite } from './store-suite.testkit.js';

const dirs: string[] = [];
const newDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'symb-objects-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

describe('ObjectStore disk : suite commune', () => {
  const blobs = new DiskBlobStore(newDir());
  storeSuite({ blobs: () => blobs });
});

describe('ObjectStore disk : propriétés du disque', () => {
  test('fichiers 0600, répertoires 0700, sous la racine seulement', async () => {
    const root = newDir();
    const store = new ObjectStore({ blobs: new DiskBlobStore(root), master: newMaster(), kekVersion: 1 });
    const key = downloadKey();
    await store.put(key, Buffer.from('x'));
    const file = join(root, ...key.split('/'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'artifacts')).mode & 0o777).toBe(0o700);
    expect(walk(root)).toEqual([file]);
  });

  test('assert_secrets_protected (3.0) : aucun fichier du répertoire ne contient le clair', async () => {
    const root = newDir();
    const store = new ObjectStore({ blobs: new DiskBlobStore(root), master: newMaster(), kekVersion: 1 });
    const secret = canary();
    for (let i = 0; i < 3; i++) await store.put(downloadKey(), Buffer.from(`password=${secret}`));
    for (const file of walk(root)) expect(readFileSync(file).includes(Buffer.from(secret)), file).toBe(false);
  });

  test('écriture atomique : fichier temporaire invisible et retiré en cas d’échec', async () => {
    const root = newDir();
    const blobs = new DiskBlobStore(root);
    const key = downloadKey();
    async function* failing(): AsyncGenerator<Buffer> {
      yield randomBytes(10);
      throw new Error('coupure');
    }
    await expect(blobs.put(key, Readable.from(failing()))).rejects.toThrow('coupure');
    expect(walk(root).filter((f) => !statSync(f).isDirectory())).toEqual([]);
    const listed: string[] = [];
    for await (const o of blobs.list('')) listed.push(o.key);
    expect(listed).toEqual([]);
  });

  test('fichiers étrangers ignorés par la liste et jamais purgés', async () => {
    const root = newDir();
    const store = new ObjectStore({ blobs: new DiskBlobStore(root), master: newMaster(), kekVersion: 1 });
    const key = downloadKey();
    await store.put(key, Buffer.from('x'));
    const foreign = join(root, 'artifacts', 'download', 'LISEZMOI.txt');
    writeFileSync(foreign, 'pas un objet');
    const old = new Date(Date.now() - 400 * 86_400_000);
    utimesSync(foreign, old, old);
    expect((await store.list('')).map((o) => o.key)).toEqual([key]);
    expect((await store.purgeExpired({ now: new Date(Date.now() + 365 * 86_400_000) })).deleted).toEqual([key]);
    expect(statSync(foreign).isFile()).toBe(true);
  });

  test('purge sur l’horloge du fichier : un téléchargement ancien part, un récent reste', async () => {
    const root = newDir();
    const store = new ObjectStore({ blobs: new DiskBlobStore(root), master: newMaster(), kekVersion: 1 });
    const oldKey = downloadKey();
    const freshKey = downloadKey();
    await store.put(oldKey, Buffer.from('ancien'));
    await store.put(freshKey, Buffer.from('récent'));
    const old = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(join(root, ...oldKey.split('/')), old, old);
    expect((await store.purgeExpired()).deleted).toEqual([oldKey]);
    expect((await store.getBuffer(freshKey)).toString()).toBe('récent');
  });

  test('racine relative refusée', () => {
    expect(() => new DiskBlobStore('data/objects')).toThrow(/absolu/);
  });

  test('lecture brute depuis le disque = octets chiffrés', async () => {
    const root = newDir();
    const blobs = new DiskBlobStore(root);
    const store = new ObjectStore({ blobs, master: newMaster(), kekVersion: 1 });
    const key = downloadKey();
    await store.put(key, Buffer.from('bonjour'));
    expect((await readAll(await blobs.get(key))).equals(readFileSync(join(root, ...key.split('/'))))).toBe(true);
  });
});
