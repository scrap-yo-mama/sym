// Mots de passe (13 § 5, ASVS 5.0 L2) : argon2id natif de Node (>= 24.7), profil OWASP m = 19 456 Kio, t = 2, p = 1.
// Format PHC stocké : $argon2id$v=19$m=…,t=…,p=…$sel$hash (paramètres stockés avec le hash).
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { COMMON_PASSWORDS } from './common-passwords.js';

export const ARGON2_PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

function derive(password: string, nonce: Buffer, p: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce, ...p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export type Argon2Params = { memory: number; passes: number; parallelism: number; tagLength: number };

/** `params` : cible courante par défaut (autre valeur : tests de re-hachage seulement). */
export async function hashPassword(password: string, params: Argon2Params = ARGON2_PARAMS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, params);
  const { memory: m, passes: t, parallelism: p } = params;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** Paramètres d'un hash stocké (pour contrôler la cible et re-hacher si elle change). */
export function passwordHashParams(stored: string): { memory: number; passes: number; parallelism: number } | null {
  const m = PHC.exec(stored);
  return m ? { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) } : null;
}

/** Vrai si le hash stocké n’est pas aux paramètres cibles : re-hacher à la prochaine connexion réussie (13 § 5). */
export function needsRehash(stored: string): boolean {
  const p = passwordHashParams(stored);
  return !p || p.memory !== ARGON2_PARAMS.memory || p.passes !== ARGON2_PARAMS.passes || p.parallelism !== ARGON2_PARAMS.parallelism;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const m = PHC.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5] ?? '', 'base64');
  if (expected.length < 16) return false;
  const actual = await derive(password, Buffer.from(m[4] ?? '', 'base64'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return timingSafeEqual(actual, expected);
}

/**
 * Politique (13 § 5) : 12 à 128 caractères, aucune règle de composition, mot de passe vérifié tel que reçu, refus
 * des mots de passe de la liste locale (aucun appel externe, INV9). Renvoie la raison du refus, ou null.
 */
export function passwordPolicyViolation(password: string): 'too_short' | 'too_long' | 'common' | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (length > PASSWORD_MAX_LENGTH) return 'too_long';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'common';
  return null;
}
