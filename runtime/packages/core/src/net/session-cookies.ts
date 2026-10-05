// SPDX-License-Identifier: AGPL-3.0-only
// Cookies de session rejoués côté serveur (CDC V1 sym-sessions, A2 ; INV5 évolué, INV8, INV10). Le jeu de cookies d'un
// propriétaire (`siteCookiesForRun`) devient, pour CHAQUE requête, un en-tête `Cookie` limité à ce que la cible peut
// recevoir : hôte = domaine de la session ou sous-domaine, domaine, chemin et `secure` du cookie respectés (RFC 6265).
// Les valeurs rejoignent le registre de masquage avant toute requête (INV8) ; aucune n'est jamais journalisée.
import { cookieMatchesDomain, type SiteCookie } from '../auth/extension.js';
import { secretValues } from '../crypto/index.js';
import { normalizeHost } from './domain-lock.js';

/** L'hôte est-il le domaine de la session ou l'un de ses sous-domaines ? */
export function hostWithinSessionDomain(host: string, sessionDomain: string): boolean {
  const h = normalizeHost(host);
  const d = normalizeHost(sessionDomain);
  return d !== '' && (h === d || h.endsWith(`.${d}`));
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const hostOnly = !cookieDomain.startsWith('.');
  const d = normalizeHost(cookieDomain.replace(/^\./, ''));
  return hostOnly ? host === d : host === d || host.endsWith(`.${d}`);
}

/** Domaine du cookie : celui de la session, un sous-domaine, ou un domaine parent posé avec un point (jamais un autre site). */
function cookieBelongsToSession(cookieDomain: string, sessionDomain: string): boolean {
  const d = normalizeHost(cookieDomain.replace(/^\./, ''));
  const s = normalizeHost(sessionDomain);
  return d === s || d.endsWith(`.${s}`) || cookieMatchesDomain(cookieDomain, s);
}

/** RFC 6265 §5.1.4 : le chemin du cookie correspond au chemin de la requête. */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  const cp = cookiePath === '' || !cookiePath.startsWith('/') ? '/' : cookiePath;
  if (requestPath === cp) return true;
  if (!requestPath.startsWith(cp)) return false;
  return cp.endsWith('/') || requestPath[cp.length] === '/';
}

/**
 * En-tête `Cookie` pour `url`, ou `null` (aucun cookie). Cible hors du domaine de la session : toujours `null`
 * (`assert_session_never_cross_origin`). Jamais de cookie `secure` hors https.
 */
export function cookieHeaderFor(cookies: readonly SiteCookie[], url: URL, sessionDomain: string, nowSeconds = Date.now() / 1000): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = normalizeHost(url.hostname);
  if (!hostWithinSessionDomain(host, sessionDomain)) return null;
  const path = url.pathname === '' ? '/' : url.pathname;
  const picked = cookies.filter(
    (c) =>
      cookieBelongsToSession(c.domain, sessionDomain) &&
      domainMatches(c.domain, host) &&
      pathMatches(c.path, path) &&
      (!c.secure || url.protocol === 'https:') &&
      (c.expirationDate === undefined || c.expirationDate > nowSeconds) &&
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(c.name) &&
      !/[\r\n;]/.test(c.value),
  );
  if (picked.length === 0) return null;
  // Chemin le plus long d'abord (RFC 6265 §5.4), puis ordre d'origine.
  picked.sort((a, b) => b.path.length - a.path.length);
  return picked.map((c) => `${c.name}=${c.value}`).join('; ');
}

export type SessionCookies = {
  readonly domain: string;
  /** En-tête `Cookie` de cette cible, ou `null`. Marque la session comme utilisée quand un cookie part. */
  headerFor(url: URL): string | null;
  /** Au moins un cookie est parti pendant l'essai. */
  used(): boolean;
};

/** Cookies d'un run : valeurs inscrites au registre de masquage AVANT toute requête. */
export function createSessionCookies(domain: string, cookies: readonly SiteCookie[]): SessionCookies {
  const own = [...cookies];
  for (const c of own) {
    secretValues.add(c.value);
    // Forme décodée d'un cookie percent-encodé : masquée aussi.
    try {
      const decoded = decodeURIComponent(c.value);
      if (decoded !== c.value) secretValues.add(decoded);
    } catch {
      /* valeur non encodée */
    }
  }
  let used = false;
  return {
    domain,
    headerFor(url) {
      const header = cookieHeaderFor(own, url, domain);
      if (header !== null) {
        used = true;
        secretValues.add(header);
      }
      return header;
    },
    used: () => used,
  };
}
