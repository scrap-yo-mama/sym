// SPDX-License-Identifier: AGPL-3.0-only
// Base publique d'une demande (cdc/sym-browser 04 § 8 : `wss://{hôte}/v1/sessions/{id}/…` ; tâche 5.1, F-20261002-01). En
// mode `all`, l'instance ne connaît pas l'adresse sous laquelle on la joint (port publié par Docker, reverse proxy TLS,
// plateforme) : les `connectUrls` reprennent l'hôte de la demande (`Host`) et le schéma annoncé par le proxy
// (`X-Forwarded-Proto`, `http` ou `https` seulement). Un `Host` hors forme (caractères de chemin, d'espace, d'identifiants)
// est ignoré : la base de repli s'applique. Les URL reviennent au seul client qui a envoyé ces en-têtes, sans cache
// (`no-store`) : un `Host` choisi par le client ne change que ce que ce client reçoit.

/** Nom d'hôte DNS, IPv4 ou IPv6 entre crochets, port facultatif ; rien d'autre (ni `@`, ni `/`, ni espace). */
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

type Headers = { host?: string | string[] | undefined; 'x-forwarded-proto'?: string | string[] | undefined };

/** Base `http(s)://hôte[:port]` d'une demande ; `fallback` si l'en-tête `Host` est absent ou hors forme. */
export function publicUrlFromRequest(request: { headers: Headers }, fallback: () => string): string {
  const host = request.headers.host;
  if (typeof host !== 'string' || host.length > 260 || !HOST.test(host)) return fallback();
  const port = /:(\d+)$/.exec(host)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) return fallback();
  const forwarded = request.headers['x-forwarded-proto'];
  const first = (typeof forwarded === 'string' ? forwarded : '').split(',')[0]?.trim().toLowerCase();
  const scheme = first === 'https' ? 'https' : 'http';
  return `${scheme}://${host}`;
}
