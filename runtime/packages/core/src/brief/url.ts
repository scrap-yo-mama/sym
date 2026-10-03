// SPDX-License-Identifier: AGPL-3.0-only
// URL d'un dossier d'enquête (tâche 2.14, 19c § 2 et § 7) : jetons d'URL refusés, gabarit `{param}` reconstruit par le code
// (segments variables ou identifiants remplacés, avant tout stockage et tout affichage), hôte dans la portée de l'API.
import { isIP } from 'node:net';
import { BRIEF_DEFAULTS } from './schema.js';

/** Paramètres de requête qui portent un identifiant (19c § 2), comparés sans casse. */
const TOKEN_PARAMS = new Set(
  [
    'access_token', 'id_token', 'refresh_token', 'token', 'auth', 'api_key', 'apikey', 'key', 'secret', 'password', 'passwd',
    'session', 'sessionid', 'sid', 'sig', 'signature', 'x-amz-signature', 'x-amz-credential', 'x-amz-security-token',
    'x-goog-signature', 'x-goog-credential',
  ].map((n) => n.toLowerCase()),
);
/** Paramètres de segment de session (`;jsessionid=`). */
const SEGMENT_PARAM = /;(?:jsessionid|phpsessid|sid)=/i;
/** URL absolues présentes dans un texte (bornées). */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]{1,600}/gi;

/** Une URL porte-t-elle un jeton (paramètre nommé, couple signé, segment de session, identifiants) ? */
export function urlCarriesToken(raw: string): boolean {
  if (SEGMENT_PARAM.test(raw)) return true;
  let url: URL;
  try {
    url = new URL(raw, 'https://zz-brief.invalid/');
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return true;
  const names = new Set([...url.searchParams.keys()].map((k) => k.toLowerCase()));
  for (const name of names) if (TOKEN_PARAMS.has(name)) return true;
  // `Signature` avec `Key-Pair-Id` (URL signée CloudFront), `sv` avec `sig` (SAS).
  if (names.has('signature') && names.has('key-pair-id')) return true;
  if (names.has('sv') && names.has('sig')) return true;
  return false;
}

/** URL absolues d'un texte libre (pour le contrôle des jetons d'URL). */
export function urlsInText(text: string): string[] {
  return [...text.matchAll(URL_IN_TEXT)].map((m) => m[0]);
}

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** Segments qui précèdent un identifiant de personne (19c § 7). */
const PERSON_PREFIX = new Set(['in', 'u', 'user', 'users', 'profile', 'profiles', 'people', 'pub', 'member', 'members', '@']);
/** Segment de gabarit : mot court, sans chiffre long ni allure de valeur. */
const WORDISH = /^(?:[A-Za-z][A-Za-z_-]{0,40}|v\d{1,2}|\{[A-Za-z0-9_]{1,32}\}|[A-Za-z_-]{1,40}\.(?:json|xml|html?|php|aspx?))$/;

/**
 * Chemin en gabarit (19c § 7) : `{param}` remplace tout segment variable ou identifiant (chiffres, UUID, segment qui suit
 * `/in/`, `/u/`, `/user/`, `/profile/`, `/people/`, ou tout segment qui n'a pas l'allure d'un mot de gabarit). Les `{x}`
 * déjà posés par l'IA restent `{x}`.
 */
export function templatePath(pathname: string): string {
  const segments = pathname.split('/');
  return segments
    .map((seg, i) => {
      if (seg === '') return seg;
      const prev = (segments[i - 1] ?? '').toLowerCase();
      if (PERSON_PREFIX.has(prev)) return '{param}';
      let decoded: string;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        return '{param}';
      }
      if (/^\{[A-Za-z0-9_]{1,32}\}$/.test(decoded)) return decoded;
      if (/^\d+$/.test(decoded) || UUID.test(decoded)) return '{param}';
      if (decoded.startsWith('@')) return '{param}';
      return WORDISH.test(decoded) ? decoded : '{param}';
    })
    .join('/');
}

export type ParsedHintUrl = { readonly url: URL; readonly host: string; readonly templated: boolean };

/** URL d'un indice : absolue (http, https) ou chemin résolu sur la page de l'API ; `null` sinon. */
export function parseHintUrl(raw: string, pageUrl: string): ParsedHintUrl | null {
  const text = raw.trim();
  if (text === '' || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = text.startsWith('/') && !text.startsWith('//') ? new URL(text, pageUrl) : new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  const decodedPath = (() => {
    try {
      return decodeURI(url.pathname);
    } catch {
      return url.pathname;
    }
  })();
  return { url, host: url.hostname.toLowerCase().replace(/\.+$/, ''), templated: /\{[A-Za-z0-9_]{1,32}\}/.test(decodedPath) };
}

/** Adresse IP littérale (v4 ou v6, crochets compris) : jamais un hôte d'indice sondé. */
export function isIpLiteral(host: string): boolean {
  return isIP(host.replace(/^\[|\]$/g, '')) !== 0;
}

/** URL normalisée pour le STOCKAGE : chemin en gabarit (identifiants de personnes compris), fragment retiré. */
export function storageUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.hash = '';
  const path = templatePath(url.pathname);
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * Gabarit AFFICHÉ (récit, condensé, console) : hôte et début de chemin, au plus 60 caractères, reconstruit par le code
 * (aucune valeur de requête : seulement les noms de paramètres) ; `linkedin.com/in/jean-dupont` → `linkedin.com/in/{param}`.
 */
export function displayTemplate(raw: string, pageUrl?: string): string | null {
  let url: URL;
  try {
    url = pageUrl === undefined ? new URL(raw) : new URL(raw, pageUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const names = [...new Set(url.searchParams.keys())].filter((k) => /^[A-Za-z0-9_.-]{1,32}$/.test(k));
  const text = `${host}${templatePath(url.pathname)}${names.length === 0 ? '' : `?${names.map((k) => `${k}={${k}}`).join('&')}`}`;
  const max = BRIEF_DEFAULTS.templateMaxChars;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Gabarit de comparaison (identité, rapprochement avec le trafic) : méthode, hôte, chemin en gabarit, noms de paramètres triés. */
export function matchTemplate(url: URL): string {
  const names = [...new Set(url.searchParams.keys())].map((k) => k.toLowerCase()).sort();
  // Tout segment variable, nommé par l'IA (`{id}`) ou par le code (`{n}`, `{param}`), compte pour un même gabarit.
  const path = templatePath(url.pathname).toLowerCase().replace(/\{[a-z0-9_]{1,32}\}/g, '{param}');
  return `${url.hostname.toLowerCase()}${path}${names.length === 0 ? '' : `?${names.join('&')}`}`;
}
