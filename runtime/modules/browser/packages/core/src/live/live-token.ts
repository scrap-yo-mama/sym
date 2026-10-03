// SPDX-License-Identifier: AGPL-3.0-only
// Jeton de la vue en direct (cdc/sym-browser 04d § 1.1, tâche 3.2) : `v1.<corps>.<mac>`, corps base64url de
// `{s: sessionId, m: 'ro'|'rw', e: échéance en secondes, n?: nonce d'usage unique}`, mac HMAC-SHA256 sous une clé dérivée de
// la KEK `tokens` de MASTER_KEY (HKDF, info propre à la vue en direct : distincte des jetons de connexion et des URL signées
// d'objets). Durée par défaut 15 min, maximum 1 h ; vérification à temps constant ; usage unique optionnel (nonces vus
// retenus jusqu'à leur échéance, dans ce processus). Porté par la query `t`, masquée dans les journaux (0.3).
// Limite : l'usage unique est garanti par instance de passerelle ; plusieurs passerelles demanderaient un registre partagé
// (base), à poser avec la tâche 2.1.
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MasterKey } from '../crypto/master-key.js';

export type LiveMode = 'ro' | 'rw';
export const LIVE_TOKEN_DEFAULT_TTL_SECONDS = 900;
export const LIVE_TOKEN_MAX_TTL_SECONDS = 3600;
const HKDF_INFO = 'sym-browser/live-view-token/v1';

export type LiveTokenCheck = { ok: true; mode: LiveMode; expiresAt: Date } | { ok: false; reason: 'invalid' | 'expired' | 'wrong_session' | 'replayed' };

export class LiveTokens {
  readonly #key: Buffer;
  readonly #now: () => Date;
  /** Nonces des jetons à usage unique déjà présentés, avec leur échéance (secondes). */
  readonly #used = new Map<string, number>();

  constructor(master: MasterKey, options: { now?: () => Date } = {}) {
    this.#key = Buffer.from(hkdfSync('sha256', master.kek('tokens'), Buffer.alloc(0), HKDF_INFO, 32));
    this.#now = options.now ?? (() => new Date());
  }

  #mac(body: string): Buffer {
    return createHmac('sha256', this.#key).update(body).digest();
  }

  issue(input: { sessionId: string; mode: LiveMode; ttlSeconds?: number; oneTime?: boolean }): { token: string; expiresAt: Date } {
    const ttl = input.ttlSeconds ?? LIVE_TOKEN_DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > LIVE_TOKEN_MAX_TTL_SECONDS) throw new RangeError(`ttlSeconds : entier de 1 à ${LIVE_TOKEN_MAX_TTL_SECONDS} attendu`);
    if (input.mode !== 'ro' && input.mode !== 'rw') throw new RangeError('mode : ro ou rw attendu');
    const expires = Math.floor(this.#now().getTime() / 1000) + ttl;
    const payload = { s: input.sessionId, m: input.mode, e: expires, ...(input.oneTime === true ? { n: randomBytes(12).toString('base64url') } : {}) };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: `v1.${body}.${this.#mac(body).toString('base64url')}`, expiresAt: new Date(expires * 1000) };
  }

  verify(token: string, sessionId: string): LiveTokenCheck {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? '')) return { ok: false, reason: 'invalid' };
    const [, body, signature] = parts as [string, string, string];
    const expected = this.#mac(body);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' };
    let payload: { s?: unknown; m?: unknown; e?: unknown; n?: unknown };
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof payload;
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (typeof payload.s !== 'string' || (payload.m !== 'ro' && payload.m !== 'rw') || typeof payload.e !== 'number' || (payload.n !== undefined && typeof payload.n !== 'string')) return { ok: false, reason: 'invalid' };
    if (payload.s !== sessionId) return { ok: false, reason: 'wrong_session' };
    const nowSeconds = this.#now().getTime() / 1000;
    if (nowSeconds >= payload.e) return { ok: false, reason: 'expired' };
    if (typeof payload.n === 'string') {
      for (const [nonce, expiry] of this.#used) if (expiry <= nowSeconds) this.#used.delete(nonce);
      if (this.#used.has(payload.n)) return { ok: false, reason: 'replayed' };
      this.#used.set(payload.n, payload.e);
    }
    return { ok: true, mode: payload.m, expiresAt: new Date(payload.e * 1000) };
  }
}

/** URL de la vue en direct (page de la console servie par la passerelle) : `{publicUrl}/v1/sessions/{id}/live?t=<jeton>`. */
export function liveViewUrl(publicUrl: string, sessionId: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}/live?t=${token}`;
}
