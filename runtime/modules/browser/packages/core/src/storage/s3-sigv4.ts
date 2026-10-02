// SPDX-License-Identifier: AGPL-3.0-only
// Signature AWS Signature Version 4 des requêtes S3 (en-tête `Authorization`), `node:crypto` seul. Référence : AWS,
// « Authenticating Requests: Using the Authorization Header (AWS Signature Version 4) », API Amazon S3.
import { createHash, createHmac } from 'node:crypto';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export type SigV4Credentials = { accessKeyId: string; secretAccessKey: string };

export type SigV4Request = {
  method: string;
  url: URL;
  /** En-têtes à signer en plus de `host`, `x-amz-date` et `x-amz-content-sha256` (noms en minuscules). */
  headers: Record<string, string>;
  /** sha256 hexadécimal du corps (`EMPTY_SHA256` sans corps). */
  payloadHash: string;
  credentials: SigV4Credentials;
  region: string;
  date: Date;
  service?: string;
};

export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** Encodage URI de SigV4 : tout sauf les caractères non réservés de la RFC 3986 ; `/` conservé dans le chemin. */
export function uriEncode(value: string, keepSlash = false): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([uriEncode(k), uriEncode(v)]);
  pairs.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** Rend les en-têtes à envoyer : ceux donnés + `x-amz-date`, `x-amz-content-sha256` et `authorization`. */
export function signS3Request(req: SigV4Request): Record<string, string> {
  const service = req.service ?? 's3';
  const amzDate = req.date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = value;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = req.payloadHash;
  const signed: Record<string, string> = { ...headers, host: req.url.host };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  // Chemin déjà encodé par URL (WHATWG) : on le décode puis on le ré-encode selon SigV4 (S3 : un seul encodage).
  const path = uriEncode(decodeURIComponent(req.url.pathname || '/'), true);
  const canonicalRequest = [req.method, path, canonicalQuery(req.url), canonicalHeaders, signedHeaders, req.payloadHash].join('\n');
  const scope = `${day}/${req.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${req.credentials.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, req.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${req.credentials.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return headers;
}
