// SPDX-License-Identifier: AGPL-3.0-only
// Fichiers des sessions (cdc/sym-browser 04c § 5, tâche 1.8).
//
// Téléchargements (§ 5.1), quel que soit le client (Playwright natif ou CDP) :
// - à l'attache, le nœud pose `Browser.setDownloadBehavior` sur le contexte de la session : `allowAndName` vers
//   `sessions/{id}/downloads` avec événements si `acceptDownloads`, sinon `deny` ;
// - une seule session CDP de navigateur par Chromium (concentrateur) : Chromium envoie les événements de téléchargement de
//   TOUS les contextes à chaque session de navigateur. Chaque téléchargement est attribué à sa session par son cadre
//   (`frameId` = cible d'une page → `browserContextId`), sinon, à la fin, par le répertoire où Chromium l'a écrit ;
// - plafonds : par fichier (`SYMB_DOWNLOAD_MAX_BYTES`) et par session (`SYMB_SESSION_DOWNLOAD_MAX_BYTES`), sur la taille
//   annoncée ou reçue → `Browser.cancelDownload`, fichier partiel supprimé, événement `canceled` raison `size_exceeded` ;
// - à la fin : sha256 calculé en flux, fichier chiffré dans l'ObjectStore (`artifacts/download/{tenant}/{session}/{id}`,
//   tâche 3.0), ligne d'index, copie locale supprimée ; listé et récupérable jusqu'à son expiration (24 h par défaut), même
//   après la fin de la session.
// Envois (§ 5.2) : déposés dans `sessions/{id}/uploads/{fileId}` (0600), plafond `SYMB_UPLOAD_MAX_BYTES`, supprimés avec
// le répertoire de la session à sa destruction ; le chemin rendu sert à `DOM.setFileInputFiles` d'un client CDP.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { DEFAULT_RETENTION, artifactObjectKey, type ObjectStore } from '@sym-browser/core';
import type { SessionDir } from '../dedicated/index.js';
import { MemoryFileIndex, type FileIndex, type FileRecord } from './file-index.js';
import { sanitizeFileName } from './names.js';

/** Session CDP de navigateur, telle que Playwright la fournit (`browser.newBrowserCDPSession()`). */
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: never) => void): unknown;
  off(event: string, listener: (params: never) => void): unknown;
  detach(): Promise<void>;
}

export type FileLimits = { downloadMaxBytes: number; sessionDownloadMaxBytes: number; uploadMaxBytes: number };

/** Événement `download` du flux de la session (04c § 5.1, 04d). `id` : guid du téléchargement ; `fileId` une fois stocké. */
export type DownloadEvent = {
  type: 'download';
  sessionId: string;
  id: string;
  name: string;
  state: 'started' | 'completed' | 'canceled';
  bytes: number;
  fileId?: string;
  reason?: 'size_exceeded' | 'session_ended' | 'canceled' | 'store_failed';
};

export type FileInfo = { id: string; name: string; size: number; sha256: string; createdAt: Date; expiresAt: Date };

export class FileNotFoundError extends Error {
  override name = 'FileNotFoundError';
  readonly code = 'file_not_found';
  readonly status = 404;
}

export class UploadTooLargeError extends Error {
  override name = 'UploadTooLargeError';
  readonly code = 'upload_too_large';
  readonly status = 413;
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`Envoi refusé : plus de ${limitBytes} octets (SYMB_UPLOAD_MAX_BYTES).`);
    this.limitBytes = limitBytes;
  }
}

export type SessionFilesOptions = {
  store: ObjectStore;
  limits: FileLimits;
  index?: FileIndex;
  /** Rétention des téléchargements (`SYMB_RETENTION_DOWNLOAD_HOURS`) ; défaut 24 h. */
  retentionMs?: number;
  now?: () => Date;
  onEvent?: (event: DownloadEvent) => void;
};

export type AttachTarget = {
  sessionId: string;
  tenantId: string;
  dir: SessionDir;
  acceptDownloads: boolean;
  /** Identité du Chromium porteur (une session CDP de navigateur par Chromium). */
  browserKey: object;
  openCdp: () => Promise<CdpLike>;
  browserContextId: string;
};

export type AttachedFiles = { detach(): Promise<void> };

type Sink = { target: AttachTarget; completedBytes: number; active: Set<Download>; work: Set<Promise<unknown>> };
type Download = { guid: string; frameId: string; name: string; received: number; sink: Sink | undefined; done: boolean; chain: Promise<void> };
type Progress = { guid: string; totalBytes?: number; receivedBytes?: number; state: 'inProgress' | 'completed' | 'canceled'; filePath?: string };
type Hub = { cdp: CdpLike; sinks: Map<string, Sink>; downloads: Map<string, Download>; off: () => void };

export class SessionFiles {
  readonly #options: SessionFilesOptions;
  readonly #index: FileIndex;
  readonly #hubs = new Map<object, Promise<Hub>>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options: SessionFilesOptions) {
    this.#options = options;
    this.#index = options.index ?? new MemoryFileIndex();
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  #track<T>(work: Promise<T>, sink?: Sink): Promise<T> {
    const tracked = work.catch(() => undefined).finally(() => {
      this.#pending.delete(tracked);
      sink?.work.delete(tracked);
    });
    this.#pending.add(tracked);
    sink?.work.add(tracked);
    return work;
  }

  /** Attend la fin des traitements en cours (attribution, stockage, annulations). */
  async whenIdle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  // ---------------------------------------------------------------- téléchargements

  async attach(target: AttachTarget): Promise<AttachedFiles> {
    let hubPromise = this.#hubs.get(target.browserKey);
    if (hubPromise === undefined) {
      hubPromise = this.#openHub(target.openCdp);
      this.#hubs.set(target.browserKey, hubPromise);
      hubPromise.catch(() => this.#hubs.delete(target.browserKey));
    }
    const hub = await hubPromise;
    const sink: Sink = { target, completedBytes: 0, active: new Set(), work: new Set() };
    hub.sinks.set(target.browserContextId, sink);
    try {
      await hub.cdp.send(
        'Browser.setDownloadBehavior',
        target.acceptDownloads
          ? { behavior: 'allowAndName', downloadPath: target.dir.downloads, browserContextId: target.browserContextId, eventsEnabled: true }
          : { behavior: 'deny', browserContextId: target.browserContextId },
      );
    } catch (error) {
      await this.#detach(target.browserKey, hub, sink);
      throw error;
    }
    let detaching: Promise<void> | undefined;
    return { detach: () => (detaching ??= this.#detach(target.browserKey, hub, sink)) };
  }

  async #openHub(openCdp: () => Promise<CdpLike>): Promise<Hub> {
    const cdp = await openCdp();
    const hub: Hub = { cdp, sinks: new Map(), downloads: new Map(), off: () => undefined };
    const onBegin = (event: { guid: string; frameId: string; suggestedFilename: string }): void => this.#onBegin(hub, event);
    const onProgress = (event: Progress): void => {
      const download = hub.downloads.get(event.guid);
      if (download === undefined) return;
      download.chain = download.chain.then(() => this.#onProgress(hub, download, event));
      this.#track(download.chain, download.sink);
    };
    cdp.on('Browser.downloadWillBegin', onBegin as (params: never) => void);
    cdp.on('Browser.downloadProgress', onProgress as (params: never) => void);
    hub.off = () => {
      cdp.off('Browser.downloadWillBegin', onBegin as (params: never) => void);
      cdp.off('Browser.downloadProgress', onProgress as (params: never) => void);
    };
    return hub;
  }

  #onBegin(hub: Hub, event: { guid: string; frameId: string; suggestedFilename: string }): void {
    const download: Download = { guid: event.guid, frameId: event.frameId, name: sanitizeFileName(event.suggestedFilename ?? ''), received: 0, sink: undefined, done: false, chain: Promise.resolve() };
    hub.downloads.set(event.guid, download);
    download.chain = (async () => {
      const { targetInfos } = (await hub.cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }))) as { targetInfos: { targetId: string; browserContextId?: string }[] };
      const contextId = targetInfos.find((t) => t.targetId === event.frameId)?.browserContextId;
      const sink = contextId === undefined ? undefined : hub.sinks.get(contextId);
      if (sink !== undefined) this.#adopt(download, sink);
    })();
    this.#track(download.chain);
  }

  #adopt(download: Download, sink: Sink): void {
    if (!sink.target.acceptDownloads) {
      download.done = true;
      return;
    }
    download.sink = sink;
    sink.active.add(download);
    this.#emit(download, 'started', {});
  }

  async #onProgress(hub: Hub, download: Download, event: Progress): Promise<void> {
    if (download.done) return;
    download.received = Math.max(download.received, event.receivedBytes ?? 0);
    const size = Math.max(event.totalBytes ?? 0, download.received);
    const limits = this.#options.limits;
    if (download.sink === undefined) {
      // Cadre non résolu (sous-cadre) : attribution à la fin par le répertoire d'écriture ; le plafond par fichier, commun à
      // toutes les sessions, s'applique dès maintenant dans chaque contexte du Chromium.
      if (event.state === 'completed' && event.filePath !== undefined) {
        const sink = [...hub.sinks.values()].find((s) => s.target.acceptDownloads && s.target.dir.downloads === dirname(event.filePath!));
        if (sink !== undefined) this.#adopt(download, sink);
      } else if (event.state === 'inProgress' && size > limits.downloadMaxBytes) {
        download.done = true;
        hub.downloads.delete(download.guid);
        for (const sink of hub.sinks.values()) await hub.cdp.send('Browser.cancelDownload', { guid: download.guid, browserContextId: sink.target.browserContextId }).catch(() => undefined);
        return;
      }
      if (download.sink === undefined) {
        if (event.state !== 'inProgress') hub.downloads.delete(download.guid);
        return;
      }
    }
    const sink = download.sink;
    if (event.state === 'canceled') return this.#cancel(hub, download, 'canceled', false);
    if (size > limits.downloadMaxBytes || sink.completedBytes + size > limits.sessionDownloadMaxBytes) return this.#cancel(hub, download, 'size_exceeded', event.state === 'inProgress');
    if (event.state === 'completed') await this.#store(hub, download, event.filePath ?? join(sink.target.dir.downloads, download.guid));
  }

  async #cancel(hub: Hub, download: Download, reason: NonNullable<DownloadEvent['reason']>, inChromium: boolean): Promise<void> {
    const sink = download.sink!;
    download.done = true;
    sink.active.delete(download);
    hub.downloads.delete(download.guid);
    if (inChromium) await hub.cdp.send('Browser.cancelDownload', { guid: download.guid, browserContextId: sink.target.browserContextId }).catch(() => undefined);
    await rm(join(sink.target.dir.downloads, download.guid), { force: true });
    this.#emit(download, 'canceled', { reason });
  }

  async #store(hub: Hub, download: Download, filePath: string): Promise<void> {
    const sink = download.sink!;
    download.done = true;
    hub.downloads.delete(download.guid);
    const { sessionId, tenantId } = sink.target;
    const id = randomUUID();
    const objectKey = artifactObjectKey({ kind: 'download', tenantId, sessionId, artifactId: id });
    const hash = createHash('sha256');
    async function* hashed(): AsyncGenerator<Buffer> {
      for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk as Buffer);
        yield chunk as Buffer;
      }
    }
    try {
      const { size } = await this.#options.store.put(objectKey, hashed());
      const createdAt = this.#now();
      const record: FileRecord = { id, sessionId, tenantId, name: download.name, size, sha256: hash.digest('hex'), objectKey, createdAt, expiresAt: new Date(createdAt.getTime() + (this.#options.retentionMs ?? DEFAULT_RETENTION.download)) };
      await this.#index.insert(record);
      sink.completedBytes += size;
      download.received = size;
      this.#emit(download, 'completed', { fileId: id });
    } catch {
      await this.#options.store.delete(objectKey).catch(() => undefined);
      this.#emit(download, 'canceled', { reason: 'store_failed' });
    } finally {
      sink.active.delete(download);
      await rm(filePath, { force: true });
    }
  }

  #emit(download: Download, state: DownloadEvent['state'], extra: Pick<DownloadEvent, 'fileId' | 'reason'>): void {
    this.#options.onEvent?.({ type: 'download', sessionId: download.sink!.target.sessionId, id: download.guid, name: download.name, state, bytes: download.received, ...extra });
  }

  /** Détachement à la fin de la session : téléchargements en cours annulés (`session_ended`), stockages en cours attendus. */
  async #detach(browserKey: object, hub: Hub, sink: Sink): Promise<void> {
    // Attributions en vol d'abord : un téléchargement commencé juste avant la fin doit être vu pour être annulé.
    await Promise.allSettled([...hub.downloads.values()].map((d) => d.chain));
    for (const download of [...sink.active]) if (!download.done) await this.#cancel(hub, download, 'session_ended', true);
    while (sink.work.size > 0) await Promise.allSettled([...sink.work]);
    if (hub.sinks.get(sink.target.browserContextId) === sink) hub.sinks.delete(sink.target.browserContextId);
    if (hub.sinks.size === 0 && this.#hubs.get(browserKey) !== undefined) {
      this.#hubs.delete(browserKey);
      hub.off();
      await hub.cdp.detach().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- consultation

  async #live(sessionId: string, id: string): Promise<FileRecord> {
    const record = await this.#index.get(sessionId, id);
    if (record === undefined || record.expiresAt.getTime() <= this.#now().getTime()) throw new FileNotFoundError(`Fichier ${id} introuvable pour la session ${sessionId}.`);
    return record;
  }

  /** Téléchargements de la session non expirés, aussi après sa fin (`GET /v1/sessions/{id}/files`). */
  async list(sessionId: string): Promise<FileInfo[]> {
    const now = this.#now().getTime();
    return (await this.#index.list(sessionId))
      .filter((r) => r.expiresAt.getTime() > now)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.name.localeCompare(b.name))
      .map(({ id, name, size, sha256, createdAt, expiresAt }) => ({ id, name, size, sha256, createdAt, expiresAt }));
  }

  /** Flux déchiffré (`GET /v1/sessions/{id}/files/{fileId}`). */
  async open(sessionId: string, id: string): Promise<{ file: FileInfo; stream: Readable }> {
    const record = await this.#live(sessionId, id);
    const stream = await this.#options.store.get(record.objectKey);
    const { name, size, sha256, createdAt, expiresAt } = record;
    return { file: { id, name, size, sha256, createdAt, expiresAt }, stream };
  }

  /** Suppression anticipée (`DELETE /v1/sessions/{id}/files/{fileId}`). */
  async delete(sessionId: string, id: string): Promise<void> {
    const record = await this.#live(sessionId, id);
    await this.#options.store.delete(record.objectKey);
    await this.#index.remove(sessionId, id);
  }

  // ---------------------------------------------------------------- envois

  /**
   * Envoi (`POST /v1/sessions/{id}/uploads`, corps multipart décodé par la passerelle) : écrit dans `uploads/{fileId}.part`
   * puis renommé ; au-delà du plafond, rien ne reste. L'appelant vérifie que la session est `running`.
   */
  async upload(request: { sessionId: string; dir: SessionDir; body: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>; name?: string }): Promise<{ id: string; path: string; size: number; sha256: string; name?: string }> {
    const uploads = join(request.dir.root, 'uploads');
    await mkdir(uploads, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const path = join(uploads, id);
    const partial = `${path}.part`;
    const limit = this.#options.limits.uploadMaxBytes;
    const hash = createHash('sha256');
    let size = 0;
    const handle = await open(partial, 'wx', 0o600);
    try {
      for await (const chunk of request.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limit) throw new UploadTooLargeError(limit);
        hash.update(buffer);
        await handle.write(buffer);
      }
      await handle.close();
      await rename(partial, path);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(partial, { force: true });
      throw error;
    }
    return { id, path, size, sha256: hash.digest('hex'), ...(request.name === undefined ? {} : { name: sanitizeFileName(request.name) }) };
  }
}
