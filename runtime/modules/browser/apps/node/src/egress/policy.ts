// SPDX-License-Identifier: AGPL-3.0-only
// Politique d'egress d'une session (cdc/sym-browser 04c § 1.3) : hôtes autorisés, ports, budget, proxy amont. Validée et
// compilée une fois, à la création ou au remplacement (`PUT /v1/sessions/{id}/egress`) ; une politique invalide est refusée
// en entier (`invalid_option`, champ nommé), jamais appliquée à moitié.
import { ON_BUDGET_EXCEEDED, type EgressPolicy, type OnBudgetExceeded, type UpstreamProxy, type UpstreamProxyProfileRef } from '@sym/contracts/browser';

export const DEFAULT_EGRESS_PORTS: readonly number[] = [80, 443];

/** Politique refusée, ou URL de navigation refusée avant Chromium. */
export class EgressPolicyError extends Error {
  override name = 'EgressPolicyError';
  readonly code = 'invalid_option';
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field} : ${message}`);
    this.field = field;
  }
}

/**
 * Forme normalisée d'un nom ou d'une IP (parseur WHATWG : minuscules, IDN en punycode, encodages d'IPv4, crochets IPv6
 * retirés, point final retiré). `undefined` si la chaîne n'est pas un hôte seul.
 */
export function normalizeHost(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || /[\s/?#@\\]/.test(trimmed)) return undefined;
  const bracketed = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed;
  try {
    const url = new URL(`http://${bracketed}/`);
    if (url.port !== '') return undefined;
    return url.hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Prédicat des hôtes autorisés : absent, toute destination (la garde reste appliquée) ; vide, aucune. Noms exacts ;
 * `*.domaine` couvre le domaine et ses sous-domaines. Couvre redirections, sous-ressources, WebSocket et requêtes API, car
 * l'egress voit chaque connexion.
 */
export function hostMatcher(allowedHosts: readonly string[] | undefined): (host: string) => boolean {
  if (allowedHosts === undefined) return () => true;
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const entry of allowedHosts) {
    const wildcard = entry.trim().startsWith('*.');
    const host = normalizeHost(wildcard ? entry.trim().slice(2) : entry);
    if (host === undefined) continue;
    if (wildcard) suffixes.push(host);
    else exact.add(host);
  }
  return (raw) => {
    const host = normalizeHost(raw);
    if (host === undefined) return false;
    return exact.has(host) || suffixes.some((s) => host === s || host.endsWith(`.${s}`));
  };
}

export type CompiledEgressPolicy = {
  readonly source: EgressPolicy;
  readonly allows: (host: string) => boolean;
  readonly ports: ReadonlySet<number>;
  readonly budgetBytes: number | undefined;
  readonly onBudgetExceeded: OnBudgetExceeded;
  readonly upstream: UpstreamProxy | UpstreamProxyProfileRef | undefined;
  readonly dnsViaProxy: boolean;
};

const isPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;

function checkAllowedHost(entry: unknown): string | undefined {
  if (typeof entry !== 'string') return 'chaîne attendue';
  const text = entry.trim();
  const wildcard = text.startsWith('*.');
  const host = normalizeHost(wildcard ? text.slice(2) : text);
  if (host === undefined || host.includes('*')) return `« ${entry} » n’est ni un nom exact ni « *.domaine »`;
  if (wildcard && !host.includes('.')) return `« ${entry} » couvrirait un domaine de premier niveau entier`;
  return undefined;
}

/** Valide et compile une politique (04c § 1.3). Lève `EgressPolicyError` sur le premier champ invalide. */
export function compileEgressPolicy(policy: EgressPolicy): CompiledEgressPolicy {
  if (policy.allowedHosts !== undefined) {
    if (!Array.isArray(policy.allowedHosts)) throw new EgressPolicyError('allowedHosts', 'liste attendue');
    for (const entry of policy.allowedHosts) {
      const problem = checkAllowedHost(entry);
      if (problem !== undefined) throw new EgressPolicyError('allowedHosts', problem);
    }
  }
  const ports = policy.ports ?? DEFAULT_EGRESS_PORTS;
  if (!Array.isArray(ports) || !ports.every(isPort)) throw new EgressPolicyError('ports', 'entiers de 1 à 65535 attendus');
  if (policy.budgetBytes !== undefined && !(Number.isSafeInteger(policy.budgetBytes) && policy.budgetBytes >= 0)) {
    throw new EgressPolicyError('budgetBytes', 'entier positif ou nul attendu');
  }
  const onBudgetExceeded = policy.onBudgetExceeded ?? 'cut';
  if (!(ON_BUDGET_EXCEEDED as readonly string[]).includes(onBudgetExceeded)) throw new EgressPolicyError('onBudgetExceeded', '`cut` ou `end` attendu');
  if (policy.dnsViaProxy !== undefined && typeof policy.dnsViaProxy !== 'boolean') throw new EgressPolicyError('dnsViaProxy', 'booléen attendu');
  return {
    source: policy,
    allows: hostMatcher(policy.allowedHosts),
    ports: new Set(ports),
    budgetBytes: policy.budgetBytes,
    onBudgetExceeded,
    upstream: policy.upstream,
    dnsViaProxy: policy.upstream !== undefined && policy.dnsViaProxy !== false,
  };
}

/** Navigation du nœud (04c § 1.1) : http et https seulement, sans identifiants ; refus avant que Chromium ne voie l'URL. */
export function assertNavigable(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressPolicyError('url', 'URL invalide');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new EgressPolicyError('url', `schéma ${url.protocol} refusé (http et https seulement)`);
  if (url.username !== '' || url.password !== '') throw new EgressPolicyError('url', 'identifiants dans l’URL refusés');
  return url;
}
