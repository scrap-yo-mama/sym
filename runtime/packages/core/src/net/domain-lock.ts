// SPDX-License-Identifier: AGPL-3.0-only
// Verrou de domaines d'un essai (tâche 1.6 ; 08 §3-4 ; 08b §1) : seuls les hôtes de l'API (`allowed_hosts` de la
// stratégie, ou les domaines d'un script E3) sont joignables. Appliqué au niveau réseau, donc à CHAQUE saut de
// redirection, sous-ressource, WebSocket ou `APIRequestContext` : le proxy d'egress de l'essai (Chromium) et la
// session réseau (E1, `ctx.fetch`). Comparaison exacte du nom d'hôte (minuscules, sans point final), comme
// `allowed_hosts` à l'enregistrement. La garde SSRF reste appliquée en plus.

/** Nom d'hôte normalisé : minuscules, crochets IPv6 et point final retirés. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

/** Prédicat « hôte de l'API » pour une liste `allowed_hosts`. */
export function domainLock(allowedHosts: readonly string[]): (host: string) => boolean {
  const allowed = new Set(allowedHosts.map(normalizeHost));
  return (host) => allowed.has(normalizeHost(host));
}

/** Requête refusée par le verrou de domaines : le nom de l'hôte refusé est gardé pour le journal (jamais l'URL). */
export class DomainNotAllowedError extends Error {
  readonly code = 'domain_not_allowed';
  readonly host: string;
  constructor(host: string) {
    super('domain_not_allowed');
    this.name = 'DomainNotAllowedError';
    this.host = normalizeHost(host);
  }
}

export function findDomainNotAllowed(error: unknown): DomainNotAllowedError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof DomainNotAllowedError) return current;
    current = current.cause;
  }
  return undefined;
}
