// SPDX-License-Identifier: AGPL-3.0-only
// Configuration de l'ObjectStore (cdc/sym-browser 04b § 11) : `OBJECT_STORE`, `OBJECT_DIR`, `S3_*` (+ `_FILE`),
// rétentions `SYMB_RETENTION_*` ; messages nommant la variable, jamais sa valeur secrète.
import { describe, expect, test } from 'vitest';
import { DEFAULT_RETENTION, ObjectStoreConfigError, objectStoreConfigFromEnv, retentionFromEnv } from './config.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const secret = 'zz_test_canary_s3_secret_0123456789';

describe('configuration de l’ObjectStore', () => {
  test('défaut : disk sous /data/objects', () => {
    expect(objectStoreConfigFromEnv({})).toEqual({ type: 'disk', dir: '/data/objects' });
    expect(objectStoreConfigFromEnv({ OBJECT_STORE: 'disk', OBJECT_DIR: '/srv/o' })).toEqual({ type: 'disk', dir: '/srv/o' });
  });

  test('s3 : point d’accès, seau, région, identifiants (directs ou _FILE)', () => {
    const env = { OBJECT_STORE: 's3', S3_ENDPOINT: 'http://minio:9000', S3_BUCKET: 'symb', S3_REGION: 'auto', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: secret };
    const config = objectStoreConfigFromEnv(env);
    expect(config).toMatchObject({ type: 's3', endpoint: 'http://minio:9000', bucket: 'symb', region: 'auto' });
    if (config.type !== 's3') throw new Error('s3 attendu');
    expect(config.credentials.accessKeyId).toBe('id');
    expect(config.credentials.secretAccessKey.reveal()).toBe(secret);
    expect(JSON.stringify(config)).not.toContain(secret);

    const fromFile = objectStoreConfigFromEnv(
      { OBJECT_STORE: 's3', S3_BUCKET: 'symb', S3_ACCESS_KEY_ID_FILE: '/run/secrets/id', S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/key' },
      { readFile: (p) => (p.endsWith('/id') ? 'id-from-file\n' : `${secret}\n`) },
    );
    if (fromFile.type !== 's3') throw new Error('s3 attendu');
    expect(fromFile).toMatchObject({ endpoint: undefined, region: 'us-east-1' });
    expect(fromFile.credentials.accessKeyId).toBe('id-from-file');
    expect(fromFile.credentials.secretAccessKey.reveal()).toBe(secret);
  });

  test('erreurs claires nommant la variable, sans la valeur secrète', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ OBJECT_STORE: 'ftp' }, /OBJECT_STORE/],
      [{ OBJECT_DIR: 'relatif/objets' }, /OBJECT_DIR/],
      [{ OBJECT_STORE: 's3', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: secret }, /S3_BUCKET/],
      [{ OBJECT_STORE: 's3', S3_BUCKET: 'symb', S3_SECRET_ACCESS_KEY: secret }, /S3_ACCESS_KEY_ID/],
      [{ OBJECT_STORE: 's3', S3_BUCKET: 'symb', S3_ACCESS_KEY_ID: 'id' }, /S3_SECRET_ACCESS_KEY/],
      [{ OBJECT_STORE: 's3', S3_BUCKET: 'symb', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: secret, S3_SECRET_ACCESS_KEY_FILE: '/x' }, /S3_SECRET_ACCESS_KEY_FILE/],
      [{ OBJECT_STORE: 's3', S3_BUCKET: 'symb', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: secret, S3_ENDPOINT: 'ftp://x' }, /S3_ENDPOINT/],
      [{ OBJECT_STORE: 's3', S3_BUCKET: 'symb', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: secret, S3_ENDPOINT: `https://u:${secret}@x` }, /S3_ENDPOINT/],
      [{ OBJECT_STORE: 's3', S3_BUCKET: 'B/../x', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: secret }, /S3_BUCKET/],
    ];
    for (const [env, pattern] of cases) {
      let error: unknown;
      try {
        objectStoreConfigFromEnv(env);
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(Object.keys(env))).toBeInstanceOf(ObjectStoreConfigError);
      expect((error as Error).message).toMatch(pattern);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  test('rétentions par défaut : enregistrements 7 j, téléchargements 24 h, profils sans expiration', () => {
    expect(DEFAULT_RETENTION).toEqual({ trace: 7 * DAY, har: 7 * DAY, video: 7 * DAY, console: 7 * DAY, network: 7 * DAY, download: 24 * HOUR });
    expect(retentionFromEnv({})).toEqual(DEFAULT_RETENTION);
    expect('profile' in DEFAULT_RETENTION).toBe(false);
  });

  test('rétentions réglables, entiers positifs seulement', () => {
    expect(
      retentionFromEnv({
        SYMB_RETENTION_TRACE_DAYS: '1',
        SYMB_RETENTION_HAR_DAYS: '2',
        SYMB_RETENTION_VIDEO_DAYS: '3',
        SYMB_RETENTION_LOG_DAYS: '4',
        SYMB_RETENTION_DOWNLOAD_HOURS: '5',
      }),
    ).toEqual({ trace: DAY, har: 2 * DAY, video: 3 * DAY, console: 4 * DAY, network: 4 * DAY, download: 5 * HOUR });
    for (const value of ['0', '-1', '1.5', 'abc', ' 7', '1e3']) {
      expect(() => retentionFromEnv({ SYMB_RETENTION_DOWNLOAD_HOURS: value }), value).toThrow(/SYMB_RETENTION_DOWNLOAD_HOURS/);
    }
  });
});
