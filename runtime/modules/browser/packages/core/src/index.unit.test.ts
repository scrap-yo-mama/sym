// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'vitest';
import { isServiceMode, SERVICE_MODES } from './index.js';

describe('@sym-browser/core (squelette)', () => {
  test('trois modes de déploiement : all, gateway, node', () => {
    expect(SERVICE_MODES).toEqual(['all', 'gateway', 'node']);
  });

  test('isServiceMode refuse toute autre valeur', () => {
    for (const mode of SERVICE_MODES) expect(isServiceMode(mode)).toBe(true);
    for (const value of ['ALL', 'server', 'worker', '', undefined, 1]) expect(isServiceMode(value)).toBe(false);
  });
});

describe('@sym-browser/core : ObjectStore (tâche 3.0) exporté par le paquet', () => {
  test('implémentations disk et s3, fabrique depuis la configuration', async () => {
    const core = await import('./index.js');
    for (const name of ['ObjectStore', 'DiskBlobStore', 'S3BlobStore', 'createObjectStore', 'objectStoreConfigFromEnv', 'retentionFromEnv']) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});
