// SPDX-License-Identifier: AGPL-3.0-only
// `ObjectStore` (cdc/sym-browser 03 § 6, BINV6) : put, get en flux, delete, liste, URL signée à durée limitée, purge par
// rétention. Deux implémentations du stockage brut (`BlobStore`) : `disk` (disk-store.ts) et `s3` (s3-store.ts). Chaque
// objet est chiffré par enveloppe avant d'atteindre le stockage (object-crypto.ts) : le stockage ne voit jamais un clair.
//
// URL signées : l'objet étant chiffré, une URL présignée S3 ne rendrait que du chiffré (et exposerait le seau). L'URL
// signée vise donc la route de la passerelle qui sert l'objet déchiffré (`?signed=1` de 04c § 5.1 et 04d § 2.2) : jeton
// HMAC-SHA256 (KEK `tokens` de la clé maîtresse, comme la vue en direct de 04d § 1.1) liant la clé d'objet et l'expiration,
// porté par le paramètre `t` (masqué dans les journaux, 0.3). Durée par défaut 5 min, maximum 1 h.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { type Kek, kekFor } from '../crypto/envelope.js';
import type { MasterKey } from '../crypto/master-key.js';
import { ARTIFACT_KINDS, type ArtifactKind, assertObjectKey, objectAad, parseObjectKey } from './keys.js';
import { decryptObject, encryptObject, OBJECT_CHUNK_BYTES } from './object-crypto.js';

export type BlobInfo = { key: string; size: number; lastModified: Date };

/** Stockage brut d'octets (déjà chiffrés). Écriture atomique : un objet n'est visible qu'une fois entièrement écrit. */
export interface BlobStore {
  readonly type: 'disk' | 's3';
  /** Écrit (ou remplace) l'objet ; rend le nombre d'octets stockés. Une source en échec ne laisse aucun objet. */
  put(key: string, body: AsyncIterable<Buffer>): Promise<number>;
  /** Flux des octets stockés ; `ObjectNotFoundError` si l'objet n'existe pas. */
  get(key: string): Promise<Readable>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
  /** Objets dont la clé commence par `prefix`, dans l'ordre lexicographique. */
  list(prefix: string): AsyncIterable<BlobInfo>;
}

export class ObjectNotFoundError extends Error {
  override name = 'ObjectNotFoundError';
  readonly key: string;
  constructor(key: string) {
    super(`objet introuvable : ${key}`);
    this.key = key;
  }
}

export type ObjectUrlFailure = 'invalid' | 'expired';

export class ObjectUrlError extends Error {
  override name = 'ObjectUrlError';
  readonly reason: ObjectUrlFailure;
  constructor(reason: ObjectUrlFailure) {
    super(reason === 'expired' ? 'URL signée expirée' : 'URL signée invalide');
    this.reason = reason;
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Rétention en millisecondes par type d'artefact ; les profils n'expirent pas (jamais purgés). */
export type Retention = Record<ArtifactKind, number>;

/** 03 § 6 et 04b § 11 : enregistrements 7 jours, téléchargements 24 h. */
export const DEFAULT_RETENTION: Readonly<Retention> = Object.freeze({
  trace: 7 * DAY,
  har: 7 * DAY,
  video: 7 * DAY,
  console: 7 * DAY,
  network: 7 * DAY,
  download: 24 * HOUR,
});

export const SIGNED_URL_DEFAULT_TTL_SECONDS = 300;
export const SIGNED_URL_MAX_TTL_SECONDS = 3600;

export type ObjectStoreOptions = {
  blobs: BlobStore;
  /** Clé maîtresse courante : chiffre les nouveaux objets et signe les URL. */
  master: MasterKey;
  /** Version de la clé courante (`kek_version`), écrite dans l'en-tête de chaque objet. */
  kekVersion: number;
  /** Clés précédentes encore acceptées en lecture (rotation en cours). */
  previous?: { master: MasterKey; version: number }[];
  retention?: Partial<Retention>;
  now?: () => Date;
  chunkBytes?: number;
};

export type StoredObject = { key: string; storedBytes: number; lastModified: Date };

const TOKEN = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/;

export class ObjectStore {
  readonly #blobs: BlobStore;
  readonly #current: Kek;
  readonly #keks: Map<number, Kek>;
  readonly #tokenKey: Buffer;
  readonly #retention: Retention;
  readonly #now: () => Date;
  readonly #chunkBytes: number;

  constructor(opts: ObjectStoreOptions) {
    if (!Number.isSafeInteger(opts.kekVersion) || opts.kekVersion < 1) throw new RangeError(`version de clé invalide : ${opts.kekVersion}`);
    this.#blobs = opts.blobs;
    this.#current = kekFor(opts.master, opts.kekVersion);
    this.#keks = new Map([[opts.kekVersion, this.#current]]);
    for (const p of opts.previous ?? []) if (!this.#keks.has(p.version)) this.#keks.set(p.version, kekFor(p.master, p.version));
    this.#tokenKey = opts.master.kek('tokens');
    this.#retention = { ...DEFAULT_RETENTION, ...opts.retention };
    for (const [kind, ms] of Object.entries(this.#retention)) {
      if (!Number.isSafeInteger(ms) || ms <= 0) throw new RangeError(`rétention invalide pour ${kind} : ${ms}`);
    }
    this.#now = opts.now ?? (() => new Date());
    this.#chunkBytes = opts.chunkBytes ?? OBJECT_CHUNK_BYTES;
  }

  get type(): BlobStore['type'] {
    return this.#blobs.type;
  }

  /** Chiffre et écrit `data` sous `key` ; rend la taille en clair et la taille stockée. */
  async put(key: string, data: Buffer | AsyncIterable<Buffer | Uint8Array | string>): Promise<{ key: string; size: number; storedBytes: number }> {
    const aad = objectAad(key);
    let size = 0;
    async function* counted(): AsyncGenerator<Buffer> {
      const source = Buffer.isBuffer(data) ? [data] : data;
      for await (const part of source) {
        const buf = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array | string);
        size += buf.length;
        yield buf;
      }
    }
    const storedBytes = await this.#blobs.put(key, encryptObject(counted(), this.#current, aad, { chunkBytes: this.#chunkBytes }));
    return { key, size, storedBytes };
  }

  /**
   * Flux déchiffré. L'en-tête est vérifié avant de rendre le flux : clé inconnue ou objet étranger rejettent ici
   * (`SecretDecryptError`), avant tout octet envoyé ; une altération plus loin fait échouer le flux.
   */
  async get(key: string): Promise<Readable> {
    const aad = objectAad(key);
    const raw = await this.#blobs.get(key);
    const iterator = decryptObject(raw, (v) => this.#keks.get(v), aad)[Symbol.asyncIterator]();
    let first: IteratorResult<Buffer>;
    try {
      first = await iterator.next();
    } catch (error) {
      raw.destroy();
      throw error;
    }
    async function* rest(): AsyncGenerator<Buffer> {
      if (first.done) return;
      yield first.value;
      for (let r = await iterator.next(); !r.done; r = await iterator.next()) yield r.value;
    }
    const out = Readable.from(rest(), { objectMode: false });
    out.once('close', () => raw.destroy());
    return out;
  }

  async getBuffer(key: string): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of await this.get(key)) parts.push(part as Buffer);
    return Buffer.concat(parts);
  }

  async delete(key: string): Promise<void> {
    await this.#blobs.delete(assertObjectKey(key));
  }

  /** Objets du préfixe (`''` : tous) ; les fichiers étrangers au format des clés sont ignorés. */
  async list(prefix: string): Promise<StoredObject[]> {
    checkPrefix(prefix);
    const out: StoredObject[] = [];
    for await (const blob of this.#blobs.list(prefix)) {
      if (!isObjectKey(blob.key)) continue;
      out.push({ key: blob.key, storedBytes: blob.size, lastModified: blob.lastModified });
    }
    return out;
  }

  /**
   * Purge (quotidienne) : supprime chaque artefact dont `dernière écriture + rétention de son type ≤ now`, et seulement
   * eux. Les profils (`profiles/`) et les fichiers hors format ne sont jamais touchés.
   */
  async purgeExpired(opts: { now?: Date } = {}): Promise<{ deleted: string[] }> {
    const now = (opts.now ?? this.#now()).getTime();
    const deleted: string[] = [];
    for (const kind of ARTIFACT_KINDS) {
      const ttl = this.#retention[kind];
      for await (const blob of this.#blobs.list(`artifacts/${kind}/`)) {
        if (!isObjectKey(blob.key)) continue;
        if (blob.lastModified.getTime() + ttl <= now) {
          await this.#blobs.delete(blob.key);
          deleted.push(blob.key);
        }
      }
    }
    return { deleted };
  }

  /** URL signée à durée limitée : `url` (route de la passerelle qui sert l'objet) + `t=<jeton>`. */
  signedUrl(key: string, opts: { url: string | URL; ttlSeconds?: number }): string {
    assertObjectKey(key);
    const ttl = opts.ttlSeconds ?? SIGNED_URL_DEFAULT_TTL_SECONDS;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > SIGNED_URL_MAX_TTL_SECONDS) {
      throw new RangeError(`durée d’URL signée invalide : ${ttl} s (1 à ${SIGNED_URL_MAX_TTL_SECONDS})`);
    }
    const expiresAt = this.#now().getTime() + ttl * 1000;
    const url = new URL(opts.url);
    url.searchParams.set('t', `v1.${expiresAt}.${this.#mac(expiresAt, key)}`);
    return url.toString();
  }

  /** Vérifie un jeton pour l'objet attendu (résolu par la route). `ObjectUrlError` `invalid` ou `expired`. */
  verifySignedToken(token: string, expected: { key: string }): { key: string; expiresAt: Date } {
    const match = TOKEN.exec(token);
    if (!match || !isObjectKey(expected.key)) throw new ObjectUrlError('invalid');
    const expiresAt = Number(match[1]);
    const mac = Buffer.from(this.#mac(expiresAt, expected.key));
    const given = Buffer.from(match[2]!);
    if (!Number.isSafeInteger(expiresAt) || mac.length !== given.length || !timingSafeEqual(mac, given)) throw new ObjectUrlError('invalid');
    if (this.#now().getTime() >= expiresAt) throw new ObjectUrlError('expired');
    return { key: expected.key, expiresAt: new Date(expiresAt) };
  }

  /** Vérifie le jeton puis rend le flux déchiffré de l'objet. */
  async openSigned(token: string, expected: { key: string }): Promise<Readable> {
    const { key } = this.verifySignedToken(token, expected);
    return this.get(key);
  }

  #mac(expiresAt: number, key: string): string {
    return createHmac('sha256', this.#tokenKey).update(`symb-object-url|v1|${expiresAt}|${key}`).digest('base64url');
  }
}

function isObjectKey(key: string): boolean {
  try {
    parseObjectKey(key);
    return true;
  } catch {
    return false;
  }
}

/** Préfixe de liste : vide, ou composants sûrs séparés par `/` (le dernier peut être partiel ou vide). */
export function checkPrefix(prefix: string): string {
  if (prefix === '') return prefix;
  const parts = prefix.split('/');
  if (parts.some((p, i) => (p === '' && i !== parts.length - 1) || p === '.' || p === '..' || !/^[A-Za-z0-9_-]*$/.test(p))) {
    throw new RangeError('préfixe de liste invalide');
  }
  return prefix;
}
