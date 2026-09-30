// SPDX-License-Identifier: AGPL-3.0-only
// Clés d'API à scopes (13 § 8) : `sy_live_` + préfixe lisible + secret de 32 octets CSPRNG ; stockée en SHA-256
// (pas de sel utile pour 256 bits d'aléa) ; affichée une seule fois ; expiration obligatoire.
import { createHash, randomBytes } from 'node:crypto';

export const API_KEY_PREFIX = 'sy_live_';

/** Scopes accordables (CHECK `api_keys_scopes_grantable` en base, même liste). */
export const GRANTABLE_SCOPES = ['apis:read', 'apis:run', 'apis:write', 'runs:read', 'datasets:read', 'schedules:write', 'sites:read'] as const;
export type ApiKeyScope = (typeof GRANTABLE_SCOPES)[number];

export const API_KEY_DEFAULT_LIFETIME_DAYS = 90;
/** Plafond `api_key_max_lifetime_days` (13 § 8, « à valider »). */
export const API_KEY_MAX_LIFETIME_DAYS = 365;

const FORMAT = /^sy_live_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{43})$/;

export function isGrantableScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (GRANTABLE_SCOPES as readonly string[]).includes(value);
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Nouvelle clé : `key` n'existe qu'en mémoire, le temps de la réponse ; seuls `prefix` et `hash` sont stockés. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const id = randomBytes(6).toString('base64url');
  const key = `${API_KEY_PREFIX}${id}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: `${API_KEY_PREFIX}${id}`, hash: hashApiKey(key) };
}

/** Clé au bon format (sinon : refus sans requête en base). */
export function isApiKeyFormat(value: string): boolean {
  return FORMAT.test(value);
}
