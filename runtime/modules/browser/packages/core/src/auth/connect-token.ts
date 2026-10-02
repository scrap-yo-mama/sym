// SPDX-License-Identifier: AGPL-3.0-only
// Jetons de connexion (cdc/sym-browser 04 § 7, 04f § 3 ; tâche 2.1) : `symt_<charge><HMAC>`, HMAC-SHA256 sous une clé
// dérivée de MASTER_KEY (KEK `tokens` de 0.3, puis HKDF au libellé de cet usage), liés à une session et à un protocole
// (`playwright`, `cdp`, `live`), 300 s par défaut, 1 h au plus. Sans état : la passerelle vérifie sans lire la base, puis
// contrôle la session (`running`, même client) dans `authorizeConnection`. Après rotation, `MASTER_KEY_PREVIOUS` vérifie
// encore les jetons qu'elle a signés jusqu'à leur échéance.
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Keyring } from '../crypto/master-key.js';
import { CONNECT_TOKEN_PREFIX } from './api-key.js';

export const CONNECT_PROTOCOLS = ['playwright', 'cdp', 'live'] as const;
export type ConnectProtocol = (typeof CONNECT_PROTOCOLS)[number];
export const CONNECT_TOKEN_TTL_SECONDS = 300;
export const CONNECT_TOKEN_MAX_TTL_SECONDS = 3600;

const DOMAIN = 'sym-browser/connect-token/v1';
const MAC_LENGTH = 43; // 32 octets en base64url
const MAX_TOKEN_LENGTH = 1024;
const MAX_SESSION_ID_LENGTH = 200;
const URL_SAFE = /^[A-Za-z0-9_-]+$/;

export type TokenFailure = 'malformed' | 'bad_signature' | 'expired' | 'wrong_session' | 'wrong_protocol';
export type TokenCheck = { ok: true; sessionId: string; protocol: ConnectProtocol; expiresAt: Date } | { ok: false; reason: TokenFailure };

export type ConnectTokenOptions = {
  /** Horloge en millisecondes (tests). */
  now?: () => number;
  /** Libellé HKDF ; ne change que pour séparer un autre usage (ex. jetons de vue en direct, 3.2). */
  domain?: string;
};

type Payload = { v: 1; s: string; p: ConnectProtocol; e: number; n: string };

const isProtocol = (value: unknown): value is ConnectProtocol => typeof value === 'string' && (CONNECT_PROTOCOLS as readonly string[]).includes(value);

export class ConnectTokens {
  /** Clé courante d'abord, puis la précédente (rotation). */
  readonly #keys: Buffer[];
  readonly #now: () => number;

  constructor(keyring: Keyring, options: ConnectTokenOptions = {}) {
    const domain = options.domain ?? DOMAIN;
    this.#keys = [keyring.current, keyring.previous]
      .filter((k) => k !== undefined)
      .map((k) => Buffer.from(hkdfSync('sha256', k.kek('tokens'), Buffer.alloc(0), domain, 32)));
    this.#now = options.now ?? Date.now;
  }

  /** Forme attendue par `GatewayDeps.tokens` de l'API REST (2.2). */
  issue(input: { sessionId: string; protocol: ConnectProtocol; ttlSeconds?: number }): string {
    const ttl = input.ttlSeconds ?? CONNECT_TOKEN_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > CONNECT_TOKEN_MAX_TTL_SECONDS) throw new RangeError(`durée de jeton (ttlSeconds) invalide : entier de 1 à ${CONNECT_TOKEN_MAX_TTL_SECONDS} attendu.`);
    if (typeof input.sessionId !== 'string' || input.sessionId === '' || input.sessionId.length > MAX_SESSION_ID_LENGTH) throw new TypeError('sessionId invalide.');
    if (!isProtocol(input.protocol)) throw new TypeError(`protocole invalide : ${String(input.protocol)}.`);
    const payload: Payload = { v: 1, s: input.sessionId, p: input.protocol, e: Math.floor(this.#now() / 1000) + ttl, n: randomBytes(9).toString('base64url') };
    const body = `${CONNECT_TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return `${body}${this.#mac(this.#keys[0]!, body).toString('base64url')}`;
  }

  /** Signature d'abord (temps constant), puis échéance, session et protocole. Ne lève jamais. */
  verify(token: unknown, expected: { sessionId: string; protocol: ConnectProtocol }): TokenCheck {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !token.startsWith(CONNECT_TOKEN_PREFIX)) return { ok: false, reason: 'malformed' };
    const rest = token.slice(CONNECT_TOKEN_PREFIX.length);
    if (rest.length <= MAC_LENGTH || !URL_SAFE.test(rest)) return { ok: false, reason: 'malformed' };
    const body = token.slice(0, -MAC_LENGTH);
    const macText = token.slice(-MAC_LENGTH);
    const mac = Buffer.from(macText, 'base64url');
    if (mac.length !== 32 || mac.toString('base64url') !== macText) return { ok: false, reason: 'malformed' };
    let signed = false;
    for (const key of this.#keys) signed = timingSafeEqual(this.#mac(key, body), mac) || signed;
    if (!signed) return { ok: false, reason: 'bad_signature' };

    let payload: Partial<Payload>;
    try {
      payload = JSON.parse(Buffer.from(body.slice(CONNECT_TOKEN_PREFIX.length), 'base64url').toString('utf8')) as Partial<Payload>;
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (payload?.v !== 1 || typeof payload.s !== 'string' || !isProtocol(payload.p) || !Number.isInteger(payload.e)) return { ok: false, reason: 'malformed' };
    const expiresAt = payload.e! * 1000;
    if (this.#now() >= expiresAt) return { ok: false, reason: 'expired' };
    if (payload.s !== expected.sessionId) return { ok: false, reason: 'wrong_session' };
    if (payload.p !== expected.protocol) return { ok: false, reason: 'wrong_protocol' };
    return { ok: true, sessionId: payload.s, protocol: payload.p, expiresAt: new Date(expiresAt) };
  }

  #mac(key: Buffer, body: string): Buffer {
    return createHmac('sha256', key).update(body).digest();
  }
}
