// SPDX-License-Identifier: AGPL-3.0-only
// 2FA TOTP « maison » (13 § 7, décision de 0.3b : pas de plugin de la bibliothèque) : RFC 6238 (HMAC-SHA1, 6 chiffres,
// pas de 30 s), graine CSPRNG de 160 bits encodée en base32 (RFC 4648) pour les applications d'authentification.
// La graine est chiffrée en base par l'appelant (MASTER_KEY, AAD = user_id) ; l'anti-rejeu tient au dernier pas
// accepté, stocké par l'appelant : un code n'est accepté que pour un pas strictement plus récent.
// Codes de secours : 10, à usage unique, 80 bits d'aléa chacun, stockés hachés (SHA-256 lié à l'utilisateur ; 80 bits
// d'aléa rendent un sel ou un hachage lent inutiles, comme pour les clés d'API).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * Pas tolérés autour du pas courant (dérive d'horloge du téléphone) : ±1, soit 90 s au plus. Écart assumé avec la
 * « validité 30 s » de 13 § 7 (pratique de RFC 6238 § 5.2) : chaque code reste à usage unique (anti-rejeu par le dernier
 * pas accepté) et les essais sont limités par compte (5 échecs / 15 min, toutes routes confondues).
 */
export const TOTP_WINDOW = 1;
const SECRET_BYTES = 20;

export const BACKUP_CODE_COUNT = 10;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('base32 invalide');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Nouvelle graine (octets bruts) : elle n'existe en clair qu'en mémoire, le temps de la sceller. */
export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** Pas TOTP d'un instant (ms). */
export function totpStep(at: number = Date.now()): number {
  return Math.floor(at / 1000 / TOTP_PERIOD_SECONDS);
}

/** Code HOTP (RFC 4226) du pas donné. */
export function totpCode(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

const CODE = /^\d{6}$/;

/**
 * Pas auquel `code` correspond dans la fenêtre ±1 autour de `at`, en ne retenant que les pas STRICTEMENT plus récents
 * que `lastUsedStep` (anti-rejeu) ; null sinon. Comparaison à temps constant.
 */
export function matchTotp(secret: Uint8Array, code: string, opts: { at?: number; lastUsedStep?: number | null } = {}): number | null {
  if (!CODE.test(code)) return null;
  const current = totpStep(opts.at);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    if (step < 0 || (opts.lastUsedStep !== null && opts.lastUsedStep !== undefined && step <= opts.lastUsedStep)) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), given) && matched === null) matched = step;
  }
  return matched;
}

/** URI `otpauth://` (format Key Uri de Google Authenticator) : émetteur et compte affichés par l'application. */
export function otpauthUri(secret: Uint8Array, account: string, issuer = 'Scrapyomama Runtime'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const BACKUP_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 signes, sans 0/o ni 1/l

/** 10 codes de secours `xxxx-xxxx-xxxx-xxxx` (16 signes de 5 bits = 80 bits). Affichés une seule fois. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(16);
    const chars = [...bytes].map((b) => BACKUP_ALPHABET[b & 31]).join('');
    return chars.match(/.{4}/g)!.join('-');
  });
}

/** Forme canonique saisie (casse, tirets et espaces ignorés) ; null si ce n'est pas un code de secours. */
export function normalizeBackupCode(input: string): string | null {
  const clean = input.toLowerCase().replace(/[\s-]/g, '');
  if (clean.length !== 16) return null;
  for (const ch of clean) if (!BACKUP_ALPHABET.includes(ch)) return null;
  return clean;
}

/** Empreinte stockée d'un code de secours, liée à son utilisateur (une empreinte copiée ailleurs ne vaut rien). */
export function hashBackupCode(userId: string, code: string): string | null {
  const normalized = normalizeBackupCode(code);
  if (normalized === null) return null;
  return createHash('sha256').update(`backup_code|${userId}|${normalized}`, 'utf8').digest('hex');
}

/** AAD de la graine scellée dans `two_factor` (13 § 7 : AAD = user_id). */
export function twoFactorAad(userId: string): string {
  if (userId === '' || userId.includes('|')) throw new Error('identifiant invalide');
  return `two_factor|${userId}`;
}

/** `MFA_ENFORCED` (13 § 7) : `off` (défaut), `admins` (owner et admins), `all`. */
export const MFA_ENFORCED_VALUES = ['off', 'admins', 'all'] as const;
export type MfaEnforced = (typeof MFA_ENFORCED_VALUES)[number];

export function parseMfaEnforced(raw: string | undefined): MfaEnforced {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return 'off';
  if ((MFA_ENFORCED_VALUES as readonly string[]).includes(v)) return v as MfaEnforced;
  throw new Error('MFA_ENFORCED invalide : off, admins ou all.');
}

/** Le rôle est-il tenu d'avoir une 2FA ? */
export function mfaRequiredFor(policy: MfaEnforced, role: 'owner' | 'admin' | 'member'): boolean {
  return policy === 'all' || (policy === 'admins' && role !== 'member');
}

/**
 * Catégorie de facteur des méthodes `amr` de RFC 8176 retenues (13 § 7) : savoir, possession, inhérence. Absentes,
 * donc jamais comptées : `sms`, `tel` (13 § 7 : ni SMS ni téléphone comme facteur), `mca`, `rba`, `geo`, `user`,
 * `wia` (signaux de contexte, pas des facteurs).
 */
const AMR_FACTOR: Readonly<Record<string, 'knowledge' | 'possession' | 'inherence'>> = {
  pwd: 'knowledge',
  pin: 'knowledge',
  kba: 'knowledge',
  otp: 'possession',
  hwk: 'possession',
  swk: 'possession',
  sc: 'possession',
  pop: 'possession',
  fpt: 'inherence',
  face: 'inherence',
  iris: 'inherence',
  retina: 'inherence',
  vbm: 'inherence',
};

/**
 * `amr` d'un IdP OIDC attestant une authentification multifacteur (13 § 7, ASVS 6.8.4) : `mfa`, ou au moins deux
 * méthodes de catégories distinctes (`pwd` + `otp`, `pin` + `hwk`...). Selon RFC 8176, `otp`, `swk` ou `hwk`
 * décrivent une méthode, pas une authentification multifacteur : une connexion sans mot de passe par code ou par clé
 * seule est un facteur unique et ne dispense pas de la 2FA locale. SMS et téléphone ne comptent jamais.
 */
export function idpAssertsMfa(amr: unknown): boolean {
  if (!Array.isArray(amr)) return false;
  if (amr.includes('mfa')) return true;
  const categories = new Set(amr.flatMap((v) => (typeof v === 'string' && Object.hasOwn(AMR_FACTOR, v) ? [AMR_FACTOR[v]] : [])));
  return categories.size >= 2;
}
