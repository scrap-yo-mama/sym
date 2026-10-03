// SPDX-License-Identifier: AGPL-3.0-only
// Échelle réseau N1 → N2 → N3 (04 §3.2) et politique d'escalade (04 §7, 08 §2, _exclusions X4, INV6).
// La seule classe qui fait monter l'axe réseau est `network` (géo-restriction, erreur de connexion). Un 401, un 403,
// un 429 ou un défi ne change JAMAIS de proxy ni d'IP : arrêt, `action_requise` ou
// ralentissement sur la même IP. Aucune rotation : une montée ne revient jamais en arrière et chaque niveau sert une fois.
import { MODE_OF_PROXY_TYPE, NetworkConfigError, type NetworkMode, type NetworkPolicy, type ProviderParams, type ProxyDefinition } from './definitions.js';

/** Un barreau de l'échelle : un niveau, et pour N2 et N3 le proxy choisi par l'admin et les paramètres de l'API. */
export type NetworkRung =
  | { readonly mode: 'direct' }
  | { readonly mode: 'dc_proxy' | 'res_proxy'; readonly proxy: ProxyDefinition; readonly params: ProviderParams };

const ORDER: readonly NetworkMode[] = ['direct', 'dc_proxy', 'res_proxy'];

/**
 * Barreaux autorisés, dans l'ordre N1, N2, N3. N2 exige `dc_proxy` dans `allow` et un proxy `dc` configuré ;
 * N3 exige l'opt-in explicite `res_proxy` dans `allow` (jamais implicite) et un proxy `res` configuré.
 * Un proxy nommé par `proxy_ids` doit exister et être du bon type.
 */
export function buildNetworkRungs(policy: NetworkPolicy, proxies: readonly ProxyDefinition[]): NetworkRung[] {
  const rungs: NetworkRung[] = [];
  for (const mode of ORDER) {
    if (!policy.allow.includes(mode)) continue;
    if (mode === 'direct') {
      rungs.push({ mode });
      continue;
    }
    const type = mode === 'dc_proxy' ? 'dc' : 'res';
    const wanted = policy.proxyIds?.[mode];
    const proxy = wanted === undefined ? proxies.find((p) => p.type === type) : proxies.find((p) => p.id === wanted);
    if (wanted !== undefined && proxy === undefined) throw new NetworkConfigError(`proxy ${wanted} introuvable`);
    if (proxy === undefined) continue; // niveau autorisé mais aucun proxy configuré : sauté (visible via `rungs`)
    if (MODE_OF_PROXY_TYPE[proxy.type] !== mode) throw new NetworkConfigError(`proxy ${proxy.id} : type ${proxy.type} incompatible avec ${mode}`);
    const params = (mode === 'dc_proxy' ? policy.dcProxyParams : policy.resProxyParams) ?? {};
    rungs.push({ mode, proxy, params });
  }
  return rungs;
}

/** Classes d'échec de 04 §7 (le préfixe `llm_*` est accepté tel quel). */
export type FailureClassName =
  | 'transient'
  | 'network'
  | 'rate_limited'
  | 'forbidden'
  | 'blocked_by_protection'
  | 'payment_required'
  | 'auth_required'
  | 'account_limit'
  | 'not_found'
  | 'extraction'
  | 'code_error'
  | 'run_budget_exceeded'
  | 'budget_exceeded'
  | `llm_${string}`;

/**
 * Suite réseau d'un échec :
 * - `escalate` : couple suivant avec un autre N, si autorisé (`network` seulement) ;
 * - `slow_down` : même IP, cadence ralentie (`rate_limited`) ;
 * - `stop` : arrêt de toute escalade (`forbidden`, `blocked_by_protection`, budgets) ;
 * - `action_required` : la main revient à l'utilisateur (`auth_required`, `payment_required`, `account_limit`) ;
 * - `same_network` : réessai, réparation ou autre E, toujours sur le même N.
 */
export type NetworkDecision = 'escalate' | 'slow_down' | 'stop' | 'action_required' | 'same_network';

export function networkDecision(failureClass: FailureClassName): NetworkDecision {
  switch (failureClass) {
    case 'network':
      return 'escalate';
    case 'rate_limited':
      return 'slow_down';
    case 'forbidden':
    case 'blocked_by_protection':
    case 'run_budget_exceeded':
    case 'budget_exceeded':
      return 'stop';
    case 'auth_required':
    case 'payment_required':
    case 'account_limit':
      return 'action_required';
    default:
      return 'same_network';
  }
}

/** Motif réseau d'une montée (journalisé). */
export type NetworkEscalationReason = 'geo_restriction' | 'connection_error';

/** Entrée du journal des sauts : le niveau initial (`from: null`) puis chaque montée. */
export type NetworkHop = {
  readonly at: string;
  readonly from: NetworkMode | null;
  readonly to: NetworkMode;
  readonly proxyId: string | null;
  readonly reason: 'initial' | NetworkEscalationReason;
  readonly failureClass: 'network' | null;
};

export type LadderStep = {
  readonly decision: NetworkDecision;
  /** Vrai seulement pour une montée effective (`network`, barreau suivant disponible). */
  readonly changed: boolean;
  readonly rung: NetworkRung;
  readonly hop?: NetworkHop;
  /** `network` sans barreau suivant : l'échelle est épuisée. */
  readonly exhausted?: boolean;
};

/**
 * Échelle d'un run. Commence au barreau le moins cher (N1 si autorisé). Seule `onFailure('network', …)` fait monter ;
 * toute autre classe laisse le barreau courant inchangé. Les sauts sont journalisés (`hops`, `onHop`).
 */
export class NetworkLadder {
  readonly rungs: readonly NetworkRung[];
  readonly #hops: NetworkHop[] = [];
  readonly #onHop: ((hop: NetworkHop) => void) | undefined;
  readonly #now: () => Date;
  #index = 0;

  constructor(rungs: readonly NetworkRung[], options: { onHop?: (hop: NetworkHop) => void; now?: () => Date } = {}) {
    if (rungs.length === 0) throw new NetworkConfigError('aucun niveau réseau autorisé et configuré pour cette API');
    this.rungs = Object.freeze([...rungs]);
    this.#onHop = options.onHop;
    this.#now = options.now ?? (() => new Date());
    this.#record(null, 'initial', null);
  }

  get current(): NetworkRung {
    return this.rungs[this.#index] as NetworkRung;
  }

  get hops(): readonly NetworkHop[] {
    return [...this.#hops];
  }

  #record(from: NetworkMode | null, reason: NetworkHop['reason'], failureClass: NetworkHop['failureClass']): NetworkHop {
    const rung = this.current;
    const hop: NetworkHop = Object.freeze({
      at: this.#now().toISOString(),
      from,
      to: rung.mode,
      proxyId: rung.mode === 'direct' ? null : rung.proxy.id,
      reason,
      failureClass,
    });
    this.#hops.push(hop);
    this.#onHop?.(hop);
    return hop;
  }

  /**
   * Suite d'un échec. `reason` n'est lu que pour `network` : c'est le motif journalisé de la montée.
   * Pour toute autre classe, le barreau (donc le proxy et l'IP) reste le même.
   */
  onFailure(failureClass: FailureClassName, reason: NetworkEscalationReason = 'connection_error'): LadderStep {
    const decision = networkDecision(failureClass);
    if (decision !== 'escalate') return { decision, changed: false, rung: this.current };
    if (this.#index + 1 >= this.rungs.length) return { decision, changed: false, rung: this.current, exhausted: true };
    const from = this.current.mode;
    this.#index += 1;
    const hop = this.#record(from, reason, 'network');
    return { decision, changed: true, rung: this.current, hop };
  }
}
