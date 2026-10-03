// SPDX-License-Identifier: AGPL-3.0-only
// Éléments du proxy amont partagés avec le proxy de session (tâche 1.6) : sans dépendance, pour éviter un cycle d'imports.

/** Motif d'échec d'un tunnel par le proxy amont (détail de `proxy_unreachable` à la création, corps du 502 en session). */
export type UpstreamFailure =
  | 'connect_failed'
  | 'upstream_auth_failed'
  | 'upstream_refused'
  | 'timeout'
  | 'tls_failed'
  | 'protocol_error'
  | 'echo_failed';

/** Échec du proxy amont. Le message ne porte jamais d'identifiant ni de mot de passe (BINV6). */
export class UpstreamError extends Error {
  override name = 'UpstreamError';
  readonly reason: UpstreamFailure;
  constructor(reason: UpstreamFailure) {
    super(`proxy amont : ${reason}`);
    this.reason = reason;
  }
}

/**
 * Socket TCP sous un tunnel TLS (proxy `https`) : l'egress compte les octets du fil (TLS compris, 04c § 1.5) sur lui, et
 * non sur le flux déchiffré.
 */
export const WIRE_SOCKET = Symbol.for('sym-browser.egress.wire-socket');
