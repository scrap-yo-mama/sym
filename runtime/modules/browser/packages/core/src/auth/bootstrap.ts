// SPDX-License-Identifier: AGPL-3.0-only
// Premier démarrage (cdc/sym-browser 04d § 5.3, 04b § 11, 04g § 6 ; tâche 2.1) :
//   - jeton de `/setup` : `SYMB_BOOTSTRAP_TOKEN` s'il est posé, sinon généré (l'appelant l'écrit une fois au démarrage) ;
//     comparé à temps constant ; consommé par la création de l'admin d'instance (la création n'a lieu qu'une fois) ;
//   - première clé d'API : `SYMB_BOOTSTRAP_API_KEY` (clé `symb_`), client `sym`, scopes `sessions:write` et `sessions:read`,
//     insérée par `ensureFirstApiKey` de @sym-browser/db si la table des clés est vide.
// Le stockage de l'admin (`FirstAdminStore`) est injecté : sa table arrive avec la console (tâche 3.5).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Secret } from '../crypto/redact.js';
import { apiKeyPrefixOf } from './api-key.js';
import { hashSecret } from './hash.js';
import type { ApiScope } from './scopes.js';

type Revealable = { reveal(): string };

export function resolveBootstrapToken(configured: Revealable | null | undefined): { token: Secret; generated: boolean } {
  const value = configured?.reveal() ?? '';
  if (value !== '') return { token: new Secret(value), generated: false };
  return { token: new Secret(randomBytes(32).toString('base64url')), generated: true };
}

/** Égalité à temps constant (HMAC des deux côtés sous une clé jetable : longueurs égales, aucune fuite de longueur). */
export function bootstrapTokenMatches(presented: string, expected: Revealable): boolean {
  const reference = expected.reveal();
  if (presented === '' || reference === '') return false;
  const key = randomBytes(32);
  const digest = (v: string) => createHmac('sha256', key).update(v).digest();
  return timingSafeEqual(digest(presented), digest(reference));
}

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface FirstAdminStore {
  /** Crée l'admin d'instance s'il n'en existe aucun, atomiquement ; `exists` sinon (jeton déjà consommé). */
  createFirstAdmin(admin: { email: string; passwordHash: string }): Promise<'created' | 'exists'>;
}

export type SetupResult = { ok: true } | { ok: false; reason: 'bad_token' | 'already_done' | 'weak_password' | 'invalid_email' };

/** `/setup` : jeton, puis e-mail et mot de passe (12 caractères au moins), empreinte argon2id, création unique. */
export async function setupFirstAdmin(store: FirstAdminStore, expected: Revealable, form: { email: string; password: string; token: string }): Promise<SetupResult> {
  if (!bootstrapTokenMatches(form.token, expected)) return { ok: false, reason: 'bad_token' };
  const email = form.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return { ok: false, reason: 'invalid_email' };
  if ([...form.password].length < ADMIN_PASSWORD_MIN_LENGTH) return { ok: false, reason: 'weak_password' };
  const created = await store.createFirstAdmin({ email, passwordHash: await hashSecret(form.password) });
  return created === 'created' ? { ok: true } : { ok: false, reason: 'already_done' };
}

export const BOOTSTRAP_TENANT = 'sym';
export const BOOTSTRAP_API_KEY_SCOPES: readonly ApiScope[] = ['sessions:write', 'sessions:read'];

export type BootstrapApiKeyRecord = { tenantName: string; prefix: string; keyHash: string; scopes: ApiScope[]; expiresAt: null };

/** Ligne de la première clé, prête pour `ensureFirstApiKey` ; la valeur n'apparaît jamais dans l'erreur. */
export async function bootstrapApiKeyRecord(key: Revealable): Promise<BootstrapApiKeyRecord> {
  const value = key.reveal();
  const prefix = apiKeyPrefixOf(value);
  if (!prefix) throw new Error('SYMB_BOOTSTRAP_API_KEY invalide : clé symb_… attendue ; générez-en une avec `pnpm --filter @sym-browser/core apikey`.');
  return { tenantName: BOOTSTRAP_TENANT, prefix, keyHash: await hashSecret(value), scopes: [...BOOTSTRAP_API_KEY_SCOPES], expiresAt: null };
}
