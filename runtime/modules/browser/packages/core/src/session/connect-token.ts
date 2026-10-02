// SPDX-License-Identifier: AGPL-3.0-only
// Jetons de connexion des `connectUrls` (cdc/sym-browser 04 § 7, 04f § 3) : `symbt_<corps>.<mac>`, corps base64url de
// `{s: sessionId, p: protocole, e: échéance en ms}`, mac HMAC-SHA256 sous une clé dérivée de MASTER_KEY (HKDF, info propre :
// la clé maîtresse ne signe jamais directement). Un jeton ouvre la seule session et le seul protocole qu'il nomme, jusqu'à
// son échéance (300 s par défaut, 1 h au plus). Vérification à temps constant. Préfixe `symbt_` : la passerelle distingue un
// jeton de session d'une clé d'API (04f § 3).
// Posé par la tâche 2.3 en l'absence de la tâche 2.1 (« jetons de connexion par session à durée courte ») : même contrat,
// à reprendre ou à remplacer par 2.1 sans changer la forme des URL.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const CONNECT_TOKEN_PREFIX = 'symbt_';
export const CONNECT_TOKEN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 3600;
const HKDF_INFO = 'sym-browser/connect-token/v1';

export type ConnectProtocol = 'playwright' | 'cdp';
const PROTOCOLS: readonly ConnectProtocol[] = ['playwright', 'cdp'];

export type ConnectTokenCheck = { ok: true; sessionId: string; protocol: ConnectProtocol; expiresAt: number } | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

export type ConnectTokens = {
  issue(input: { sessionId: string; protocol: ConnectProtocol; ttlSeconds: number }): string;
  verify(token: string): ConnectTokenCheck;
};

export function isConnectToken(secret: string): boolean {
  return secret.startsWith(CONNECT_TOKEN_PREFIX);
}

export function createConnectTokens(masterKey: Uint8Array, options: { now?: () => number } = {}): ConnectTokens {
  if (masterKey.length !== 32) throw new RangeError('clé maîtresse de 32 octets attendue');
  const key = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), HKDF_INFO, 32));
  const now = options.now ?? Date.now;
  const mac = (body: string): Buffer => createHmac('sha256', key).update(body).digest();

  return {
    issue({ sessionId, protocol, ttlSeconds }) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) throw new RangeError(`ttlSeconds : entier de 1 à ${MAX_TTL_SECONDS} attendu`);
      const body = Buffer.from(JSON.stringify({ s: sessionId, p: protocol, e: now() + ttlSeconds * 1000 })).toString('base64url');
      return `${CONNECT_TOKEN_PREFIX}${body}.${mac(body).toString('base64url')}`;
    },
    verify(token) {
      if (!isConnectToken(token)) return { ok: false, reason: 'malformed' };
      const parts = token.slice(CONNECT_TOKEN_PREFIX.length).split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return { ok: false, reason: 'malformed' };
      const [body, signature] = parts as [string, string];
      const expected = mac(body);
      const given = Buffer.from(signature, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      const { s, p, e } = (payload ?? {}) as { s?: unknown; p?: unknown; e?: unknown };
      if (typeof s !== 'string' || typeof e !== 'number' || !PROTOCOLS.includes(p as ConnectProtocol)) return { ok: false, reason: 'malformed' };
      if (now() >= e) return { ok: false, reason: 'expired' };
      return { ok: true, sessionId: s, protocol: p as ConnectProtocol, expiresAt: e };
    },
  };
}
