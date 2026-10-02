// SPDX-License-Identifier: AGPL-3.0-only
// Signature AWS SigV4 du client S3 minimal : exemples publiés par AWS (« Signature Calculations for the Authorization
// Header », API S3), identifiants d'exemple de la documentation (aucun secret réel).
import { describe, expect, test } from 'vitest';
import { EMPTY_SHA256, signS3Request } from './s3-sigv4.js';

const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const date = new Date('2013-05-24T00:00:00Z');
const base = { credentials, region: 'us-east-1', date };
const signature = (authorization: string) => /Signature=([0-9a-f]{64})$/.exec(authorization)?.[1];

describe('SigV4 (vecteurs de la documentation AWS)', () => {
  test('GET objet avec Range', () => {
    const headers = signS3Request({
      ...base,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
    });
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers['x-amz-content-sha256']).toBe(EMPTY_SHA256);
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  test('PUT objet (chemin encodé, en-têtes supplémentaires)', () => {
    const headers = signS3Request({
      ...base,
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    });
    expect(signature(headers.authorization!)).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  test('GET avec sous-ressource sans valeur (?lifecycle)', () => {
    const headers = signS3Request({ ...base, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'), headers: {}, payloadHash: EMPTY_SHA256 });
    expect(signature(headers.authorization!)).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  test('GET liste avec paramètres triés (?max-keys=2&prefix=J)', () => {
    const headers = signS3Request({
      ...base,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
      headers: {},
      payloadHash: EMPTY_SHA256,
    });
    expect(signature(headers.authorization!)).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  test('le secret n’apparaît dans aucun en-tête produit', () => {
    const headers = signS3Request({ ...base, method: 'GET', url: new URL('http://127.0.0.1:9000/b/k'), headers: {}, payloadHash: EMPTY_SHA256 });
    expect(JSON.stringify(headers)).not.toContain(credentials.secretAccessKey);
    expect(headers.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
  });
});
