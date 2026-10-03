// SPDX-License-Identifier: AGPL-3.0-only

/** Erreur de normalisation de `PUBLIC_URL` : le message est destiné à l'opérateur (jamais la valeur elle-même). */
export class PublicUrlError extends Error {
  override name = 'PublicUrlError';
}

/** Nom d'hôte ASCII (labels LDH) ou IPv6 entre crochets : même motif que les hôtes MCP de la configuration serveur. */
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])$/;
/** Autorité brute admise : hôte (lettres, chiffres, `.`, `-`) ou IPv6 entre crochets, port décimal facultatif. */
const RAW_AUTHORITY = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * Normalise `PUBLIC_URL` en origine pure (`schéma://hôte[:port]`), seule forme comparable à l'en-tête `Origin` d'un
 * navigateur. Un point final sur l'hôte (FQDN absolu, `exemple.org.`) est retiré ; un « / » final est sans effet ; les
 * blancs autour de la valeur sont ignorés. Un chemin, une requête, un fragment ou des identifiants (`user:pass@`) sont
 * refusés. La règle porte sur la forme BRUTE : `new URL` effacerait `/.`, `/%2e` ou `\` et décoderait l'hôte.
 */
export function normalizePublicUrl(raw: string | undefined): string {
  const invalid = (why: string) => new PublicUrlError(`PUBLIC_URL invalide : ${why} (attendu : origine http(s) seule, ex. https://runtime.example.org).`);
  const value = raw?.trim();
  const scheme = value ? /^https?:\/\//i.exec(value) : null;
  if (!value || !scheme) throw new PublicUrlError('PUBLIC_URL manquante ou invalide (URL http(s) de l’instance, ex. https://runtime.example.org).');
  const rest = value.slice(scheme[0].length);
  const authority = rest.split(/[/?#\\]/, 1)[0]!;
  if (authority.includes('@')) throw invalid('identifiants (user:pass@) interdits');
  if (value.includes('?')) throw invalid('requête interdite');
  if (value.includes('#')) throw invalid('fragment interdit');
  if (rest !== authority && rest !== `${authority}/`) throw invalid('chemin interdit');
  if (!RAW_AUTHORITY.test(authority)) throw invalid('nom d’hôte invalide (ASCII ou punycode, port décimal facultatif)');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('URL illisible');
  }
  if (url.username !== '' || url.password !== '') throw invalid('identifiants (user:pass@) interdits');
  const bare = url.hostname.replace(/\.+$/, '');
  if (bare === '' || !HOSTNAME.test(bare)) throw invalid('nom d’hôte invalide (ASCII ou punycode, port décimal facultatif)');
  url.hostname = bare;
  return url.origin;
}
