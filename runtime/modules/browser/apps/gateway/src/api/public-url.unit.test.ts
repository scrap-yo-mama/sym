// SPDX-License-Identifier: AGPL-3.0-only
// Base publique des `connectUrls` lue sur la demande (04 § 8, tâche 5.1) : hôte de la demande, schéma du proxy, repli sinon.
import { describe, expect, test } from 'vitest';
import { publicUrlFromRequest } from './public-url.js';

const fallback = () => 'http://127.0.0.1:3000';
const base = (headers: Record<string, string | undefined>) => publicUrlFromRequest({ headers }, fallback);

describe('publicUrlFromRequest', () => {
  test('hôte de la demande, port compris ; http par défaut', () => {
    expect(base({ host: '127.0.0.1:49153' })).toBe('http://127.0.0.1:49153');
    expect(base({ host: 'browser.example.com' })).toBe('http://browser.example.com');
    expect(base({ host: '[::1]:3000' })).toBe('http://[::1]:3000');
  });

  test('X-Forwarded-Proto https (reverse proxy TLS, plateforme) : https ; toute autre valeur : http', () => {
    expect(base({ host: 'b.example.com', 'x-forwarded-proto': 'https' })).toBe('https://b.example.com');
    expect(base({ host: 'b.example.com', 'x-forwarded-proto': 'https, http' })).toBe('https://b.example.com');
    expect(base({ host: 'b.example.com', 'x-forwarded-proto': 'javascript' })).toBe('http://b.example.com');
  });

  test('Host absent ou hors forme : base de repli (aucun chemin, identifiant ni espace repris)', () => {
    for (const host of [undefined, '', 'evil.com/x', 'user@evil.com', 'a b', 'evil.com:99999', 'evil.com:3000?t=', '-bad.example']) {
      expect(base({ host }), String(host)).toBe('http://127.0.0.1:3000');
    }
  });
});
