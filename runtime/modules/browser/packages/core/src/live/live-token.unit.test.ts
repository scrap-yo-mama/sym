// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 3.2 (04d § 1.1) : jeton de la vue en direct, signé (HMAC, clé dérivée de MASTER_KEY), lié à la session, au mode
// (`ro`, `rw`) et à l'expiration ; usage unique optionnel ; 15 min par défaut, 1 h au plus ; jamais en clair dans un journal.
import { describe, expect, test } from 'vitest';
import { MasterKey } from '../crypto/master-key.js';
import { redactUrl } from '../crypto/redact.js';
import { LIVE_TOKEN_DEFAULT_TTL_SECONDS, LIVE_TOKEN_MAX_TTL_SECONDS, LiveTokens, liveViewUrl } from './live-token.js';

const SESSION = '6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11';
const OTHER = '0a9f2a52-3d1e-4c0b-9a52-2f0d9d7c1b22';

function clock(start = Date.UTC(2026, 9, 2, 10)) {
  let now = start;
  return { now: () => new Date(now), advance: (seconds: number) => (now += seconds * 1000) };
}

describe('jeton de la vue en direct (04d § 1.1)', () => {
  test('émis puis vérifié : session, mode et expiration liés ; 15 min par défaut', () => {
    const c = clock();
    const tokens = new LiveTokens(MasterKey.generate(), { now: c.now });
    expect(LIVE_TOKEN_DEFAULT_TTL_SECONDS).toBe(900);
    const ro = tokens.issue({ sessionId: SESSION, mode: 'ro' });
    expect(ro.expiresAt.getTime() - c.now().getTime()).toBe(900_000);
    expect(tokens.verify(ro.token, SESSION)).toEqual({ ok: true, mode: 'ro', expiresAt: ro.expiresAt });
    const rw = tokens.issue({ sessionId: SESSION, mode: 'rw', ttlSeconds: 60 });
    expect(tokens.verify(rw.token, SESSION)).toMatchObject({ ok: true, mode: 'rw' });
  });

  test('expiré, autre session, altéré, autre clé maîtresse : refusé avec le motif', () => {
    const c = clock();
    const master = MasterKey.generate();
    const tokens = new LiveTokens(master, { now: c.now });
    const { token } = tokens.issue({ sessionId: SESSION, mode: 'ro', ttlSeconds: 30 });
    expect(tokens.verify(token, OTHER)).toEqual({ ok: false, reason: 'wrong_session' });
    const [version, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), m: 'rw' })).toString('base64url');
    expect(tokens.verify(`${version}.${forged}.${signature}`, SESSION)).toEqual({ ok: false, reason: 'invalid' });
    expect(tokens.verify(`${token}x`, SESSION)).toEqual({ ok: false, reason: 'invalid' });
    expect(tokens.verify('pas un jeton', SESSION)).toEqual({ ok: false, reason: 'invalid' });
    expect(new LiveTokens(MasterKey.generate(), { now: c.now }).verify(token, SESSION)).toEqual({ ok: false, reason: 'invalid' });
    c.advance(30);
    expect(tokens.verify(token, SESSION)).toEqual({ ok: false, reason: 'expired' });
  });

  test('usage unique : accepté une fois, puis refusé (rejoué)', () => {
    const tokens = new LiveTokens(MasterKey.generate());
    const { token } = tokens.issue({ sessionId: SESSION, mode: 'ro', oneTime: true });
    expect(tokens.verify(token, SESSION)).toMatchObject({ ok: true });
    expect(tokens.verify(token, SESSION)).toEqual({ ok: false, reason: 'replayed' });
    const reusable = tokens.issue({ sessionId: SESSION, mode: 'ro' });
    expect(tokens.verify(reusable.token, SESSION)).toMatchObject({ ok: true });
    expect(tokens.verify(reusable.token, SESSION)).toMatchObject({ ok: true });
  });

  test('durée : 1 h au plus, entière et positive ; mode ro ou rw seulement', () => {
    const tokens = new LiveTokens(MasterKey.generate());
    expect(LIVE_TOKEN_MAX_TTL_SECONDS).toBe(3600);
    expect(() => tokens.issue({ sessionId: SESSION, mode: 'ro', ttlSeconds: 3601 })).toThrow(RangeError);
    expect(() => tokens.issue({ sessionId: SESSION, mode: 'ro', ttlSeconds: 0 })).toThrow(RangeError);
    expect(() => tokens.issue({ sessionId: SESSION, mode: 'admin' as never })).toThrow(RangeError);
  });

  test('distinct des autres jetons de la clé tokens : une URL signée d’objet ne vaut pas jeton de vue', () => {
    const tokens = new LiveTokens(MasterKey.generate());
    expect(tokens.verify('v1.1790000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', SESSION)).toEqual({ ok: false, reason: 'invalid' });
  });

  test('liveViewUrl : …/v1/sessions/{id}/live?t=<jeton>, jeton masqué dans les journaux (query t)', () => {
    const tokens = new LiveTokens(MasterKey.generate());
    const { token } = tokens.issue({ sessionId: SESSION, mode: 'ro' });
    const url = liveViewUrl('https://b.example.com/', SESSION, token);
    expect(url).toBe(`https://b.example.com/v1/sessions/${SESSION}/live?t=${token}`);
    expect(redactUrl(url)).not.toContain(token);
  });
});
