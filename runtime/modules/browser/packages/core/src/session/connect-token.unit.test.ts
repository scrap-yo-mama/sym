// SPDX-License-Identifier: AGPL-3.0-only
// Jetons de connexion (cdc/sym-browser 04 § 7, 04f § 3, tâche 2.3 en l'absence de 2.1) : HMAC-SHA256 sous une clé dérivée de
// MASTER_KEY, liés à une session et à un protocole, 300 s par défaut. Un jeton ouvre uniquement la session et le protocole
// qu'il nomme ; expiré, falsifié ou d'une autre instance (autre MASTER_KEY) : refusé.
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CONNECT_TOKEN_PREFIX, CONNECT_TOKEN_TTL_SECONDS, createConnectTokens, isConnectToken } from './index.js';

const SESSION = '6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11';
const OTHER = '0d3f2c1a-6b7e-4a5f-9c8d-1e2f3a4b5c6d';

describe('jetons de connexion', () => {
  test('émis puis vérifiés : session, protocole et échéance relus ; préfixe reconnaissable', () => {
    let now = 1_790_000_000_000;
    const tokens = createConnectTokens(randomBytes(32), { now: () => now });
    const token = tokens.issue({ sessionId: SESSION, protocol: 'cdp', ttlSeconds: CONNECT_TOKEN_TTL_SECONDS });
    expect(token.startsWith(CONNECT_TOKEN_PREFIX)).toBe(true);
    expect(isConnectToken(token)).toBe(true);
    expect(isConnectToken('symb_cle_api')).toBe(false);
    expect(tokens.verify(token)).toEqual({ ok: true, sessionId: SESSION, protocol: 'cdp', expiresAt: now + 300_000 });
    now += 299_999;
    expect(tokens.verify(token).ok).toBe(true);
    now += 1;
    expect(tokens.verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  test('falsifié, tronqué, d’une autre instance ou illisible : refusé', () => {
    const key = randomBytes(32);
    const tokens = createConnectTokens(key);
    const token = tokens.issue({ sessionId: SESSION, protocol: 'playwright', ttlSeconds: 60 });
    const [body = '', mac = ''] = token.slice(CONNECT_TOKEN_PREFIX.length).split('.');
    // Corps réécrit pour une autre session, signature d'origine : refusé.
    const forged = `${CONNECT_TOKEN_PREFIX}${Buffer.from(JSON.stringify({ s: OTHER, p: 'playwright', e: Date.now() + 60_000 })).toString('base64url')}.${mac}`;
    expect(tokens.verify(forged)).toEqual({ ok: false, reason: 'signature' });
    expect(tokens.verify(`${CONNECT_TOKEN_PREFIX}${body}.${mac.slice(1)}`)).toEqual({ ok: false, reason: 'signature' });
    expect(createConnectTokens(randomBytes(32)).verify(token)).toEqual({ ok: false, reason: 'signature' });
    for (const bad of ['', 'symbt_', 'symbt_abc', `symbt_${body}`, 'Bearer x', `${token}.x`]) expect(tokens.verify(bad).ok, bad).toBe(false);
  });

  test('clé maîtresse de 32 octets exigée ; clé dérivée (HKDF), jamais la clé maîtresse elle-même', () => {
    expect(() => createConnectTokens(randomBytes(16))).toThrow(/32 octets/);
    const key = Buffer.alloc(32, 7);
    const token = createConnectTokens(key).issue({ sessionId: SESSION, protocol: 'cdp', ttlSeconds: 60 });
    expect(token).not.toContain(key.toString('base64url'));
  });

  test('durée bornée : 1 s à 1 h', () => {
    const tokens = createConnectTokens(randomBytes(32));
    for (const ttlSeconds of [0, -1, 3601, 1.5]) expect(() => tokens.issue({ sessionId: SESSION, protocol: 'cdp', ttlSeconds }), String(ttlSeconds)).toThrow(/ttlSeconds/);
  });
});
