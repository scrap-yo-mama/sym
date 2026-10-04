// SPDX-License-Identifier: AGPL-3.0-only
// Jeu de caractères d'un corps reçu (banc réel R08 : page Windows-1252 décodée comme de l'UTF-8). Ordre, comme un
// navigateur : BOM, charset de l'en-tête `Content-Type`, `<meta charset>` ou `<meta http-equiv="Content-Type">` dans les
// premiers Kio d'une page HTML, puis détection (UTF-8 valide gardé, sinon Windows-1252). Un JSON ou un texte non HTML reste
// en UTF-8 sauf charset déclaré par l'en-tête. Fonction pure : aucune entrée-sortie.

/** Octets lus pour chercher la balise meta (la spécification HTML en lit 1024 ; marge pour un `<head>` chargé). */
const SNIFF_BYTES = 4096;

/** Étiquette normalisée (nom WHATWG) d'un charset reconnu par `TextDecoder`, sinon `null`. */
function normalize(label: string): string | null {
  try {
    return new TextDecoder(label.trim().replace(/^["']|["']$/g, '')).encoding;
  } catch {
    return null;
  }
}

/** Charset déclaré par un en-tête `Content-Type` (nom normalisé), `null` s'il est absent ou inconnu. */
export function readCharset(contentType: string | undefined | null): string | null {
  const m = /(?:^|;)\s*charset\s*=\s*("[^"]*"|[^;\s]+)/i.exec(contentType ?? '');
  return m === null ? null : normalize(m[1] as string);
}

const isHtmlLike = (contentType: string | undefined | null): boolean => contentType === undefined || contentType === null || contentType.trim() === '' || /html|xml|xhtml/i.test(contentType);

/** Charset déclaré dans les premiers octets d'une page (`<meta charset=…>` ou `http-equiv`), `null` sinon. */
function sniffMeta(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, SNIFF_BYTES));
  const m = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([A-Za-z0-9_:.-]{1,40})/i.exec(head);
  return m === null ? null : normalize(m[1] as string);
}

/** Décode `bytes` selon `contentType` (valeur de l'en-tête, absente ou non) ; ne lève jamais. */
export function decodeBody(bytes: Uint8Array, contentType?: string | null): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  const declared = readCharset(contentType) ?? (isHtmlLike(contentType) ? sniffMeta(bytes) : null);
  if (declared !== null) return new TextDecoder(declared).decode(bytes);
  if (!isHtmlLike(contentType)) return new TextDecoder('utf-8').decode(bytes);
  // Aucune déclaration : UTF-8 s'il est valide, sinon l'encodage hérité le plus courant du web francophone.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
