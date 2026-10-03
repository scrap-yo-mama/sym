// SPDX-License-Identifier: AGPL-3.0-only
// Egress par session du nœud (cdc/sym-browser 04c § 1, tâche 1.5, BINV2). Interface interne de 04c § 6.1 :
// `startSessionEgress(policy, deps)` → `{url, state(), replace(policy), abortAll(), close()}` (plus `shut()` et `connections()`).
export { EGRESS_FROZEN_ARGS, FORCED_LOOPBACK_OPT_OUT_ENV, dedicatedChromiumArgs, sharedContextOptions, sharedLaunchOptions } from './chromium.js';
export { createBlockedReporter, type BlockedReporter, type EgressEvent } from './events.js';
export { EgressDeniedError, createEgressGuard, defaultResolver, egressGuardFromConfig, normalizeHostname, type DenyDetail, type EgressGuard, type EgressGuardOptions, type ResolvedAddress, type Resolver } from './guard.js';
export { classifyAddress, type AddressVerdict, type BlockReason } from './ip.js';
export { DEFAULT_EGRESS_PORTS, EgressPolicyError, assertNavigable, compileEgressPolicy, hostMatcher, normalizeHost, type CompiledEgressPolicy } from './policy.js';
export {
  parseAuthority,
  startClosedEgress,
  startSessionEgress,
  type EgressConnection,
  type EgressTarget,
  type SessionEgress,
  type SessionEgressDeps,
  type UpstreamDialer,
  type UpstreamTarget,
} from './proxy.js';
