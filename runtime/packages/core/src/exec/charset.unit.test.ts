// SPDX-License-Identifier: AGPL-3.0-only
// Banc réel R08 (passage 2) : une page Windows-1252 décodée comme de l'UTF-8 (664 lignes sur 1437 aux accents détruits).
// Le jeu de caractères est lu dans l'ordre : BOM, en-tête `Content-Type`, `<meta charset>` ou `http-equiv`, puis détection.
import { describe, expect, it } from 'vitest';
import { decodeBody, readCharset } from './charset.js';
import { fetchTransport } from './fetch.js';

type Session = Parameters<typeof fetchTransport>[0];

const TEXT = 'ÉTUDES SUPÉRIEURES : salon de l’été à Dôle';
/** Octets Windows-1252 de `TEXT` (le guillemet typographique ’ vaut 0x92). */
const cp1252 = (text: string): Uint8Array => Uint8Array.from(Array.from(text, (c) => (c === '’' ? 0x92 : c.charCodeAt(0))));
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const page = (head: string, text: string): Uint8Array => cp1252(`<html><head>${head}</head><body><td>${text}</td></body></html>`);

describe('decodeBody : jeu de caractères d’un corps reçu', () => {
  it('en-tête Content-Type : charset=windows-1252 ou iso-8859-1 (alias du navigateur)', () => {
    expect(decodeBody(cp1252(TEXT), 'text/html; charset=windows-1252')).toBe(TEXT);
    expect(decodeBody(cp1252(TEXT), 'text/html; charset="ISO-8859-1"')).toBe(TEXT);
  });

  it('l’en-tête l’emporte sur la balise meta', () => {
    expect(decodeBody(page('<meta charset="utf-8">', TEXT), 'text/html; charset=windows-1252')).toContain(TEXT);
  });

  it('sans charset d’en-tête : <meta charset> puis <meta http-equiv="Content-Type">', () => {
    expect(decodeBody(page('<meta charset="windows-1252">', TEXT), 'text/html')).toContain(TEXT);
    expect(decodeBody(page('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-15">', 'SUPÉRIEURES'), undefined)).toContain('SUPÉRIEURES');
  });

  it('sans aucune déclaration : UTF-8 valide gardé, sinon repli Windows-1252 (détection)', () => {
    expect(decodeBody(utf8(`<html><body>${TEXT}</body></html>`), 'text/html')).toContain(TEXT);
    expect(decodeBody(page('', TEXT), 'text/html')).toContain(TEXT);
  });

  it('JSON : UTF-8 par défaut, jamais détecté ni lu dans une balise', () => {
    const body = utf8(JSON.stringify({ nom: TEXT }));
    expect(decodeBody(body, 'application/json')).toBe(JSON.stringify({ nom: TEXT }));
    expect(decodeBody(utf8('{"meta":"<meta charset=windows-1252>","nom":"é"}'), 'application/json')).toContain('"é"');
  });

  it('BOM UTF-8 retiré ; charset inconnu ignoré (détection)', () => {
    expect(decodeBody(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('é')]), 'text/html')).toBe('é');
    expect(decodeBody(cp1252(TEXT), 'text/html; charset=pas-un-charset')).toBe(TEXT);
  });

  it('readCharset : étiquette normalisée ou null', () => {
    expect(readCharset('text/html; charset=UTF-8')).toBe('utf-8');
    expect(readCharset('text/html; charset=latin1')).toBe('windows-1252');
    expect(readCharset('text/html')).toBeNull();
  });
});

describe('fetchTransport : le corps est décodé selon le charset reçu (E1, rejeu)', () => {
  it('page Windows-1252 : accents conservés, plus de caractère de remplacement', async () => {
    const session = { fetch: async () => new Response(Buffer.from(page('', TEXT)), { status: 200, headers: { 'content-type': 'text/html; charset=windows-1252' } }) } as unknown as Session;
    const exchange = await fetchTransport(session, { maxResponseBytes: 1_000_000, timeoutMs: 1000 })({ method: 'GET', url: 'http://zz_test_cp1252.localhost/', headers: {} }, new AbortController().signal);
    expect(exchange.body).toContain(TEXT);
    expect(exchange.body).not.toContain('\uFFFD');
  });

  it('page Windows-1252 sans charset d’en-tête, déclarée dans la balise meta', async () => {
    const session = { fetch: async () => new Response(Buffer.from(page('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">', TEXT)), { status: 200, headers: { 'content-type': 'text/html' } }) } as unknown as Session;
    const exchange = await fetchTransport(session, { maxResponseBytes: 1_000_000, timeoutMs: 1000 })({ method: 'GET', url: 'http://zz_test_cp1252.localhost/', headers: {} }, new AbortController().signal);
    expect(exchange.body).toContain(TEXT);
  });
});
