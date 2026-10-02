// SPDX-License-Identifier: AGPL-3.0-only
// Coffre des enregistrements (04d § 2.1 et § 2.2, 03 § 6) : chaque artefact est chiffré par enveloppe dans l'ObjectStore
// (`artifacts/{type}/{tenant}/{session}/{id}`, tâche 3.0), indexé (forme de la table `artifacts` de 0.2), annoncé par
// `recording.ready {recordingId, type, size, expiresAt}` (précédé de `recording.truncated {type}` s'il a été tronqué), puis
// supprimé du disque du nœud. Liste, flux déchiffré et suppression pour l'API (`/v1/sessions/{id}/recordings`, passerelle) ;
// purge des enregistrements dont l'expiration est passée (rétention par type, horloge injectable).
// Index en mémoire ici ; la version PostgreSQL (table `artifacts`) vient avec l'accès du nœud à la base (tâche 1.2).
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { RecordingType } from '@sym/contracts/browser';
import { DEFAULT_RETENTION, artifactObjectKey, type ObjectStore } from '@sym-browser/core';

export type RecordingInfo = { id: string; type: RecordingType; name: string; size: number; createdAt: Date; expiresAt: Date };
export type RecordingRecord = RecordingInfo & { sessionId: string; tenantId: string; objectKey: string };

export type RecordingEvent =
  | { type: 'recording.ready'; sessionId: string; recordingId: string; recordingType: RecordingType; size: number; expiresAt: string }
  | { type: 'recording.truncated'; sessionId: string; recordingType: RecordingType };

export interface RecordingIndex {
  insert(record: RecordingRecord): Promise<void>;
  /** Toutes les lignes (purge) ou celles d'une session. */
  list(sessionId?: string): Promise<RecordingRecord[]>;
  remove(id: string): Promise<void>;
}

export class MemoryRecordingIndex implements RecordingIndex {
  readonly #rows = new Map<string, RecordingRecord>();
  insert(record: RecordingRecord): Promise<void> {
    this.#rows.set(record.id, { ...record });
    return Promise.resolve();
  }
  list(sessionId?: string): Promise<RecordingRecord[]> {
    return Promise.resolve([...this.#rows.values()].filter((r) => sessionId === undefined || r.sessionId === sessionId).map((r) => ({ ...r })));
  }
  remove(id: string): Promise<void> {
    this.#rows.delete(id);
    return Promise.resolve();
  }
}

export class RecordingNotFoundError extends Error {
  override name = 'RecordingNotFoundError';
  readonly code = 'recording_not_found';
  readonly status = 404;
}

/** Rétention par type (`SYMB_RETENTION_TRACE_DAYS`, `_HAR_DAYS`, `_VIDEO_DAYS`, `_LOG_DAYS`) : 7 jours par défaut. */
export type RecordingRetention = Record<RecordingType, number>;

export type RecordingVaultOptions = {
  store: ObjectStore;
  index?: RecordingIndex;
  retention?: Partial<RecordingRetention>;
  now?: () => Date;
  onEvent?: (event: RecordingEvent) => void;
};

const pick = ({ id, type, name, size, createdAt, expiresAt }: RecordingRecord): RecordingInfo => ({ id, type, name, size, createdAt, expiresAt });

export class RecordingVault {
  readonly #options: RecordingVaultOptions;
  readonly #index: RecordingIndex;
  readonly #retention: RecordingRetention;

  constructor(options: RecordingVaultOptions) {
    this.#options = options;
    this.#index = options.index ?? new MemoryRecordingIndex();
    this.#retention = { trace: DEFAULT_RETENTION.trace, har: DEFAULT_RETENTION.har, video: DEFAULT_RETENTION.video, console: DEFAULT_RETENTION.console, network: DEFAULT_RETENTION.network, ...options.retention };
    for (const [type, value] of Object.entries(this.#retention)) if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`rétention invalide pour ${type} : ${value}`);
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  /** Signale un enregistrement tronqué qui n'a pas pu être déposé (trace au-delà du plafond). */
  truncated(sessionId: string, type: RecordingType): void {
    this.#options.onEvent?.({ type: 'recording.truncated', sessionId, recordingType: type });
  }

  async deposit(request: { sessionId: string; tenantId: string; type: RecordingType; path: string; name: string; truncated?: boolean }): Promise<RecordingInfo> {
    const id = randomUUID();
    const objectKey = artifactObjectKey({ kind: request.type, tenantId: request.tenantId, sessionId: request.sessionId, artifactId: id });
    try {
      const { size } = await this.#options.store.put(objectKey, createReadStream(request.path));
      const createdAt = this.#now();
      const record: RecordingRecord = { id, type: request.type, name: request.name, size, createdAt, expiresAt: new Date(createdAt.getTime() + this.#retention[request.type]), sessionId: request.sessionId, tenantId: request.tenantId, objectKey };
      await this.#index.insert(record);
      if (request.truncated === true) this.truncated(request.sessionId, request.type);
      this.#options.onEvent?.({ type: 'recording.ready', sessionId: request.sessionId, recordingId: id, recordingType: request.type, size, expiresAt: record.expiresAt.toISOString() });
      return pick(record);
    } catch (error) {
      await this.#options.store.delete(objectKey).catch(() => undefined);
      throw error;
    } finally {
      await rm(request.path, { force: true });
    }
  }

  async #live(sessionId: string, id: string): Promise<RecordingRecord> {
    const record = (await this.#index.list(sessionId)).find((r) => r.id === id);
    if (record === undefined || record.expiresAt.getTime() <= this.#now().getTime()) throw new RecordingNotFoundError(`Enregistrement ${id} introuvable pour la session ${sessionId}.`);
    return record;
  }

  /** `GET /v1/sessions/{id}/recordings` : enregistrements non expirés, du plus ancien au plus récent. */
  async list(sessionId: string): Promise<RecordingInfo[]> {
    const now = this.#now().getTime();
    return (await this.#index.list(sessionId))
      .filter((r) => r.expiresAt.getTime() > now)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.type.localeCompare(b.type))
      .map(pick);
  }

  /** `GET /v1/sessions/{id}/recordings/{rid}` : flux déchiffré. */
  async open(sessionId: string, id: string): Promise<{ recording: RecordingInfo; stream: Readable }> {
    const record = await this.#live(sessionId, id);
    return { recording: pick(record), stream: await this.#options.store.get(record.objectKey) };
  }

  /** `DELETE /v1/sessions/{id}/recordings/{rid}`. */
  async delete(sessionId: string, id: string): Promise<void> {
    const record = await this.#live(sessionId, id);
    await this.#options.store.delete(record.objectKey);
    await this.#index.remove(id);
  }

  /** Purge (quotidienne) : objets et lignes des enregistrements expirés, et seulement eux. */
  async purgeExpired(): Promise<{ deleted: string[] }> {
    const now = this.#now().getTime();
    const deleted: string[] = [];
    for (const record of await this.#index.list()) {
      if (record.expiresAt.getTime() > now) continue;
      await this.#options.store.delete(record.objectKey);
      await this.#index.remove(record.id);
      deleted.push(record.objectKey);
    }
    return { deleted };
  }
}
