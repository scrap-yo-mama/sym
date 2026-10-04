// SPDX-License-Identifier: AGPL-3.0-only
// Egress d'un essai tel que les exécuteurs le consomment (tâche 4.3 ; cdc/sym-browser 04e §2.1) : `BrowserEgress` du proxy local
// (fournisseur `local`) ou egress distant (fournisseur `sym-browser`, `server: null`). Le type de `@runtime/core` reste celui du
// proxy local ; celui-ci l'élargit de ce que le fournisseur distant ajoute.
import type { BrowserEgress } from '@runtime/core/net';
import type { EgressPolicy, ProviderCapabilities } from '@sym/contracts/browser';
import type { Browser } from 'playwright-core';

export type RunEgress = Omit<BrowserEgress, 'server'> & {
  /** Proxy local à poser sur `newContext` ; `null` : le nœud distant impose son egress (aucun `proxy`). */
  readonly server: string | null;
  /** Fournisseur distant : pose la politique de l'essai sur la session du navigateur (`PUT /v1/sessions/{id}/egress`). */
  attach?(browser: Browser): Promise<void>;
  /** Fournisseur distant : politique de l'essai, posée à la création d'une session `dedicated`. */
  readonly policy?: EgressPolicy;
  /** Fournisseur qui n'applique pas l'egress de SYM au navigateur (`cdp`) : capacités absentes, pour les gardes du worker (4.6). */
  readonly capabilities?: ProviderCapabilities;
  /** Fournisseur distant : relit l'état final de l'époque (octets, demandes, dépassement) avant que l'exécuteur lise `usage()`. */
  settle?(): Promise<void>;
};
