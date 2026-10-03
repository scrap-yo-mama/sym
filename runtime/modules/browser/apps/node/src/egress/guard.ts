// SPDX-License-Identifier: AGPL-3.0-only
// Garde de l'egress : déplacée dans le noyau (`@sym-browser/core`, net/) pour être partagée avec les webhooks de la passerelle
// (tâche 2.5) ; ré-exportée ici pour l'egress du nœud.
export {
  EgressDeniedError,
  createEgressGuard,
  defaultResolver,
  egressGuardFromConfig,
  normalizeHostname,
  type DenyDetail,
  type EgressGuard,
  type EgressGuardOptions,
  type ResolvedAddress,
  type Resolver,
} from '@sym-browser/core';
