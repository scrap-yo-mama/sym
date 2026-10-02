// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.8 (04c § 5) : téléchargements captés par CDP, chiffrés dans l'ObjectStore, listés et récupérables jusqu'à leur
// expiration ; envois déposés dans le répertoire de la session ; plafonds de taille. CDP simulé, ObjectStore disque réel.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskBlobStore, MasterKey, ObjectStore } from '@sym-browser/core';
import { describe, expect, test } from 'vitest';
import { sessionDir } from '../dedicated/index.js';
import { FileNotFoundError, SessionFiles, UploadTooLargeError, contentDisposition, sanitizeFileName, type CdpLike, type DownloadEvent } from './index.js';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const LIMITS = { downloadMaxBytes: 1_000, sessionDownloadMaxBytes: 1_500, uploadMaxBytes: 64 };

/** Session CDP de navigateur simulée : enregistre les commandes, émet les événements de téléchargement. */
class FakeCdp implements CdpLike {
  readonly sent: [string, Record<string, unknown> | undefined][] = [];
  readonly #listeners = new Map<string, ((params: never) => void)[]>();
  targets: { targetId: string; browserContextId: string }[] = [];
  detached = false;
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push([method, params]);
    if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: this.targets.map((t) => ({ ...t, type: 'page' })) });
    return Promise.resolve({});
  }
  on(event: string, listener: (params: never) => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }
  off(event: string, listener: (params: never) => void): void {
    this.#listeners.set(event, (this.#listeners.get(event) ?? []).filter((l) => l !== listener));
  }
  detach(): Promise<void> {
    this.detached = true;
    return Promise.resolve();
  }
  emit(event: string, params: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(params as never);
  }
}

async function setup(options: { now?: () => Date } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'symb-files-'));
  const store = new ObjectStore({ blobs: new DiskBlobStore(join(root, 'objects')), master: MasterKey.generate(), kekVersion: 1, ...(options.now ? { now: options.now } : {}) });
  const events: DownloadEvent[] = [];
  const files = new SessionFiles({ store, limits: LIMITS, onEvent: (e) => events.push(e), ...(options.now ? { now: options.now } : {}) });
  const cdp = new FakeCdp();
  const browserKey = {};
  const open = async (sessionId: string, contextId: string, acceptDownloads = true) => {
    const dir = sessionDir(join(root, 'data'), sessionId);
    await mkdir(dir.downloads, { recursive: true });
    cdp.targets.push({ targetId: `frame-${sessionId}`, browserContextId: contextId });
    const attached = await files.attach({ sessionId, tenantId: 'tenant-a', dir, acceptDownloads, browserKey, openCdp: async () => cdp, browserContextId: contextId });
    return { dir, attached };
  };
  /** Téléchargement complet simulé : début, progression, fichier écrit sous son guid, fin. */
  const download = async (dirPath: string, frameId: string, guid: string, data: Buffer, name = 'rapport.bin') => {
    cdp.emit('Browser.downloadWillBegin', { guid, frameId, url: 'https://zz.invalid/x', suggestedFilename: name });
    cdp.emit('Browser.downloadProgress', { guid, totalBytes: data.length, receivedBytes: 0, state: 'inProgress' });
    writeFileSync(join(dirPath, guid), data);
    cdp.emit('Browser.downloadProgress', { guid, totalBytes: data.length, receivedBytes: data.length, state: 'completed', filePath: join(dirPath, guid) });
    await files.whenIdle();
  };
  return { root, store, files, events, cdp, open, download };
}

describe('noms de fichiers (04c § 5.1 : nom nettoyé)', () => {
  test('séparateurs, caractères de contrôle, noms réservés et longueur', () => {
    expect(sanitizeFileName('rapport.pdf')).toBe('rapport.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a\\b\\c.txt')).toBe('c.txt');
    expect(sanitizeFileName('bad\u0000na\nme.txt')).toBe('bad_na_me.txt');
    expect(sanitizeFileName('..')).toBe('download');
    expect(sanitizeFileName('')).toBe('download');
    expect(sanitizeFileName(`${'x'.repeat(300)}.bin`)).toHaveLength(255);
    expect(sanitizeFileName(`${'x'.repeat(300)}.bin`).endsWith('.bin')).toBe(true);
  });

  test('Content-Disposition : attachment, repli ASCII et filename* encodé (RFC 6266)', () => {
    expect(contentDisposition('rapport.pdf')).toBe(`attachment; filename="rapport.pdf"; filename*=UTF-8''rapport.pdf`);
    expect(contentDisposition('été "x".txt')).toBe(`attachment; filename="_t_ _x_.txt"; filename*=UTF-8''%C3%A9t%C3%A9%20%22x%22.txt`);
  });
});

describe('envois vers la session (04c § 5.2)', () => {
  test('déposé dans sessions/{id}/uploads/{fileId} (0600), rend {id, path, size, sha256}', async () => {
    const { files, root } = await setup();
    const dir = sessionDir(join(root, 'data'), 's1');
    const data = randomBytes(40);
    const out = await files.upload({ sessionId: 's1', dir, body: [data.subarray(0, 10), data.subarray(10)] });
    expect(out).toMatchObject({ size: 40, sha256: sha(data) });
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.path).toBe(join(dir.root, 'uploads', out.id));
    expect(statSync(out.path).mode & 0o777).toBe(0o600);
  });

  test('au-delà de SYMB_UPLOAD_MAX_BYTES : refus 413, aucun fichier laissé', async () => {
    const { files, root } = await setup();
    const dir = sessionDir(join(root, 'data'), 's1');
    await expect(files.upload({ sessionId: 's1', dir, body: [randomBytes(40), randomBytes(40)] })).rejects.toThrow(UploadTooLargeError);
    expect(readdirSync(join(dir.root, 'uploads'))).toEqual([]);
  });
});

describe('téléchargements (04c § 5.1)', () => {
  test('capté, sha256 calculé, chiffré dans l’ObjectStore (download, 24 h), listé, relu à l’octet près ; copie locale retirée', async () => {
    const t0 = new Date('2026-10-02T10:00:00Z');
    const { files, events, cdp, open, download, store } = await setup({ now: () => t0 });
    const { dir } = await open('s1', 'ctx-1');
    expect(cdp.sent).toContainEqual(['Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir.downloads, browserContextId: 'ctx-1', eventsEnabled: true }]);
    const data = randomBytes(700);
    await download(dir.downloads, 'frame-s1', 'g-1', data, 'rapport final.bin');
    const [file] = await files.list('s1');
    expect(file).toMatchObject({ name: 'rapport final.bin', size: 700, sha256: sha(data), createdAt: t0, expiresAt: new Date(t0.getTime() + 24 * 3_600_000) });
    const opened = await files.open('s1', file!.id);
    const parts: Buffer[] = [];
    for await (const part of opened.stream) parts.push(part as Buffer);
    expect(sha(Buffer.concat(parts))).toBe(sha(data));
    expect(readdirSync(dir.downloads)).toEqual([]);
    // L'objet stocké est chiffré : le clair n'y figure pas.
    const [object] = await store.list('artifacts/download/');
    expect(object!.key).toBe(`artifacts/download/tenant-a/s1/${file!.id}`);
    expect(events.map((e) => [e.state, e.bytes])).toEqual([['started', 0], ['completed', 700]]);
  });

  test('acceptDownloads absent : téléchargements refusés (deny), aucun événement capté', async () => {
    const { cdp, open } = await setup();
    await open('s1', 'ctx-1', false);
    expect(cdp.sent).toContainEqual(['Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: 'ctx-1' }]);
  });

  test('plafond par fichier : annulé dès que la taille annoncée ou reçue le dépasse, fichier partiel supprimé', async () => {
    const { files, events, cdp, open } = await setup();
    const { dir } = await open('s1', 'ctx-1');
    cdp.emit('Browser.downloadWillBegin', { guid: 'g-big', frameId: 'frame-s1', url: 'https://zz.invalid/big', suggestedFilename: 'big.bin' });
    writeFileSync(join(dir.downloads, 'g-big'), Buffer.alloc(10));
    cdp.emit('Browser.downloadProgress', { guid: 'g-big', totalBytes: 5_000, receivedBytes: 10, state: 'inProgress' });
    await files.whenIdle();
    expect(cdp.sent).toContainEqual(['Browser.cancelDownload', { guid: 'g-big', browserContextId: 'ctx-1' }]);
    expect(events.at(-1)).toMatchObject({ state: 'canceled', reason: 'size_exceeded', name: 'big.bin' });
    expect(readdirSync(dir.downloads)).toEqual([]);
    expect(await files.list('s1')).toEqual([]);
  });

  test('plafond par session : la somme des téléchargements de la session est bornée', async () => {
    const { files, events, open, download, cdp } = await setup();
    const { dir } = await open('s1', 'ctx-1');
    await download(dir.downloads, 'frame-s1', 'g-1', randomBytes(900));
    cdp.emit('Browser.downloadWillBegin', { guid: 'g-2', frameId: 'frame-s1', url: 'https://zz.invalid/2', suggestedFilename: 'deux.bin' });
    cdp.emit('Browser.downloadProgress', { guid: 'g-2', totalBytes: 0, receivedBytes: 700, state: 'inProgress' });
    await files.whenIdle();
    expect(events.at(-1)).toMatchObject({ state: 'canceled', reason: 'size_exceeded', name: 'deux.bin' });
    expect((await files.list('s1')).map((f) => f.size)).toEqual([900]);
  });

  test('plusieurs sessions sur un même Chromium : chaque téléchargement va à la session de son contexte', async () => {
    const { files, cdp, open, download } = await setup();
    const a = await open('sa', 'ctx-a');
    const b = await open('sb', 'ctx-b');
    await download(b.dir.downloads, 'frame-sb', 'g-b', randomBytes(100), 'b.bin');
    // Cadre inconnu de Target.getTargets (sous-cadre) : attribué à la fin par le répertoire du fichier.
    await download(a.dir.downloads, 'frame-inconnu', 'g-a', randomBytes(50), 'a.bin');
    expect((await files.list('sa')).map((f) => f.name)).toEqual(['a.bin']);
    expect((await files.list('sb')).map((f) => f.name)).toEqual(['b.bin']);
    // Une seule session CDP par Chromium, fermée quand la dernière session se détache.
    await a.attached.detach();
    expect(cdp.detached).toBe(false);
    await b.attached.detach();
    expect(cdp.detached).toBe(true);
  });

  test('fin de session : téléchargement en cours annulé (session_ended) ; fichiers terminés encore listés jusqu’à expiresAt', async () => {
    let now = new Date('2026-10-02T10:00:00Z');
    const { files, events, cdp, open, download } = await setup({ now: () => now });
    const { dir, attached } = await open('s1', 'ctx-1');
    await download(dir.downloads, 'frame-s1', 'g-1', randomBytes(100));
    cdp.emit('Browser.downloadWillBegin', { guid: 'g-2', frameId: 'frame-s1', url: 'https://zz.invalid/2', suggestedFilename: 'encours.bin' });
    await attached.detach();
    expect(events.at(-1)).toMatchObject({ state: 'canceled', reason: 'session_ended', name: 'encours.bin' });
    const [file] = await files.list('s1');
    expect(file).toBeDefined();
    now = new Date(now.getTime() + 24 * 3_600_000);
    expect(await files.list('s1')).toEqual([]);
    await expect(files.open('s1', file!.id)).rejects.toThrow(FileNotFoundError);
  });

  test('suppression anticipée : objet et entrée retirés ; fichier d’une autre session introuvable', async () => {
    const { files, open, download, store } = await setup();
    const { dir } = await open('s1', 'ctx-1');
    await download(dir.downloads, 'frame-s1', 'g-1', randomBytes(10));
    const [file] = await files.list('s1');
    await expect(files.open('s2', file!.id)).rejects.toThrow(FileNotFoundError);
    await files.delete('s1', file!.id);
    expect(await files.list('s1')).toEqual([]);
    expect(await store.list('artifacts/download/')).toEqual([]);
    await expect(files.delete('s1', file!.id)).rejects.toThrow(FileNotFoundError);
  });
});
