// SPDX-License-Identifier: AGPL-3.0-only
// Configuration de l'ObjectStore (cdc/sym-browser 04b § 11) : `OBJECT_STORE` (`disk` ou `s3`), `OBJECT_DIR`, `S3_ENDPOINT`,
// `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` et `S3_SECRET_ACCESS_KEY` (+ `_FILE`), rétentions `SYMB_RETENTION_*`.
// Chaque erreur nomme la variable ; aucune valeur d'identifiant n'apparaît dans un message. Le secret S3 reste un `Secret`.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { MasterKey } from '../crypto/master-key.js';
import { Secret } from '../crypto/redact.js';
import { DiskBlobStore } from './disk-store.js';
import { DEFAULT_RETENTION, ObjectStore, type Retention } from './object-store.js';
import { S3BlobStore } from './s3-store.js';

export { DEFAULT_RETENTION } from './object-store.js';

export class ObjectStoreConfigError extends Error {
  override name = 'ObjectStoreConfigError';
}

export type ObjectStoreConfig =
  | { type: 'disk'; dir: string }
  | {
      type: 's3';
      endpoint: string | undefined;
      bucket: string;
      region: string;
      credentials: { accessKeyId: string; secretAccessKey: Secret };
    };

type Env = Record<string, string | undefined>;
type ReadOptions = { readFile?: (path: string) => string };

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function readVariable(env: Env, name: string, opts: ReadOptions): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct && file) throw new ObjectStoreConfigError(`${name} et ${name}_FILE sont posées toutes les deux : n'en garde qu'une.`);
  if (file) {
    try {
      return (opts.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(file).replace(/\s+$/, '');
    } catch (error) {
      throw new ObjectStoreConfigError(`${name}_FILE illisible (${file}) : ${(error as NodeJS.ErrnoException).code ?? 'erreur'}.`);
    }
  }
  return direct || undefined;
}

export function objectStoreConfigFromEnv(env: Env = process.env, opts: ReadOptions = {}): ObjectStoreConfig {
  const type = env.OBJECT_STORE || 'disk';
  if (type === 'disk') {
    const dir = env.OBJECT_DIR || '/data/objects';
    if (!isAbsolute(dir)) throw new ObjectStoreConfigError('OBJECT_DIR invalide : chemin absolu attendu.');
    return { type, dir };
  }
  if (type !== 's3') throw new ObjectStoreConfigError('OBJECT_STORE invalide : `disk` ou `s3` attendu.');

  const endpoint = env.S3_ENDPOINT || undefined;
  if (endpoint !== undefined) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new ObjectStoreConfigError('S3_ENDPOINT invalide : URL http(s) attendue.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ObjectStoreConfigError('S3_ENDPOINT invalide : URL http(s) attendue.');
    if (url.username || url.password) throw new ObjectStoreConfigError('S3_ENDPOINT invalide : identifiants interdits dans l’URL (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).');
    if (url.search || url.hash) throw new ObjectStoreConfigError('S3_ENDPOINT invalide : ni paramètres ni fragment.');
  }
  const bucket = env.S3_BUCKET;
  if (!bucket) throw new ObjectStoreConfigError('S3_BUCKET manquante (OBJECT_STORE=s3).');
  if (!BUCKET.test(bucket) || bucket.includes('..')) throw new ObjectStoreConfigError('S3_BUCKET invalide : nom de seau S3 attendu (3 à 63 caractères a-z, 0-9, « . », « - »).');
  const region = env.S3_REGION || 'us-east-1';
  if (!/^[a-z0-9-]{1,32}$/.test(region)) throw new ObjectStoreConfigError('S3_REGION invalide.');
  const accessKeyId = readVariable(env, 'S3_ACCESS_KEY_ID', opts);
  if (!accessKeyId) throw new ObjectStoreConfigError('S3_ACCESS_KEY_ID manquante (ou S3_ACCESS_KEY_ID_FILE).');
  const secret = readVariable(env, 'S3_SECRET_ACCESS_KEY', opts);
  if (!secret) throw new ObjectStoreConfigError('S3_SECRET_ACCESS_KEY manquante (ou S3_SECRET_ACCESS_KEY_FILE).');
  return { type, endpoint, bucket, region, credentials: { accessKeyId, secretAccessKey: new Secret(secret) } };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const POSITIVE = /^[1-9][0-9]{0,5}$/;

/** Rétentions `SYMB_RETENTION_*` (04b § 11) ; console et réseau suivent `_LOG_DAYS`. */
export function retentionFromEnv(env: Env = process.env): Retention {
  const read = (name: string, unit: number, fallback: number): number => {
    const value = env[name];
    if (value === undefined || value === '') return fallback;
    if (!POSITIVE.test(value)) throw new ObjectStoreConfigError(`${name} invalide : entier positif attendu.`);
    return Number(value) * unit;
  };
  const logs = read('SYMB_RETENTION_LOG_DAYS', DAY, DEFAULT_RETENTION.console);
  return {
    trace: read('SYMB_RETENTION_TRACE_DAYS', DAY, DEFAULT_RETENTION.trace),
    har: read('SYMB_RETENTION_HAR_DAYS', DAY, DEFAULT_RETENTION.har),
    video: read('SYMB_RETENTION_VIDEO_DAYS', DAY, DEFAULT_RETENTION.video),
    console: logs,
    network: logs,
    download: read('SYMB_RETENTION_DOWNLOAD_HOURS', HOUR, DEFAULT_RETENTION.download),
  };
}

/** Fabrique l'ObjectStore de l'instance depuis sa configuration et sa clé maîtresse. */
export function createObjectStore(
  config: ObjectStoreConfig,
  keys: { master: MasterKey; kekVersion: number; previous?: { master: MasterKey; version: number }[] },
  opts: { retention?: Retention } = {},
): ObjectStore {
  const blobs = config.type === 'disk' ? new DiskBlobStore(config.dir) : new S3BlobStore(config);
  return new ObjectStore({ blobs, ...keys, ...(opts.retention ? { retention: opts.retention } : {}) });
}
