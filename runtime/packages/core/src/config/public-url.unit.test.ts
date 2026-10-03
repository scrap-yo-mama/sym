// SPDX-License-Identifier: AGPL-3.0-only
// `normalizePublicUrl` (F-20261002-12) : PUBLIC_URL ramenée à une origine pure, ou refusée. La règle porte sur la forme
// BRUTE de la valeur (après retrait des blancs autour) : la normalisation WHATWG de `new URL` ne doit pas faire passer
// un chemin (`/.`, `/%2e`, `\`) ni un caractère étranger dans l'hôte.
import { expect, test } from 'vitest';
import { normalizePublicUrl, PublicUrlError } from './public-url.js';

test('origines acceptées : point final retiré, « / » final sans effet, casse et blancs autour normalisés', () => {
  const cases: Array<[string, string]> = [
    ['https://runtime.example.org', 'https://runtime.example.org'],
    ['https://runtime.example.org/', 'https://runtime.example.org'],
    ['https://runtime.example.org.', 'https://runtime.example.org'],
    ['https://runtime.example.org./', 'https://runtime.example.org'],
    ['https://runtime.example.org.:8443', 'https://runtime.example.org:8443'],
    ['https://runtime.example.org:443', 'https://runtime.example.org'],
    ['  HTTPS://Runtime.Example.ORG.  ', 'https://runtime.example.org'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:3000/', 'http://127.0.0.1:3000'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ];
  for (const [raw, origin] of cases) expect(normalizePublicUrl(raw), raw).toBe(origin);
});

test('valeur absente ou hors http(s) : refus « manquante ou invalide »', () => {
  for (const raw of [undefined, '', '   ', 'runtime.example.org', 'ftp://runtime.example.org', 'https:/runtime.example.org']) {
    expect(() => normalizePublicUrl(raw), String(raw)).toThrow(/PUBLIC_URL manquante ou invalide/);
  }
});

test('chemin, requête, fragment, identifiants refusés, y compris sous des formes que new URL efface', () => {
  const cases: Array<[string, RegExp]> = [
    ['https://runtime.example.org/console', /chemin interdit/],
    ['https://runtime.example.org/.', /chemin interdit/],
    ['https://runtime.example.org/..', /chemin interdit/],
    ['https://runtime.example.org/%2e', /chemin interdit/],
    ['https://runtime.example.org\\', /chemin interdit/],
    ['https://runtime.example.org//', /chemin interdit/],
    ['https://runtime.example.org/?a=1', /requête interdite/],
    ['https://runtime.example.org?a=1', /requête interdite/],
    ['https://runtime.example.org?', /requête interdite/],
    ['https://runtime.example.org/#x', /fragment interdit/],
    ['https://runtime.example.org#', /fragment interdit/],
    ['https://u:p@runtime.example.org', /identifiants/],
    ['https://u@runtime.example.org', /identifiants/],
    ['https://@runtime.example.org', /identifiants/],
    ['https://runtime.example.org\\@evil.example', /identifiants|chemin interdit/],
  ];
  for (const [raw, why] of cases) {
    expect(() => normalizePublicUrl(raw), raw).toThrow(PublicUrlError);
    expect(() => normalizePublicUrl(raw), raw).toThrow(why);
  }
});

test('hôte invalide refusé : caractère étranger, blanc interne, label vide, hôte vide', () => {
  for (const raw of ['https://runtime.example.org;x', 'https://run time.example.org', 'https://run\ttime.example.org', 'https://runtime.example.org/\tx', 'https://.', 'https://a..b', 'https://runtime_x.example.org', 'https://h%2eexample.org']) {
    expect(() => normalizePublicUrl(raw), JSON.stringify(raw)).toThrow(PublicUrlError);
  }
});

test('le message ne reprend jamais la valeur (elle peut porter un mot de passe)', () => {
  for (const raw of ['https://u:zz-secret-pw@runtime.example.org', 'https://runtime.example.org/zz-secret-path', 'https://runtime.example.org/?k=zz-secret-q', 'https://runtime.example.org;zz-secret']) {
    let message = '';
    try {
      normalizePublicUrl(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, raw).toMatch(/^PUBLIC_URL/);
    expect(message, raw).not.toContain('zz-secret');
  }
});
