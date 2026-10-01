// SPDX-License-Identifier: AGPL-3.0-only
// Navigation principale de la console (06 § 1, figure 1). Utilisateurs et Audit n'apparaissent que si `can()` l'autorise (13 § 2) ;
// avant l'enrôlement forcé à la 2FA, aucune entrée n'est proposée : rien d'autre n'est joignable (13 § 7).
import type { Permission } from '@/composables/useSession';

export type NavEntry = { to: string; label: string; permission?: Permission };

const NAV: readonly NavEntry[] = [
  { to: '/', label: 'nav.home' },
  { to: '/apis', label: 'nav.catalog' },
  { to: '/apis/new', label: 'nav.newApi' },
  { to: '/runs', label: 'nav.runs' },
  { to: '/admin/users', label: 'nav.users', permission: 'users:list' },
  { to: '/admin/audit', label: 'nav.audit', permission: 'audit:read' },
  { to: '/settings/account', label: 'nav.account' },
  { to: '/settings', label: 'nav.settings' },
];

/** Entrées visibles pour la personne connectée : `can` est la permission du rôle (serveur), `mustEnroll` l'enrôlement 2FA exigé. */
export function visibleNav(can: (permission: Permission) => boolean, mustEnroll: boolean): NavEntry[] {
  return mustEnroll ? [] : NAV.filter((entry) => !entry.permission || can(entry.permission));
}
