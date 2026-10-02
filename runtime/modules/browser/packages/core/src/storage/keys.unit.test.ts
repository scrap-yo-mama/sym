// SPDX-License-Identifier: AGPL-3.0-only
// Clés d'objets (cdc/sym-browser 03 § 5 et § 6, 04c § 4) : `profiles/{tenantId}/{profileId}/v{n}` et
// `artifacts/{type}/{tenantId}/{sessionId}/{artifactId}` ; AAD recalculée depuis la clé, jamais lue du stockage.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { profileAad } from '../crypto/envelope.js';
import { ARTIFACT_KINDS, artifactObjectKey, InvalidObjectKeyError, objectAad, parseObjectKey, profileObjectKey } from './keys.js';

describe('clés d’objets', () => {
  const tenantId = randomUUID();
  const profileId = randomUUID();
  const sessionId = randomUUID();
  const artifactId = randomUUID();

  test('types d’artefacts de 03 § 5', () => {
    expect(ARTIFACT_KINDS).toEqual(['trace', 'har', 'video', 'console', 'network', 'download']);
  });

  test('profil : chemin de 04c § 4 et AAD `profile|tenant|profil|version` de 0.3', () => {
    const key = profileObjectKey({ tenantId, profileId, version: 3 });
    expect(key).toBe(`profiles/${tenantId}/${profileId}/v3`);
    expect(parseObjectKey(key)).toEqual({ type: 'profile', tenantId, profileId, version: 3 });
    expect(objectAad(key)).toBe(profileAad({ tenantId, profileId, version: 3 }));
  });

  test('artefact : chemin par type, AAD liée à chaque composant', () => {
    const key = artifactObjectKey({ kind: 'har', tenantId, sessionId, artifactId });
    expect(key).toBe(`artifacts/har/${tenantId}/${sessionId}/${artifactId}`);
    expect(parseObjectKey(key)).toEqual({ type: 'artifact', kind: 'har', tenantId, sessionId, artifactId });
    expect(objectAad(key)).toBe(`artifact|har|${tenantId}|${sessionId}|${artifactId}`);
    expect(objectAad(artifactObjectKey({ kind: 'trace', tenantId, sessionId, artifactId }))).not.toBe(objectAad(key));
  });

  test('clés hors format refusées (traversée, séparateurs, types inconnus)', () => {
    const bad = [
      '',
      '/etc/passwd',
      `profiles/${tenantId}/${profileId}/v-1`,
      `profiles/${tenantId}/${profileId}/v01`,
      `profiles/${tenantId}/${profileId}`,
      `profiles/../${profileId}/v1`,
      `profiles/${tenantId}/${profileId}/v1/extra`,
      `artifacts/secret/${tenantId}/${sessionId}/${artifactId}`,
      `artifacts/har/${tenantId}/${sessionId}/..`,
      `artifacts/har/${tenantId}/${sessionId}/a|b`,
      `artifacts/har/${tenantId}/${sessionId}/a.b`,
      `artifacts/har/${tenantId}//${artifactId}`,
      `artifacts\\har\\${tenantId}\\${sessionId}\\${artifactId}`,
      `other/${tenantId}`,
    ];
    for (const key of bad) expect(() => parseObjectKey(key), key).toThrow(InvalidObjectKeyError);
    expect(() => artifactObjectKey({ kind: 'har', tenantId: '..', sessionId, artifactId })).toThrow(InvalidObjectKeyError);
    expect(() => profileObjectKey({ tenantId, profileId, version: 1.5 })).toThrow(InvalidObjectKeyError);
  });
});
