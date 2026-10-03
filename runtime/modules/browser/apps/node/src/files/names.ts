// SPDX-License-Identifier: AGPL-3.0-only
// Noms des fichiers de session (04c § 5.1 : « nom nettoyé ») : le nom proposé par la page n'est jamais un chemin, ne porte
// aucun caractère de contrôle et tient dans 255 caractères ; l'en-tête Content-Disposition suit la RFC 6266 (repli ASCII et
// `filename*` encodé en UTF-8).

const MAX_NAME = 255;
const MAX_EXTENSION = 16;
const FALLBACK = 'download';
// Caractères de contrôle C0 et DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(CONTROL, '_').trim();
  if (cleaned === '' || /^\.+$/.test(cleaned)) return FALLBACK;
  if (cleaned.length <= MAX_NAME) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= MAX_EXTENSION ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_NAME - extension.length) + extension;
}

/** RFC 5987 `attr-char` : `encodeURIComponent` laisse passer `'()*!`, encodés ici. */
const encodeRfc5987 = (value: string): string => encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function contentDisposition(name: string): string {
  const safe = sanitizeFileName(name);
  const ascii = safe.replace(/[^\u0020-\u007e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(safe)}`;
}
