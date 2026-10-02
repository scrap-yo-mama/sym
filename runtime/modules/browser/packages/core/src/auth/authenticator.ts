// SPDX-License-Identifier: AGPL-3.0-only
// Authentification par clé d'API (cdc/sym-browser 04 § 1 et § 6, BINV7 ; tâche 2.1). Le stockage est injecté
// (`ApiKeyStore`, implémenté sur PostgreSQL par `pgApiKeyStore` de @sym-browser/db) : ce fichier reste sans I/O.
// Ordre : forme → ligne par préfixe (inconnue : vérification à blanc, même durée) → empreinte argon2id (temps constant)
// → révocation → expiration (instant exact compris) → scopes (ensemble fermé). La ligne est relue à chaque requête :
// révocation, expiration et scopes s'appliquent immédiatement ; seul le calcul argon2id est mis en cache, lié à l'empreinte.
import { createHmac, randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';
import type { Secret } from '../crypto/redact.js';
import { apiKeyPrefixOf, generateApiKey } from './api-key.js';
import { burnVerification, hashSecret, verifySecret } from './hash.js';
import { isApiScope, parseScopes, type ApiScope } from './scopes.js';

/** Ligne de `api_keys` utile à l'authentification. */
export type ApiKeyRecord = {
  id: string;
  tenantId: string;
  keyHash: string;
  scopes: readonly string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

export interface ApiKeyStore {
  findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  /** Pose `last_used_at` (jamais en arrière). */
  touch(id: string, at: Date): Promise<void>;
}

/** Identité d'une clé valide (forme attendue par `GatewayDeps.auth` de l'API REST, tâche 2.2). */
export type Principal = { tenantId: string; apiKeyId: string; scopes: readonly ApiScope[] };

/** `busy` : trop de calculs argon2id en cours et en attente (audit 5.3 S15) ; la passerelle répond 429, jamais 401. */
export type ApiKeyFailure = 'malformed' | 'unknown' | 'mismatch' | 'revoked' | 'expired' | 'invalid_record' | 'busy';
export type ApiKeyCheck = { ok: true; principal: Principal } | { ok: false; reason: ApiKeyFailure };

export type AuthenticatorOptions = {
  now?: () => Date;
  /** Intervalle minimal entre deux écritures de `last_used_at` pour une clé (défaut 60 s). */
  touchIntervalMs?: number;
  /** Entrées du cache de vérification (défaut 1 024). */
  cacheSize?: number;
  /** Calculs argon2id simultanés (défaut : nombre de cœurs, 2 au moins) ; chacun prend ~19 Mio. */
  maxConcurrentVerifications?: number;
  /** Calculs en attente au-delà desquels la vérification est refusée sans calcul (`busy`, défaut 64). */
  maxQueuedVerifications?: number;
};

/** File bornée de calculs coûteux : `undefined` si elle est pleine (rien n'est calculé). */
class Limiter {
  #running = 0;
  readonly #waiting: Array<() => void> = [];
  readonly concurrency: number;
  readonly queue: number;
  constructor(concurrency: number, queue: number) {
    this.concurrency = concurrency;
    this.queue = queue;
  }
  async run<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (this.#running >= this.concurrency) {
      if (this.#waiting.length >= this.queue) return undefined;
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else this.#running += 1;
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running -= 1;
    }
  }
}

export class ApiKeyAuthenticator {
  readonly #store: ApiKeyStore;
  readonly #now: () => Date;
  readonly #touchIntervalMs: number;
  readonly #cacheSize: number;
  /** HMAC(clé de processus, secret présenté) → empreinte vérifiée. Ni le secret ni un dérivé réversible n'y sont gardés. */
  readonly #verified = new Map<string, string>();
  readonly #cacheKey = randomBytes(32);
  readonly #touched = new Map<string, number>();
  readonly #limiter: Limiter;

  constructor(store: ApiKeyStore, options: AuthenticatorOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#touchIntervalMs = options.touchIntervalMs ?? 60_000;
    this.#cacheSize = options.cacheSize ?? 1024;
    this.#limiter = new Limiter(options.maxConcurrentVerifications ?? Math.max(2, availableParallelism()), options.maxQueuedVerifications ?? 64);
  }

  /** Clé reçue en `Authorization: Bearer` ; `null` si elle est malformée, inconnue, fausse, révoquée ou expirée. */
  async authenticate(secret: string): Promise<Principal | null> {
    const result = await this.check(secret);
    return result.ok ? result.principal : null;
  }

  /** Même contrôle, avec le motif du refus (journal de la passerelle ; jamais renvoyé au client au-delà de 401). */
  async check(secret: string): Promise<ApiKeyCheck> {
    const prefix = apiKeyPrefixOf(secret);
    if (!prefix) return { ok: false, reason: 'malformed' };
    const row = await this.#store.findByPrefix(prefix);
    if (!row) {
      if ((await this.#limiter.run(async () => (await burnVerification(), true))) === undefined) return { ok: false, reason: 'busy' };
      return { ok: false, reason: 'unknown' };
    }
    const matches = await this.#matches(secret, row.keyHash);
    if (matches === undefined) return { ok: false, reason: 'busy' };
    if (!matches) return { ok: false, reason: 'mismatch' };
    const now = this.#now();
    if (row.revokedAt !== null) return { ok: false, reason: 'revoked' };
    if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
    if (row.scopes.length === 0 || !row.scopes.every(isApiScope)) return { ok: false, reason: 'invalid_record' };
    await this.#touch(row, now);
    return { ok: true, principal: { tenantId: row.tenantId, apiKeyId: row.id, scopes: [...row.scopes] as ApiScope[] } };
  }

  /** `undefined` : file des calculs pleine. Une clé déjà vérifiée ne coûte aucun calcul et passe toujours. */
  async #matches(secret: string, keyHash: string): Promise<boolean | undefined> {
    const digest = createHmac('sha256', this.#cacheKey).update(secret).digest('base64');
    if (this.#verified.get(digest) === keyHash) return true;
    const verified = await this.#limiter.run(() => verifySecret(secret, keyHash));
    if (verified === undefined) return undefined;
    if (!verified) return false;
    if (this.#verified.size >= this.#cacheSize) this.#verified.delete(this.#verified.keys().next().value!);
    this.#verified.set(digest, keyHash);
    return true;
  }

  async #touch(row: ApiKeyRecord, now: Date): Promise<void> {
    const last = Math.max(this.#touched.get(row.id) ?? 0, row.lastUsedAt?.getTime() ?? 0);
    if (now.getTime() - last < this.#touchIntervalMs) return;
    this.#touched.set(row.id, now.getTime());
    await this.#store.touch(row.id, now);
  }
}

export type NewApiKey = { key: Secret; prefix: string; keyHash: string; scopes: ApiScope[]; expiresAt: Date | null };

/**
 * Clé neuve prête à insérer (`insertApiKey` de @sym-browser/db) : `key` est rendue une seule fois à l'appelant (réponse
 * 201 de `POST /v1/admin/keys`, console), seuls `prefix`, `keyHash`, `scopes` et `expiresAt` sont stockés.
 */
export async function newApiKey(input: { scopes: readonly ApiScope[]; expiresAt?: Date | null; now?: Date }): Promise<NewApiKey> {
  const scopes = parseScopes(input.scopes);
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && !(expiresAt.getTime() > (input.now ?? new Date()).getTime())) throw new Error('expiration dans le passé : choisis une date future.');
  const { key, prefix } = generateApiKey();
  return { key, prefix, keyHash: await hashSecret(key.reveal()), scopes, expiresAt };
}
