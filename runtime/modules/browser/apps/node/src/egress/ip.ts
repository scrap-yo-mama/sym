// SPDX-License-Identifier: AGPL-3.0-only
// Classement des adresses : déplacé dans le noyau (`@sym-browser/core`, net/ip.ts), ré-exporté pour l'egress du nœud.
export { classifyAddress, type AddressVerdict, type BlockReason } from '@sym-browser/core';
