// SPDX-License-Identifier: AGPL-3.0-only
// Jetons de connexion (cdc/sym-browser 04 § 7, 04f § 3, tâche 2.1) : HMAC-SHA256 sous une clé dérivée de MASTER_KEY, liés à
// une session et à un protocole, 300 s par défaut ; préfixe `symt_` qui les distingue des clés d'API (`symb_`).
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { generateMasterKey, MasterKey } from '../crypto/master-key.js';
import { CONNECT_PROTOCOLS, CONNECT_TOKEN_PREFIX, CONNECT_TOKEN_TTL_SECONDS, ConnectTokens } from './index.js';

const key = () => MasterKey.parse(generateMasterKey());
const T0 = Date.parse('2026-10-02T12:00:00Z');

function clock(start = T0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('ConnectTokens', () => {
  test('300 s par défaut, protocoles playwright, cdp et live', () => {
    expect(CONNECT_TOKEN_TTL_SECONDS).toBe(300);
    expect(CONNECT_PROTOCOLS).toEqual(['playwright', 'cdp', 'live']);
    expect(CONNECT_TOKEN_PREFIX).toBe('symt_');
  });

  test('émis puis vérifié : session, protocole et échéance rendus ; format URL-safe à préfixe symt_', () => {
    const c = clock();
    const tokens = new ConnectTokens({ current: key() }, { now: c.now });
    const sessionId = randomUUID();
    const token = tokens.issue({ sessionId, protocol: 'cdp' });
    expect(token).toMatch(/^symt_[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
    expect(tokens.verify(token, { sessionId, protocol: 'cdp' })).toEqual({ ok: true, sessionId, protocol: 'cdp', expiresAt: new Date(T0 + 300_000) });
    expect(tokens.issue({ sessionId, protocol: 'cdp' })).not.toBe(token);
  });

  test('expiré à 300 s exactement, valide juste avant', () => {
    const c = clock();
    const tokens = new ConnectTokens({ current: key() }, { now: c.now });
    const sessionId = randomUUID();
    const token = tokens.issue({ sessionId, protocol: 'playwright' });
    c.advance(299_999);
    expect(tokens.verify(token, { sessionId, protocol: 'playwright' }).ok).toBe(true);
    c.advance(1);
    expect(tokens.verify(token, { sessionId, protocol: 'playwright' })).toEqual({ ok: false, reason: 'expired' });
  });

  test('durée choisie entre 1 s et 1 h, sinon refus à l’émission', () => {
    const tokens = new ConnectTokens({ current: key() });
    const sessionId = randomUUID();
    expect(() => tokens.issue({ sessionId, protocol: 'live', ttlSeconds: 3600 })).not.toThrow();
    for (const ttlSeconds of [0, -1, 3601, 1.5, Number.NaN]) {
      expect(() => tokens.issue({ sessionId, protocol: 'live', ttlSeconds }), String(ttlSeconds)).toThrow(/ttl|durée/i);
    }
    expect(() => tokens.issue({ sessionId: '', protocol: 'cdp' })).toThrow();
    expect(() => tokens.issue({ sessionId, protocol: 'bidi' as never })).toThrow();
  });

  test('jeton d’une autre session ou d’un autre protocole : refusé', () => {
    const tokens = new ConnectTokens({ current: key() });
    const sessionId = randomUUID();
    const token = tokens.issue({ sessionId, protocol: 'playwright' });
    expect(tokens.verify(token, { sessionId: randomUUID(), protocol: 'playwright' })).toEqual({ ok: false, reason: 'wrong_session' });
    expect(tokens.verify(token, { sessionId, protocol: 'cdp' })).toEqual({ ok: false, reason: 'wrong_protocol' });
  });

  test('signature : autre MASTER_KEY, jeton altéré ou tronqué refusés', () => {
    const sessionId = randomUUID();
    const a = new ConnectTokens({ current: key() });
    const b = new ConnectTokens({ current: key() });
    const token = a.issue({ sessionId, protocol: 'cdp' });
    expect(b.verify(token, { sessionId, protocol: 'cdp' })).toEqual({ ok: false, reason: 'bad_signature' });
    for (let i = 5; i < token.length; i += 7) {
      const swapped = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
      expect(a.verify(swapped, { sessionId, protocol: 'cdp' }).ok, `position ${i}`).toBe(false);
    }
    for (const bad of ['', 'symt_', token.slice(0, -1), token.slice(0, 20), `symb_${token.slice(5)}`, `${token}=`, token.replace('symt_', '')]) {
      expect(a.verify(bad, { sessionId, protocol: 'cdp' }).ok, bad).toBe(false);
    }
  });

  test('rotation de MASTER_KEY : un jeton signé par la clé précédente reste valide jusqu’à son échéance', () => {
    const old = key();
    const sessionId = randomUUID();
    const token = new ConnectTokens({ current: old }).issue({ sessionId, protocol: 'cdp' });
    expect(new ConnectTokens({ current: key(), previous: old }).verify(token, { sessionId, protocol: 'cdp' }).ok).toBe(true);
    expect(new ConnectTokens({ current: key() }).verify(token, { sessionId, protocol: 'cdp' }).ok).toBe(false);
  });

  test('clé de signature propre aux jetons : jamais égale à la KEK des secrets ni à celle des jetons brute', () => {
    const master = key();
    const tokens = new ConnectTokens({ current: master });
    const sessionId = randomUUID();
    const token = tokens.issue({ sessionId, protocol: 'cdp' });
    // Une signature calculée avec une KEK d'un autre usage ne passe pas (séparation des domaines HKDF).
    const forged = new ConnectTokens({ current: master }, { domain: 'autre-usage/v1' }).issue({ sessionId, protocol: 'cdp' });
    expect(tokens.verify(forged, { sessionId, protocol: 'cdp' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(tokens.verify(token, { sessionId, protocol: 'cdp' }).ok).toBe(true);
  });
});
