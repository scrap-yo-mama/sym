// SPDX-License-Identifier: AGPL-3.0-only

/** Erreur de normalisation de `PUBLIC_URL` : le message est destiné à l'opérateur (jamais la valeur elle-même). */
export class PublicUrlError extends Error {
  override name = 'PublicUrlError';
}

/**
 * Normalise `PUBLIC_URL` en origine pure (`schéma://hôte[:port]`), seule forme comparable à l'en-tête `Origin` d'un
 * navigateur. Un point final sur l'hôte (FQDN absolu, `exemple.org.`) est retiré ; un « / » final ou un chemin vide est
 * sans effet. Un chemin, une requête, un fragment ou des identifiants (`user:pass@`) sont refusés.
 */
export function normalizePublicUrl(raw: string | undefined): string {
  const invalid = (why: string) => new PublicUrlError(`PUBLIC_URL invalide : ${why} (attendu : origine http(s) seule, ex. https://runtime.example.org).`);
  const value = raw?.trim();
  if (!value) throw new PublicUrlError('PUBLIC_URL manquante ou invalide (URL http(s) de l’instance, ex. https://runtime.example.org).');
  if (!/^https?:\/\/[^/]+/i.test(value)) throw new PublicUrlError('PUBLIC_URL manquante ou invalide (URL http(s) de l’instance, ex. https://runtime.example.org).');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('URL illisible');
  }
  if (url.username !== '' || url.password !== '') throw invalid('identifiants (user:pass@) interdits');
  if (value.includes('?')) throw invalid('requête interdite');
  if (value.includes('#')) throw invalid('fragment interdit');
  if (url.pathname !== '/' && url.pathname !== '') throw invalid('chemin interdit');
  const bare = url.hostname.replace(/\.+$/, '');
  if (bare === '') throw invalid('hôte vide');
  url.hostname = bare;
  return url.origin;
}
