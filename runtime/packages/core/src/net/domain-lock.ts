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

/**
 * Prédicat « hôte de l'API » pour une liste `allowed_hosts` (comparaison exacte : une chaîne `*.x` ou `.x` n'y est
 * qu'un nom qui ne correspond à rien). `suffixes` : portées de site admises EXPLICITEMENT par le code (reconnaissance de
 * l'enquête, 04b §2 : `api.exemple.test` pour une page de `www.exemple.test`), le domaine et ses sous-domaines ; jamais
 * tirées d'une stratégie.
 */
export function domainLock(allowedHosts: readonly string[], suffixes: readonly string[] = []): (host: string) => boolean {
  const allowed = new Set(allowedHosts.map(normalizeHost));
  const scopes = suffixes.map(normalizeHost).filter((s) => s.includes('.'));
  return (host) => {
    const h = normalizeHost(host);
    return allowed.has(h) || scopes.some((s) => h === s || h.endsWith(`.${s}`));
  };
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

/** Types de sous-ressource « statiques » qu'une page rendue charge pour s'afficher (noms Playwright ou CDP, casse ignorée). */
const STATIC_ASSET_TYPES = new Set(['script', 'stylesheet']);

/**
 * Sous-ressources statiques d'hôtes TIERS admises pendant la reconnaissance de l'enquête seulement (banc R05 : l'application
 * Ashby de `jobs.ashbyhq.com` charge son code depuis `cdn.ashbyprd.com`, puis appelle son API sur son propre hôte ; sans ce
 * code, la page ne se rend pas et ne charge aucune donnée). Admis : un GET http(s) de type script ou feuille de style, sans
 * identifiants dans l'URL, dans la limite de `maxHosts` hôtes tiers distincts et de `maxRequests` requêtes pour la passe.
 * Tout le reste vers un tiers (XHR, fetch, document, image, pixel, WebSocket, POST) reste coupé par le verrou de domaines ;
 * la garde SSRF s'applique à chaque connexion (proxy d'egress), une réponse tierce n'est jamais un gisement. Posé par le
 * code de la reconnaissance, jamais tiré d'une stratégie, d'un dossier ou d'une règle ; jamais pour un essai ni un run.
 */
export type StaticAssetAllowance = {
  /** Décide pour une requête que le verrou de domaines coupe (hôte tiers) ; un hôte admis est retenu pour le proxy d'egress. */
  admit(url: string, resourceType: string, method: string): boolean;
  /** Hôte tiers déjà admis pour une sous-ressource statique (proxy d'egress : la connexion de cette requête). */
  has(host: string): boolean;
  /** Hôtes tiers admis et requêtes admises (récit de la reconnaissance, sans URL). */
  usage(): { readonly hosts: number; readonly requests: number };
};

export function createStaticAssetAllowance(limits: { readonly maxHosts?: number; readonly maxRequests?: number } = {}): StaticAssetAllowance {
  const maxHosts = limits.maxHosts ?? 6;
  const maxRequests = limits.maxRequests ?? 60;
  const hosts = new Set<string>();
  let requests = 0;
  return {
    admit(url, resourceType, method) {
      if (!STATIC_ASSET_TYPES.has(resourceType.toLowerCase()) || method.toUpperCase() !== 'GET' || requests >= maxRequests) return false;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') return false;
      const host = normalizeHost(parsed.hostname);
      if (!hosts.has(host)) {
        if (hosts.size >= maxHosts) return false;
        hosts.add(host);
      }
      requests += 1;
      return true;
    },
    has: (host) => hosts.has(normalizeHost(host)),
    usage: () => ({ hosts: hosts.size, requests }),
  };
}
