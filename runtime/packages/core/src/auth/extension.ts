// SPDX-License-Identifier: AGPL-3.0-only
// Appairage de l'extension (07 § 1, 13 § 12) : code à usage unique de 10 minutes, puis jeton lié à (utilisateur,
// appareil), valable 90 jours et renouvelé à l'usage. Seules les empreintes SHA-256 sont stockées ; le code et le
// jeton n'existent en clair que le temps d'une réponse.
import { createHash, randomBytes, randomInt } from 'node:crypto';

export const EXTENSION_TOKEN_PREFIX = 'sy_ext_';
export const EXTENSION_TOKEN_LIFETIME_DAYS = 90;
export const PAIRING_CODE_TTL_MINUTES = 10;

const TOKEN_FORMAT = /^sy_ext_[A-Za-z0-9_-]{43}$/;
/** Base32 de Crockford : sans I, L, O, U (aucune confusion à la saisie). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export function generateExtensionToken(): { token: string; hash: string } {
  const token = `${EXTENSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

export function isExtensionTokenFormat(value: string): boolean {
  return TOKEN_FORMAT.test(value);
}

export function hashExtensionToken(token: string): string {
  return sha256(token);
}

/** Code lisible `XXXXX-XXXXX` (50 bits d'aléa), à usage unique, 10 minutes. */
export function generatePairingCode(): { code: string; hash: string } {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) raw += CROCKFORD[randomInt(CROCKFORD.length)];
  return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, hash: sha256(`pairing:${raw}`) };
}

/** Forme canonique d'un code saisi (casse, tirets, espaces, O→0, I/L→1), ou `null` si ce n'est pas un code. */
export function normalizePairingCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (raw.length !== CODE_LENGTH || [...raw].some((c) => !CROCKFORD.includes(c))) return null;
  return raw;
}

export function hashPairingCode(input: string): string | null {
  const raw = normalizePairingCode(input);
  return raw === null ? null : sha256(`pairing:${raw}`);
}

/** Cookie capturé par l'extension (sous-ensemble de `chrome.cookies.Cookie`), stocké chiffré seulement (INV8). */
export type SiteCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  /** Secondes depuis l'époque Unix ; absent pour un cookie de session du navigateur. */
  expirationDate?: number;
};

export const SITE_COOKIE_LIMITS = { maxCookies: 200, maxNameLength: 256, maxValueLength: 8192 } as const;

/**
 * Le cookie vise-t-il ce domaine ? (domaine exact, ou domaine parent posé avec un point initial). Un cookie d'un autre
 * site n'est jamais stocké sous le consentement donné pour celui-ci.
 */
export function cookieMatchesDomain(cookieDomain: string, siteDomain: string): boolean {
  const d = cookieDomain.toLowerCase().replace(/^\./, '').replace(/\.+$/, '');
  return d !== '' && (d === siteDomain || siteDomain.endsWith(`.${d}`)) && d.includes('.');
}

/** Cookies non expirés à l'instant `nowSeconds`. */
export function liveCookies(cookies: readonly SiteCookie[], nowSeconds: number): SiteCookie[] {
  return cookies.filter((c) => c.expirationDate === undefined || c.expirationDate > nowSeconds);
}
