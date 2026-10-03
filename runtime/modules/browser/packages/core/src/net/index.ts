// SPDX-License-Identifier: AGPL-3.0-only
// Garde réseau partagée (cdc/sym-browser 04c § 1.2) : egress des sessions (nœud, tâche 1.5) et URL de webhook (passerelle,
// tâche 2.5). Résolution unique, classement des adresses, SYMB_PRIVATE_HOSTS, classes dures jamais dérogées.
export { CidrSet, HARD_BLOCK_REASONS, classifyAddress, stripAddress, type AddressVerdict, type BlockReason } from './ip.js';
export {
  EGRESS_DENY_REASONS,
  EgressDeniedError,
  createEgressGuard,
  defaultResolver,
  egressGuardFromConfig,
  normalizeHostname,
  type DenyDetail,
  type EgressBlockReason,
  type EgressGuard,
  type EgressGuardOptions,
  type ResolvedAddress,
  type Resolver,
} from './guard.js';
