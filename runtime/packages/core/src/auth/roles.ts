// SPDX-License-Identifier: AGPL-3.0-only
// Rôles fixes et matrice de permissions (13 § 2, arbitrage A3). Pas de rôle personnalisé.
// P = sur ses propres objets, O = oui, M = métadonnées seulement, '-' = non. Le propriétaire limite les données
// (owner_id + RLS) ; cette matrice ne dit que si le rôle peut tenter l'action.

export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

type Grant = 'O' | 'P' | 'M' | '-';

export const PERMISSIONS = {
  'account:update': { member: 'P', admin: 'P', owner: 'P' },
  'account:mfa': { member: 'P', admin: 'P', owner: 'P' },
  'account:sessions': { member: 'P', admin: 'P', owner: 'P' },
  'apikeys:manage': { member: 'P', admin: 'P', owner: 'P' },
  'users:invite': { member: '-', admin: 'O', owner: 'O' },
  'users:list': { member: '-', admin: 'O', owner: 'O' },
  'users:deactivate': { member: '-', admin: 'O', owner: 'O' },
  'users:delete': { member: '-', admin: 'O', owner: 'O' },
  'users:set_role': { member: '-', admin: '-', owner: 'O' },
  'owner:transfer': { member: '-', admin: '-', owner: 'O' },
  'users:revoke_sessions': { member: '-', admin: 'O', owner: 'O' },
  'apis:create': { member: 'P', admin: 'P', owner: 'P' },
  'apis:update': { member: 'P', admin: 'P', owner: 'P' },
  'apis:delete': { member: 'P', admin: 'P', owner: 'P' },
  'schedules:manage': { member: 'P', admin: 'P', owner: 'P' },
  'apis:read': { member: 'O', admin: 'O', owner: 'O' },
  'apis:set_visibility': { member: 'P', admin: 'P', owner: 'P' },
  'apis:run': { member: 'P', admin: 'P', owner: 'P' },
  'runs:read': { member: 'P', admin: 'P', owner: 'P' },
  'datasets:read': { member: 'P', admin: 'P', owner: 'P' },
  'runs:stats': { member: 'P', admin: 'M', owner: 'M' },
  'sites:connect': { member: 'P', admin: 'P', owner: 'P' },
  'sites:server_use': { member: 'P', admin: 'P', owner: 'P' },
  'tunnel:pair': { member: 'P', admin: 'P', owner: 'P' },
  'sites:read_cookies': { member: '-', admin: '-', owner: '-' },
  'tunnel:route_other': { member: '-', admin: '-', owner: '-' },
  'apikeys:read_other': { member: '-', admin: '-', owner: '-' },
  'tunnel:revoke_other': { member: '-', admin: 'O', owner: 'O' },
  'apikeys:revoke_other': { member: '-', admin: 'O', owner: 'O' },
  'settings:llm:write': { member: '-', admin: 'O', owner: 'O' },
  'settings:proxies:write': { member: '-', admin: 'O', owner: 'O' },
  'settings:smtp:write': { member: '-', admin: 'O', owner: 'O' },
  'settings:security:write': { member: '-', admin: '-', owner: 'O' },
  'settings:sso:write': { member: '-', admin: '-', owner: 'O' },
  'audit:read': { member: '-', admin: 'O', owner: 'O' },
  'audit:export': { member: '-', admin: '-', owner: 'O' },
  'audit:purge': { member: '-', admin: '-', owner: '-' },
} as const satisfies Record<string, Record<Role, Grant>>;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Lignes « — » pour tous les rôles, y compris l'owner (INV5, X5) : lire les cookies d'autrui, router le tunnel
 * d'autrui, lire la clé d'autrui. La purge d'audit est automatique (rôle d'exploitation), jamais une route.
 */
export const STRUCTURALLY_DENIED: readonly Permission[] = ['sites:read_cookies', 'tunnel:route_other', 'apikeys:read_other', 'audit:purge'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Le rôle peut-il tenter l'action ? (le filtrage par propriétaire reste à la couche service et à la RLS). */
export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[permission][role] !== '-';
}
