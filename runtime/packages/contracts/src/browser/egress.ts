// SPDX-License-Identifier: MIT
// Egress par session (cdc/sym-browser 04c § 1.3 et § 6.1) : politique fixée à la création, remplaçable par
// `PUT /v1/sessions/{id}/egress` (nouvelle époque), compteurs lus par `GET /v1/sessions/{id}/egress`.

export const UPSTREAM_PROXY_TYPES = ['http', 'https', 'socks5'] as const;
export type UpstreamProxyType = (typeof UPSTREAM_PROXY_TYPES)[number];

export const UPSTREAM_PROXY_KINDS = ['isp', 'datacenter', 'enterprise'] as const;
export type UpstreamProxyKind = (typeof UPSTREAM_PROXY_KINDS)[number];

/** Proxy amont en ligne. Le mot de passe est chiffré au repos et masqué à la relecture. */
export type UpstreamProxy = {
  type: UpstreamProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  kind?: UpstreamProxyKind;
};

/** Proxy amont par profil de proxy nommé (`/v1/proxy-profiles`). */
export type UpstreamProxyProfileRef = { profileId: string };

export const ON_BUDGET_EXCEEDED = ['cut', 'end'] as const;
export type OnBudgetExceeded = (typeof ON_BUDGET_EXCEEDED)[number];

/**
 * Politique d'egress d'une session. `allowedHosts` absent : toute destination publique ; liste vide : aucune destination.
 * `ports` par défaut : `[80, 443]`. `dnsViaProxy` vaut `true` par défaut avec `upstream`. `onBudgetExceeded` : `cut` par défaut.
 */
export type EgressPolicy = {
  allowedHosts?: string[];
  ports?: number[];
  upstream?: UpstreamProxy | UpstreamProxyProfileRef;
  dnsViaProxy?: boolean;
  budgetBytes?: number;
  onBudgetExceeded?: OnBudgetExceeded;
};

/** Compteurs de l'époque courante. */
export type EgressState = {
  epoch: number;
  requests: number;
  blocked: number;
  bytesIn: number;
  bytesOut: number;
  budgetBytes?: number;
  budgetExceeded: boolean;
  exitIp?: string;
  latencyMs?: number;
};

/** Motifs de refus de l'egress (événement `egress.blocked`, réponses 403 du proxy de session). */
export const EGRESS_BLOCK_REASONS = [
  'domain_not_allowed',
  'port_not_allowed',
  'address_not_public',
  'unresolvable',
  'egress_closed',
  'budget_exceeded',
] as const;
export type EgressBlockReason = (typeof EGRESS_BLOCK_REASONS)[number];
