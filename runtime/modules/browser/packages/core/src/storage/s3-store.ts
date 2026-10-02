// SPDX-License-Identifier: AGPL-3.0-only
// Stockage brut `s3` (cdc/sym-browser 03 § 6, 04b § 11 `S3_*`) : client S3 minimal sur `fetch` et `node:crypto` (SigV4,
// s3-sigv4.ts), sans SDK. Opérations : PutObject (objet < une partie), envoi en plusieurs parties au-delà (parties de
// 8 Mio en mémoire, abandon sur échec : aucun objet partiel), GetObject en flux, DeleteObject, ListObjectsV2 paginé.
// Adressage par chemin quand `endpoint` est donné (MinIO, R2), par hôte virtuel AWS sinon. Les messages d'erreur citent
// la méthode, la clé, le statut et le code S3, jamais un identifiant.
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { Secret } from '../crypto/redact.js';
import { assertObjectKey } from './keys.js';
import { type BlobInfo, type BlobStore, checkPrefix, ObjectNotFoundError } from './object-store.js';
import { EMPTY_SHA256, sha256Hex, signS3Request, uriEncode } from './s3-sigv4.js';

/** Taille minimale d'une partie (sauf la dernière) imposée par S3. */
export const S3_MIN_PART_BYTES = 5 * 1024 * 1024;
const DEFAULT_PART_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

export type S3Options = {
  /** Point d'accès S3 compatible (`http(s)://hôte[:port]`) ; absent : AWS (`https://{seau}.s3.{région}.amazonaws.com`). */
  endpoint?: string | undefined;
  bucket: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: Secret };
  /** Taille des pages de ListObjectsV2 (1 à 1000). */
  pageSize?: number;
  /** Taille des parties d'un envoi en plusieurs parties (≥ 5 Mio). */
  partBytes?: number;
  fetch?: typeof fetch;
};

export class S3Error extends Error {
  override name = 'S3Error';
  readonly method: string;
  readonly target: string;
  readonly status: number;
  readonly code: string | undefined;
  constructor(method: string, target: string, status: number, code: string | undefined) {
    super(`S3 ${method} ${target} : HTTP ${status}${code ? ` (${code})` : ''}`);
    this.method = method;
    this.target = target;
    this.status = status;
    this.code = code;
  }
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlDecode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : XML_ENTITIES[e]!,
  );
const xmlEncode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlDecode(m[1]!) : undefined;
};
const blocks = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]!);

type RequestOptions = { query?: Record<string, string>; headers?: Record<string, string>; body?: Buffer; stream?: boolean; ok?: number[] };

export class S3BlobStore implements BlobStore {
  readonly type = 's3' as const;
  readonly #opts: S3Options;
  readonly #base: URL;
  readonly #pathStyle: boolean;
  readonly #pageSize: number;
  readonly #partBytes: number;
  readonly #fetch: typeof fetch;

  constructor(opts: S3Options) {
    this.#opts = opts;
    this.#pathStyle = opts.endpoint !== undefined && opts.endpoint !== '';
    this.#base = new URL(this.#pathStyle ? opts.endpoint! : `https://${opts.bucket}.s3.${opts.region}.amazonaws.com`);
    this.#pageSize = opts.pageSize ?? 1000;
    this.#partBytes = opts.partBytes ?? DEFAULT_PART_BYTES;
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 1000) throw new RangeError('pageSize : 1 à 1000');
    if (!Number.isSafeInteger(this.#partBytes) || this.#partBytes < S3_MIN_PART_BYTES) throw new RangeError('partBytes : 5 Mio au moins');
    this.#fetch = opts.fetch ?? fetch;
  }

  #url(key: string, query: Record<string, string> = {}): URL {
    const basePath = this.#base.pathname.replace(/\/+$/, '');
    // Clé vide : requête sur le seau (création, liste).
    const objectPath = key === '' ? '' : `/${uriEncode(key, true)}`;
    const path = this.#pathStyle ? `${basePath}/${uriEncode(this.#opts.bucket)}${objectPath}` : `${basePath}${objectPath || '/'}`;
    const url = new URL(this.#base.origin);
    url.pathname = path;
    for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v);
    // `?uploads` sans valeur : URLSearchParams écrit `uploads=`, accepté et signé à l'identique (SigV4 : `uploads=`).
    return url;
  }

  async #request(method: string, key: string, opts: RequestOptions = {}): Promise<Response> {
    const url = this.#url(key, opts.query);
    const headers = signS3Request({
      method,
      url,
      headers: opts.headers ?? {},
      payloadHash: opts.body ? sha256Hex(opts.body) : EMPTY_SHA256,
      credentials: { accessKeyId: this.#opts.credentials.accessKeyId, secretAccessKey: this.#opts.credentials.secretAccessKey.reveal() },
      region: this.#opts.region,
      date: new Date(),
    });
    const init: RequestInit = { method, headers, redirect: 'error' };
    if (opts.body) init.body = opts.body;
    if (!opts.stream) init.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await this.#fetch(url, init);
    if (!(opts.ok ?? [200]).includes(res.status)) {
      const text = await res.text().catch(() => '');
      throw new S3Error(method, key || this.#opts.bucket, res.status, tag(text, 'Code'));
    }
    return res;
  }

  /** Crée le seau (tests, installation) ; déjà possédé : sans effet. */
  async createBucket(): Promise<void> {
    const body =
      this.#opts.region === 'us-east-1' || this.#pathStyle
        ? undefined
        : Buffer.from(`<CreateBucketConfiguration><LocationConstraint>${xmlEncode(this.#opts.region)}</LocationConstraint></CreateBucketConfiguration>`);
    try {
      const res = await this.#request('PUT', '', body ? { body } : {});
      await res.arrayBuffer();
    } catch (error) {
      if (error instanceof S3Error && error.code === 'BucketAlreadyOwnedByYou') return;
      throw error;
    }
  }

  async put(key: string, body: AsyncIterable<Buffer>): Promise<number> {
    assertObjectKey(key);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let total = 0;
    let uploadId: string | undefined;
    const parts: { number: number; etag: string }[] = [];

    const uploadPart = async () => {
      const data = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      const number = parts.length + 1;
      const res = await this.#request('PUT', key, { query: { partNumber: String(number), uploadId: uploadId! }, body: data });
      await res.arrayBuffer();
      const etag = res.headers.get('etag');
      if (!etag) throw new S3Error('PUT', key, res.status, 'MissingETag');
      parts.push({ number, etag });
    };

    try {
      for await (const part of body) {
        pending.push(part);
        pendingBytes += part.length;
        total += part.length;
        if (pendingBytes >= this.#partBytes) {
          if (uploadId === undefined) {
            const res = await this.#request('POST', key, { query: { uploads: '' } });
            uploadId = tag(await res.text(), 'UploadId');
            if (!uploadId) throw new S3Error('POST', key, res.status, 'MissingUploadId');
          }
          await uploadPart();
        }
      }
      if (uploadId === undefined) {
        const res = await this.#request('PUT', key, { body: Buffer.concat(pending, pendingBytes) });
        await res.arrayBuffer();
        return total;
      }
      if (pendingBytes > 0) await uploadPart();
      const xml =
        '<CompleteMultipartUpload>' +
        parts.map((p) => `<Part><PartNumber>${p.number}</PartNumber><ETag>${xmlEncode(p.etag)}</ETag></Part>`).join('') +
        '</CompleteMultipartUpload>';
      const res = await this.#request('POST', key, { query: { uploadId }, body: Buffer.from(xml) });
      const text = await res.text();
      // S3 peut répondre 200 avec une erreur dans le corps (échec tardif de la complétion).
      if (text.includes('<Error>')) throw new S3Error('POST', key, res.status, tag(text, 'Code'));
      uploadId = undefined;
      return total;
    } catch (error) {
      if (uploadId !== undefined) {
        await this.#request('DELETE', key, { query: { uploadId }, ok: [204, 200, 404] })
          .then((r) => r.arrayBuffer())
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async get(key: string): Promise<Readable> {
    assertObjectKey(key);
    try {
      const res = await this.#request('GET', key, { stream: true });
      if (!res.body) return Readable.from([]);
      return Readable.fromWeb(res.body as ReadableStream<Uint8Array>);
    } catch (error) {
      if (error instanceof S3Error && error.status === 404) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    const res = await this.#request('DELETE', key, { ok: [204, 200, 404] });
    await res.arrayBuffer();
  }

  async *list(prefix: string): AsyncGenerator<BlobInfo> {
    checkPrefix(prefix);
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': String(this.#pageSize) };
      if (token) query['continuation-token'] = token;
      const xml = await (await this.#request('GET', '', { query })).text();
      for (const block of blocks(xml, 'Contents')) {
        const key = tag(block, 'Key');
        const lastModified = tag(block, 'LastModified');
        if (key === undefined || lastModified === undefined) continue;
        yield { key, size: Number(tag(block, 'Size') ?? 0), lastModified: new Date(lastModified) };
      }
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
    } while (token);
  }

  /** Envois en plusieurs parties encore ouverts pour `key` (contrôle d'abandon). */
  async pendingUploads(key: string): Promise<string[]> {
    const xml = await (await this.#request('GET', '', { query: { uploads: '', prefix: key } })).text();
    return blocks(xml, 'Upload')
      .filter((b) => tag(b, 'Key') === key)
      .map((b) => tag(b, 'UploadId')!)
      .filter(Boolean);
  }
}
