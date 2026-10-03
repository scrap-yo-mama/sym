// SPDX-License-Identifier: AGPL-3.0-only
// Protocoles servis par type de session (cdc/sym-browser 04f § 1 et § 2, CDC v1.2) : une session shared n'est servie qu'en
// Playwright natif (`browserType.connect`) ; CDP brut sur un Chromium partagé laisserait un client énumérer les cibles des
// autres contextes (AD8, BINV1). `connectUrls.cdp` est nul pour shared ; une demande CDP répond 409 `protocol_not_served`.
// BiDi : réservé, nul en V1 (AD10).
// Formes du contrat `@sym/contracts/browser` 1.0.0 (tâche 2.2) : `ConnectUrls` et l'erreur `protocol_not_served`.
import { ERROR_STATUS, type ConnectUrls, type SessionType } from '@sym/contracts/browser';

export type SessionProtocol = 'playwright' | 'cdp' | 'bidi';

export function servedProtocols(type: SessionType): Record<SessionProtocol, boolean> {
  return { playwright: true, cdp: type === 'dedicated', bidi: false };
}

/** `connectUrls` d'une session `running` : trois clés, `cdp` nul pour shared, `bidi` nul en V1. */
export function connectUrlsFor(type: SessionType, urls: { playwright: string; cdp: string }): ConnectUrls {
  return { playwright: urls.playwright, cdp: servedProtocols(type).cdp ? urls.cdp : null, bidi: null };
}

export class ProtocolNotServedError extends Error {
  override name = 'ProtocolNotServedError';
  readonly code = 'protocol_not_served';
  readonly status = ERROR_STATUS.protocol_not_served;
  readonly retryable = false;
  readonly what_to_do = 'Crée la session en type `dedicated` pour la piloter en CDP.';
  readonly protocol: SessionProtocol;
  constructor(type: SessionType, protocol: SessionProtocol) {
    super(`Le protocole ${protocol} n’est pas servi pour une session ${type}.`);
    this.protocol = protocol;
  }
}

/** Refus avant tout octet vers le navigateur (relais du nœud et de la passerelle, tâche 2.3). */
export function assertProtocolServed(type: SessionType, protocol: SessionProtocol): void {
  if (!servedProtocols(type)[protocol]) throw new ProtocolNotServedError(type, protocol);
}
