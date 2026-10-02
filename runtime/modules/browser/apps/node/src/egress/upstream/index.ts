// SPDX-License-Identifier: AGPL-3.0-only
// Proxys amont de l'egress (cdc/sym-browser 04c § 2, tâche 1.6) : relais HTTP(S) et SOCKS5 authentifiés, profils de proxy
// chiffrés, test de l'IP de sortie, démarrage d'une session avec amont (502 `proxy_unreachable` sur échec).
export { checkUpstreamFields, createUpstreamDialer, dialUpstream, resolveUpstream, type ResolvedUpstream, type UpstreamDialerOptions, type UpstreamProxyConfig } from './dialer.js';
export { DEFAULT_IP_ECHO_URL, probeExitIp, type ProbeOptions, type ProbeResult } from './probe.js';
export {
  ProxyProfileNotFoundError,
  createMemoryProxyProfileStore,
  createProxyProfiles,
  maskUsername,
  openInlineUpstream,
  parseSealed,
  sealInlineUpstream,
  serializeSealed,
  type OpenedProxyProfile,
  type ProxyProfileInput,
  type ProxyProfileKeys,
  type ProxyProfilePatch,
  type ProxyProfileStore,
  type ProxyProfileView,
  type ProxyProfiles,
  type ProxyProfilesOptions,
  type StoredInlineUpstream,
  type StoredProxyProfile,
} from './profiles.js';
export { ProxyUnreachableError, startUpstreamSessionEgress, type ProxyUnreachableReason, type UpstreamSession, type UpstreamSessionOptions } from './session.js';
export { UpstreamError, WIRE_SOCKET, type UpstreamFailure } from './shared.js';
