// SPDX-License-Identifier: AGPL-3.0-only
// Suite commune aux deux implémentations de l'`ObjectStore` (cdc/sym-browser 03 § 6) : `disk` (disk-store.unit.test.ts) et
// `s3` (s3-store.integration.test.ts, MinIO). assert_secrets_protected (BINV6, tâche 3.0) : objets illisibles sans la clé ;
// purge des objets expirés, et seulement eux ; URL signées à durée limitée.
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { SecretDecryptError } from '../crypto/envelope.js';
import { generateMasterKey, MasterKey } from '../crypto/master-key.js';
import { artifactObjectKey, profileObjectKey } from './keys.js';
import { type BlobStore, ObjectNotFoundError, ObjectStore, ObjectUrlError, type ObjectStoreOptions } from './object-store.js';

export type SuiteContext = { blobs: () => BlobStore };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const newMaster = () => MasterKey.parse(generateMasterKey());
export const canary = () => `zz_test_canary_${randomBytes(8).toString('hex')}`;

export async function readAll(source: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

export const downloadKey = (tenantId = randomUUID()) =>
  artifactObjectKey({ kind: 'download', tenantId, sessionId: randomUUID(), artifactId: randomUUID() });

export function storeSuite(ctx: SuiteContext): void {
  const master = newMaster();
  const make = (opts: Partial<ObjectStoreOptions> = {}) => new ObjectStore({ blobs: ctx.blobs(), master, kekVersion: 1, ...opts });

  test('put puis get en flux : aller-retour, taille, liste par préfixe', async () => {
    const store = make();
    const tenantId = randomUUID();
    const key = downloadKey(tenantId);
    const data = randomBytes(200_000);
    const put = await store.put(key, Readable.from([data.subarray(0, 1000), data.subarray(1000)]));
    expect(put.key).toBe(key);
    expect(put.size).toBe(data.length);
    expect(put.storedBytes).toBeGreaterThan(data.length);
    expect((await readAll(await store.get(key))).equals(data)).toBe(true);
    expect(await store.getBuffer(key)).toEqual(data);
    const listed = await store.list(`artifacts/download/${tenantId}/`);
    expect(listed.map((o) => o.key)).toEqual([key]);
    expect(listed[0]!.storedBytes).toBe(put.storedBytes);
    expect(listed[0]!.lastModified).toBeInstanceOf(Date);
  });

  test('objet vide et Buffer direct', async () => {
    const store = make();
    const key = downloadKey();
    await store.put(key, Buffer.alloc(0));
    expect(await store.getBuffer(key)).toEqual(Buffer.alloc(0));
  });

  test('réécriture d’une clé : la nouvelle valeur remplace l’ancienne', async () => {
    const store = make();
    const key = profileObjectKey({ tenantId: randomUUID(), profileId: randomUUID(), version: 1 });
    await store.put(key, Buffer.from('ancienne'));
    await store.put(key, Buffer.from('nouvelle'));
    expect((await store.getBuffer(key)).toString()).toBe('nouvelle');
  });

  test('objet absent : ObjectNotFoundError ; delete idempotent', async () => {
    const store = make();
    const key = downloadKey();
    await expect(store.get(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await store.put(key, Buffer.from('x'));
    await store.delete(key);
    await store.delete(key);
    await expect(store.get(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  test('clé hors format refusée avant tout accès au stockage', async () => {
    const store = make();
    await expect(store.put('../../etc/passwd', Buffer.from('x'))).rejects.toThrow(/clé d’objet invalide/);
    await expect(store.get('artifacts/har/../x/y/z')).rejects.toThrow(/clé d’objet invalide/);
  });

  test('assert_secrets_protected (3.0) : octets stockés sans le clair, illisibles sans la clé maîtresse', async () => {
    const store = make();
    const key = profileObjectKey({ tenantId: randomUUID(), profileId: randomUUID(), version: 1 });
    const secret = canary();
    await store.put(key, Buffer.from(`{"cookies":[{"name":"sid","value":"${secret}"}]}`.repeat(50)));
    const raw = await readAll(await ctx.blobs().get(key));
    for (const form of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]) {
      expect(raw.includes(Buffer.from(form))).toBe(false);
    }
    const stranger = new ObjectStore({ blobs: ctx.blobs(), master: newMaster(), kekVersion: 1 });
    await expect(stranger.getBuffer(key)).rejects.toBeInstanceOf(SecretDecryptError);
    expect((await store.getBuffer(key)).toString()).toContain(secret);
  });

  test('assert_secrets_protected (3.0) : objet copié sous une autre clé ou altéré → illisible', async () => {
    const store = make();
    const key = downloadKey();
    await store.put(key, Buffer.from(canary()));
    const raw = await readAll(await ctx.blobs().get(key));
    const moved = downloadKey();
    await ctx.blobs().put(moved, Readable.from([raw]));
    await expect(store.getBuffer(moved)).rejects.toBeInstanceOf(SecretDecryptError);
    const flipped = Buffer.from(raw);
    flipped[flipped.length - 1]! ^= 1;
    await ctx.blobs().put(key, Readable.from([flipped]));
    await expect(store.getBuffer(key)).rejects.toBeInstanceOf(SecretDecryptError);
  });

  test('clé maîtresse précédente : lecture des objets de l’ancienne version, écriture sous la nouvelle', async () => {
    const old = make();
    const key = downloadKey();
    await old.put(key, Buffer.from('avant rotation'));
    const rotated = new ObjectStore({ blobs: ctx.blobs(), master: newMaster(), kekVersion: 2, previous: [{ master, version: 1 }] });
    expect((await rotated.getBuffer(key)).toString()).toBe('avant rotation');
    await rotated.put(key, Buffer.from('après'));
    await expect(old.getBuffer(key)).rejects.toBeInstanceOf(SecretDecryptError);
  });

  test('écriture interrompue : aucun objet partiel visible', async () => {
    const store = make();
    const key = downloadKey();
    async function* failing(): AsyncGenerator<Buffer> {
      yield randomBytes(100_000);
      throw new Error('source coupée');
    }
    await expect(store.put(key, Readable.from(failing()))).rejects.toThrow('source coupée');
    await expect(store.get(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
    const tenantPrefix = key.split('/').slice(0, 3).join('/') + '/';
    expect(await store.list(tenantPrefix)).toEqual([]);
  });

  test('purge : supprime les objets expirés par type, et seulement eux (profils jamais)', async () => {
    const store = make();
    const tenantId = randomUUID();
    const sessionId = randomUUID();
    const key = (kind: 'download' | 'trace' | 'console') => artifactObjectKey({ kind, tenantId, sessionId, artifactId: randomUUID() });
    const download = key('download');
    const trace = key('trace');
    const consoleLog = key('console');
    const profile = profileObjectKey({ tenantId, profileId: randomUUID(), version: 1 });
    for (const k of [download, trace, consoleLog, profile]) await store.put(k, Buffer.from(k));
    const listed = new Map((await store.list('')).map((o) => [o.key, o.lastModified.getTime()]));
    const t0 = Math.max(...[download, trace, consoleLog, profile].map((k) => listed.get(k)!));
    const t = (k: string) => listed.get(k)!;
    const mine = (deleted: string[]) => deleted.filter((k) => k.includes(tenantId)).sort();

    expect(mine((await store.purgeExpired({ now: new Date(t(download) + DAY - 1) })).deleted)).toEqual([]);
    expect(mine((await store.purgeExpired({ now: new Date(t(download) + DAY) })).deleted)).toEqual([download]);
    await expect(store.get(download)).rejects.toBeInstanceOf(ObjectNotFoundError);
    for (const k of [trace, consoleLog, profile]) expect((await store.getBuffer(k)).toString()).toBe(k);

    expect(mine((await store.purgeExpired({ now: new Date(t0 + 7 * DAY) })).deleted)).toEqual([consoleLog, trace].sort());
    expect(mine((await store.purgeExpired({ now: new Date(t0 + 10_000 * DAY) })).deleted)).toEqual([]);
    expect((await store.getBuffer(profile)).toString()).toBe(profile);
  });

  test('purge : rétention réglable par type', async () => {
    const store = make({ retention: { download: 2 * HOUR, trace: DAY } });
    const download = downloadKey();
    await store.put(download, Buffer.from('d'));
    const lm = (await store.list(download.split('/').slice(0, 3).join('/') + '/'))[0]!.lastModified.getTime();
    expect((await store.purgeExpired({ now: new Date(lm + 2 * HOUR - 1) })).deleted).not.toContain(download);
    expect((await store.purgeExpired({ now: new Date(lm + 2 * HOUR) })).deleted).toContain(download);
  });

  test('URL signée : durée limitée, liée à l’objet, ouverte en flux déchiffré', async () => {
    let now = Date.now();
    const store = make({ now: () => new Date(now) });
    const key = downloadKey();
    const data = randomBytes(5000);
    await store.put(key, data);
    const url = new URL(store.signedUrl(key, { url: 'https://browser.example.test/v1/sessions/s/files/f', ttlSeconds: 60 }));
    expect(url.origin + url.pathname).toBe('https://browser.example.test/v1/sessions/s/files/f');
    const token = url.searchParams.get('t')!;
    expect(token).toBeTruthy();
    expect(token).not.toContain(key);
    expect(store.verifySignedToken(token, { key })).toEqual({ key, expiresAt: new Date(now + 60_000) });
    expect(await readAll(await store.openSigned(token, { key }))).toEqual(data);

    await expect(store.openSigned(token, { key: downloadKey() })).rejects.toMatchObject({ reason: 'invalid' });
    const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect(() => store.verifySignedToken(forged, { key })).toThrow(ObjectUrlError);
    const stranger = new ObjectStore({ blobs: ctx.blobs(), master: newMaster(), kekVersion: 1 });
    expect(() => stranger.verifySignedToken(token, { key })).toThrow(expect.objectContaining({ reason: 'invalid' }));

    now += 60_000;
    expect(() => store.verifySignedToken(token, { key })).toThrow(expect.objectContaining({ reason: 'expired' }));
    await expect(store.openSigned(token, { key })).rejects.toMatchObject({ reason: 'expired' });
  });

  test('URL signée : durée par défaut 5 min, maximum 1 h, refus hors bornes', () => {
    const now = Date.now();
    const store = make({ now: () => new Date(now) });
    const key = downloadKey();
    const token = new URL(store.signedUrl(key, { url: 'https://h.test/x?a=1' })).searchParams.get('t')!;
    expect(store.verifySignedToken(token, { key }).expiresAt.getTime()).toBe(now + 300_000);
    expect(new URL(store.signedUrl(key, { url: 'https://h.test/x?a=1' })).searchParams.get('a')).toBe('1');
    for (const ttlSeconds of [0, -1, 3601, 1.5, Number.NaN]) {
      expect(() => store.signedUrl(key, { url: 'https://h.test/x', ttlSeconds }), String(ttlSeconds)).toThrow(/durée/);
    }
    expect(() => store.signedUrl('../x', { url: 'https://h.test/x' })).toThrow(/clé d’objet invalide/);
  });
}
