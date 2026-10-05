// SPDX-License-Identifier: AGPL-3.0-only
// Code d'appairage en un collage (U3.1, 05 §2 et §7.1) : `sym-pair:v1:<base64url({url, code})>`. Un seul texte porte
// l'adresse de l'instance et le code à usage unique (10 minutes) : la console le génère, l'extension le colle et n'a plus
// d'URL à saisir. Module pur, sans Node ni navigateur (btoa/atob, TextEncoder) : serveur ET service worker l'importent.
// L'adresse est ramenée à son ORIGINE (jamais de chemin, de requête ni d'identifiants) ; le contrôle `https://` reste à
// l'extension (`checkInstanceUrl`), qui connaît l'exception de la boucle locale.

export const PAIRING_CODE_PREFIX = 'sym-pair:v1:';
/** Code à usage unique `XXXXX-XXXXX` (Crockford, 10 caractères) tel que le produit `generatePairingCode`. */
const CODE_FORMAT = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;
/** Longueur maximale d'un collage : l'adresse (2 048 au plus) et le code, en base64url. */
const MAX_PASTE_CHARS = 4096;

export type DecodedPairingCode =
  | { readonly ok: true; readonly url: string; readonly code: string }
  /** `format` : pas un code en un collage (saisie à la main) ; `version` : version inconnue ; `invalid` : contenu refusé. */
  | { readonly ok: false; readonly reason: 'format' | 'version' | 'invalid' };

const toBase64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
};

/** Code en un collage ; lève si l'adresse n'en est pas une. */
export function encodePairingCode(input: { readonly url: string; readonly code: string }): string {
  const origin = new URL(input.url).origin;
  return `${PAIRING_CODE_PREFIX}${toBase64Url(JSON.stringify({ url: origin, code: input.code }))}`;
}

/** Lit un code collé (espaces, retours à la ligne et guillemets autour tolérés). Aucun effet de bord, aucune requête. */
export function decodePairingCode(pasted: string): DecodedPairingCode {
  const text = pasted.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!text.startsWith('sym-pair:')) return { ok: false, reason: 'format' };
  if (!text.startsWith(PAIRING_CODE_PREFIX)) return { ok: false, reason: 'version' };
  if (text.length > MAX_PASTE_CHARS) return { ok: false, reason: 'invalid' };
  const json = fromBase64Url(text.slice(PAIRING_CODE_PREFIX.length));
  if (json === null) return { ok: false, reason: 'invalid' };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'invalid' };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((k) => k !== 'url' && k !== 'code')) return { ok: false, reason: 'invalid' };
  const { url, code } = record;
  if (typeof url !== 'string' || url.length > 2048 || typeof code !== 'string' || !CODE_FORMAT.test(code)) return { ok: false, reason: 'invalid' };
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? { ok: false, reason: 'invalid' } : { ok: true, url: origin, code };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
