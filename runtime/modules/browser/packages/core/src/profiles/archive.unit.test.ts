// SPDX-License-Identifier: AGPL-3.0-only
// Archive d'un profil persistant (cdc/sym-browser 04c § 4.1, tâche 3.1) : tar + gzip des seules bases d'état (cookies,
// stockages, IndexedDB, préférences, bases de service workers), caches exclus, restauration stricte (aucun chemin hors du
// répertoire cible, ni lien, ni type spécial), taille plafonnée.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, test } from 'vitest';
import { isPersistedProfilePath, packProfile, ProfileArchiveError, ProfileTooLargeError, unpackProfile } from './archive.js';

const dirs: string[] = [];
const newDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'symb-profile-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function put(root: string, rel: string, content: string | Buffer): void {
  const file = join(root, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function files(root: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [relative(root, join(dir, e.name)).split('\\').join('/')]));
  return walk(root).sort();
}

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

async function* once(buf: Buffer): AsyncGenerator<Buffer> {
  yield buf;
}

/** En-tête ustar minimal (pour fabriquer des archives hostiles). */
function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000600\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
function tarOf(entries: { name: string; type?: string; body?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    parts.push(tarHeader(e.name, body.length, e.type ?? '0'), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

describe('sélection des fichiers du profil (04c § 4.1)', () => {
  test.each([
    'Local State',
    'Default/Preferences',
    'Default/Secure Preferences',
    'Default/Cookies',
    'Default/Cookies-journal',
    'Default/Network/Cookies',
    'Default/Local Storage/leveldb/000003.log',
    'Default/Session Storage/MANIFEST-000001',
    'Default/IndexedDB/https_fixture.test_0.indexeddb.leveldb/CURRENT',
    'Default/Service Worker/Database/CURRENT',
    'Default/Service Worker/ScriptCache/index',
    'Profile 1/Cookies',
  ])('conservé : %s', (path) => expect(isPersistedProfilePath(path)).toBe(true));

  test.each([
    'Default/Cache/Cache_Data/data_0',
    'Default/Code Cache/js/index',
    'Default/GPUCache/data_1',
    'GrShaderCache/data_0',
    'ShaderCache/data_0',
    'Default/Service Worker/CacheStorage/index.txt',
    'SingletonLock',
    'SingletonSocket',
    'DevToolsActivePort',
    'Default/History',
    'Crashpad/settings.dat',
    'Other/Cookies',
    '../Default/Cookies',
    'Default/../Cookies',
  ])('écarté : %s', (path) => expect(isPersistedProfilePath(path)).toBe(false));
});

describe('packProfile / unpackProfile', () => {
  test('aller-retour octet pour octet des bases d’état, caches et verrous exclus, droits 0600/0700', async () => {
    const src = newDir();
    const long = `Default/IndexedDB/${'https_'.padEnd(150, 'x')}.indexeddb.leveldb/000005.ldb`;
    put(src, 'Local State', '{"os_crypt":{}}');
    put(src, 'Default/Network/Cookies', Buffer.from([0, 1, 2, 255]));
    put(src, 'Default/Local Storage/leveldb/000003.log', 'zz_test_local');
    put(src, long, Buffer.alloc(70_000, 7));
    put(src, 'Default/Preferences', '{}');
    put(src, 'Default/Local Storage/leveldb/LOCK', '');
    put(src, 'Default/Cache/Cache_Data/data_0', 'cache');
    put(src, 'Default/Code Cache/js/index', 'code');
    put(src, 'DevToolsActivePort', '1234\n/devtools/browser/x');
    symlinkSync('/etc/passwd', join(src, 'SingletonLock'));
    symlinkSync('/etc/passwd', join(src, 'Default', 'Cookies'));

    const packed = await packProfile(src, { maxBytes: 1_000_000 });
    expect(packed.files).toBe(6);
    const archive = await collect(packed.stream);
    expect(archive.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    const dest = join(newDir(), 'profile');
    mkdirSync(dest, { mode: 0o700 });
    const restored = await unpackProfile(once(archive), dest, { maxBytes: 1_000_000 });
    expect(restored.files).toBe(6);
    expect(files(dest)).toEqual([long, 'Default/Local Storage/leveldb/000003.log', 'Default/Local Storage/leveldb/LOCK','Default/Network/Cookies', 'Default/Preferences', 'Local State'].sort());
    expect(readFileSync(join(dest, 'Default/Network/Cookies'))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(readFileSync(join(dest, ...long.split('/')))).toEqual(Buffer.alloc(70_000, 7));
    expect(readFileSync(join(dest, 'Default/Local Storage/leveldb/LOCK'))).toEqual(Buffer.alloc(0));
    expect(statSync(join(dest, 'Default/Network/Cookies')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dest, 'Default/Network')).mode & 0o777).toBe(0o700);
  });

  test('profil vide : archive valide, restauration sans fichier', async () => {
    const packed = await packProfile(newDir(), { maxBytes: 10 });
    const dest = newDir();
    expect((await unpackProfile(once(await collect(packed.stream)), dest, { maxBytes: 10 })).files).toBe(0);
    expect(files(dest)).toEqual([]);
  });

  test('au-delà de maxBytes : ProfileTooLargeError avant tout octet émis', async () => {
    const src = newDir();
    put(src, 'Default/Cookies', Buffer.alloc(600));
    put(src, 'Default/Preferences', Buffer.alloc(600));
    await expect(packProfile(src, { maxBytes: 1_000 })).rejects.toBeInstanceOf(ProfileTooLargeError);
  });

  test('restauration plafonnée : une archive qui dépasse maxBytes une fois décompressée est refusée', async () => {
    const big = tarOf([{ name: 'Default/Cookies', body: 'x'.repeat(5_000) }]);
    await expect(unpackProfile(once(big), newDir(), { maxBytes: 1_000 })).rejects.toBeInstanceOf(ProfileTooLargeError);
  });

  test.each([
    ['chemin remontant', [{ name: 'Default/../../evil' }]],
    ['chemin absolu', [{ name: '/tmp/evil' }]],
    ['lien symbolique', [{ name: 'Default/Cookies', type: '2' }]],
    ['lien dur', [{ name: 'Default/Cookies', type: '1' }]],
    ['périphérique', [{ name: 'Default/Cookies', type: '3' }]],
    ['fichier hors sélection', [{ name: 'Default/History', body: 'h' }]],
  ])('archive hostile refusée (%s), rien écrit hors de la cible', async (_name, entries) => {
    const root = newDir();
    const dest = join(root, 'profile');
    mkdirSync(dest);
    await expect(unpackProfile(once(tarOf(entries)), dest, { maxBytes: 1_000_000 })).rejects.toBeInstanceOf(ProfileArchiveError);
    expect(readdirSync(root)).toEqual(['profile']);
  });

  test('archive tronquée ou corrompue refusée', async () => {
    const good = tarOf([{ name: 'Default/Cookies', body: 'abc' }]);
    await expect(unpackProfile(once(good.subarray(0, good.length - 8)), newDir(), { maxBytes: 1_000 })).rejects.toThrow();
    const raw = Buffer.concat([tarHeader('Default/Cookies', 3, '0'), Buffer.from('abc'), Buffer.alloc(509), Buffer.alloc(1024)]);
    raw[150] = 0x41; // somme de contrôle faussée
    await expect(unpackProfile(once(gzipSync(raw)), newDir(), { maxBytes: 1_000 })).rejects.toBeInstanceOf(ProfileArchiveError);
  });
});
