// SPDX-License-Identifier: AGPL-3.0-only
// Verrou de domaines (1.6), portée de site de la reconnaissance (2.1, correctif 7) : les suffixes ne sont admis que par
// une option explicite du code (jamais par une chaîne d'`allowed_hosts`), la comparaison des hôtes reste exacte sinon.
import { describe, expect, test } from 'vitest';
import { createStaticAssetAllowance, domainLock } from './domain-lock.js';

describe('verrou de domaines', () => {
  test('hôtes exacts : un sous-domaine ou une chaîne joker ne passent pas', () => {
    const lock = domainLock(['www.exemple.test', '*.exemple.test', '.exemple.test']);
    expect(lock('www.exemple.test')).toBe(true);
    expect(lock('WWW.exemple.test.')).toBe(true);
    expect(lock('api.exemple.test')).toBe(false);
    expect(lock('exemple.test')).toBe(false);
  });

  test('portée de site explicite : le domaine et ses sous-domaines, jamais un voisin ni un domaine qui le prolonge', () => {
    const lock = domainLock(['www.exemple.test'], ['exemple.test']);
    expect(lock('api.exemple.test')).toBe(true);
    expect(lock('exemple.test')).toBe(true);
    expect(lock('a.b.exemple.test')).toBe(true);
    expect(lock('evilexemple.test')).toBe(false);
    expect(lock('exemple.test.evil.test')).toBe(false);
    expect(lock('autre.test')).toBe(false);
  });
});

describe('createStaticAssetAllowance (reconnaissance, banc R05)', () => {
  test('assert_recon_static_assets_only — script et feuille de style en GET seulement ; jamais XHR, fetch, image, document ni POST', () => {
    const allow = createStaticAssetAllowance();
    expect(allow.admit('https://cdn.zz-test.example/app.js', 'script', 'GET')).toBe(true);
    expect(allow.admit('https://cdn.zz-test.example/app.css', 'Stylesheet', 'GET')).toBe(true);
    for (const type of ['xhr', 'fetch', 'image', 'document', 'websocket', 'ping', 'other', 'font', 'media']) expect(allow.admit('https://cdn.zz-test.example/x', type, 'GET')).toBe(false);
    expect(allow.admit('https://cdn.zz-test.example/app.js', 'script', 'POST')).toBe(false);
    expect(allow.admit('https://user:pw@cdn.zz-test.example/app.js', 'script', 'GET')).toBe(false);
    expect(allow.admit('ftp://cdn.zz-test.example/app.js', 'script', 'GET')).toBe(false);
    expect(allow.has('CDN.zz-test.example.')).toBe(true);
    expect(allow.has('evil.zz-test.example')).toBe(false);
    expect(allow.usage()).toEqual({ hosts: 1, requests: 2 });
  });

  test('plafonds : hôtes tiers distincts et requêtes de la passe', () => {
    const allow = createStaticAssetAllowance({ maxHosts: 2, maxRequests: 3 });
    expect(allow.admit('https://a.zz-test.example/1.js', 'script', 'GET')).toBe(true);
    expect(allow.admit('https://b.zz-test.example/1.js', 'script', 'GET')).toBe(true);
    expect(allow.admit('https://c.zz-test.example/1.js', 'script', 'GET')).toBe(false);
    expect(allow.has('c.zz-test.example')).toBe(false);
    expect(allow.admit('https://a.zz-test.example/2.js', 'script', 'GET')).toBe(true);
    expect(allow.admit('https://a.zz-test.example/3.js', 'script', 'GET')).toBe(false);
  });
});
