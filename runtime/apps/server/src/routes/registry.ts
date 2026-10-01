// SPDX-License-Identifier: AGPL-3.0-only
// Registre des routes (INV12, 08b § 4) : toute route Fastify doit y figurer, sinon son enregistrement échoue
// (crochet onRoute, app.ts) et le test paramétré `assert_cross_user_denied` / `assert_authz_matrix` échoue aussi.
// Chaque route déclare son authentification, son scope pour une clé d'API, sa permission de rôle et, si elle porte
// sur un objet appartenant à un utilisateur, la ressource concernée (le test exige un cas « B contre les objets de A »).
import type { ApiKeyScope, Permission } from '@runtime/core';

type RouteAuth =
  /** Sans identifiant (santé, assistant, connexion). */
  | 'public'
  /** Session d'interface seulement : une clé d'API reçoit 403 (scopes `api_keys:*`, `users:*`… jamais accordables). */
  | 'session'
  /** Session d'interface ou clé d'API (avec `scope` si la route en exige un). */
  | 'session_or_key'
  /** Jeton d'un appareil appairé (extension, 07 § 1) seulement ; l'utilisateur est celui du jeton. */
  | 'extension';

/** Ressources appartenant à un utilisateur exposées par les routes existantes (s'étend avec 3.1, 3.7, 2.6…). */
export type OwnedResource = 'api_key' | 'tunnel' | 'site_session' | 'auth_session' | 'audit_event';

export type RouteSpec = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  auth: RouteAuth;
  /** Scope exigé d'une clé d'API (absent : aucune clé n'y accède si `auth` = 'session'). */
  scope?: ApiKeyScope;
  /** Permission de rôle (`can`), vérifiée pour toute identité. */
  permission?: Permission;
  /** Objet d'un utilisateur : `item` (paramètre `:id`) ou `collection` (liste filtrée par propriétaire). */
  resource?: { type: OwnedResource; kind: 'item' | 'collection' };
  /** Joignable avant la création de l'owner (sinon 503 « non initialisé », 13 § 4). */
  beforeInit?: true;
  /** Joignable pendant le démarrage en mode dégradé, schéma pas encore à jour (sinon 503 « not_ready », 14 § 5). */
  duringStartup?: true;
  /** Géré par la bibliothèque d'auth (liste blanche : tout autre chemin /api/auth/* répond 404). */
  library?: true;
  /**
   * 2FA (13 § 7, tâche 3.7). Sans cette marque, une session d'interface doit avoir complété son second facteur, et un
   * compte que `MFA_ENFORCED` concerne doit avoir enrôlé sa 2FA. `pending` : joignable par une session en attente du
   * second facteur ; `enroll` : joignable par un compte tenu de s'enrôler (enrôlement forcé avant toute autre route).
   */
  mfa?: 'pending' | 'enroll';
};

export const ROUTES: readonly RouteSpec[] = [
  { method: 'GET', url: '/api/health', auth: 'public', beforeInit: true, duringStartup: true },
  { method: 'GET', url: '/api/ready', auth: 'public', beforeInit: true, duringStartup: true },
  { method: 'GET', url: '/api/version', auth: 'public', beforeInit: true, duringStartup: true },
  // `/metrics` : jeton propre (METRICS_TOKEN), 404 sans configuration ; jamais une identité d'utilisateur.
  { method: 'GET', url: '/metrics', auth: 'public', beforeInit: true },
  { method: 'POST', url: '/api/setup', auth: 'public', beforeInit: true },
  { method: 'POST', url: '/api/auth/sign-in/email', auth: 'public', library: true },
  { method: 'POST', url: '/api/auth/sign-out', auth: 'public', library: true },
  { method: 'GET', url: '/api/auth/get-session', auth: 'public', library: true },
  { method: 'GET', url: '/api/me', auth: 'session_or_key', mfa: 'enroll' },
  { method: 'GET', url: '/api/api-keys', auth: 'session', permission: 'apikeys:manage', resource: { type: 'api_key', kind: 'collection' } },
  { method: 'POST', url: '/api/api-keys', auth: 'session', permission: 'apikeys:manage' },
  { method: 'DELETE', url: '/api/api-keys/:id', auth: 'session', permission: 'apikeys:manage', resource: { type: 'api_key', kind: 'item' } },
  // Extension (tâche 2.6, 07 § 1-2) : appairage depuis la console (ré-authentification), échange du code, puis
  // routes du jeton d'appareil ; appareils et domaines connectés vus et révoqués depuis la console ; révocation admin.
  { method: 'POST', url: '/api/extension/pairing-codes', auth: 'session', permission: 'tunnel:pair' },
  { method: 'POST', url: '/api/extension/pair', auth: 'public' },
  { method: 'GET', url: '/api/extension/session', auth: 'extension' },
  { method: 'DELETE', url: '/api/extension/session', auth: 'extension' },
  { method: 'PUT', url: '/api/extension/sites/:domain', auth: 'extension', permission: 'sites:connect' },
  { method: 'PUT', url: '/api/extension/sites/:domain/cookies', auth: 'extension', permission: 'sites:server_use' },
  { method: 'DELETE', url: '/api/extension/sites/:domain', auth: 'extension', permission: 'sites:connect' },
  { method: 'GET', url: '/api/extension/devices', auth: 'session', permission: 'tunnel:pair', resource: { type: 'tunnel', kind: 'collection' } },
  { method: 'DELETE', url: '/api/extension/devices/:id', auth: 'session', permission: 'tunnel:pair', resource: { type: 'tunnel', kind: 'item' } },
  { method: 'GET', url: '/api/sites', auth: 'session_or_key', scope: 'sites:read', permission: 'sites:connect', resource: { type: 'site_session', kind: 'collection' } },
  { method: 'DELETE', url: '/api/sites/:id', auth: 'session', permission: 'sites:connect', resource: { type: 'site_session', kind: 'item' } },
  { method: 'GET', url: '/api/admin/tunnels', auth: 'session', permission: 'tunnel:revoke_other' },
  { method: 'DELETE', url: '/api/admin/tunnels/:id', auth: 'session', permission: 'tunnel:revoke_other' },
  // Comptes avancés (tâche 3.7, 13 § 13.1) : second facteur, réinitialisation, OIDC, SSO public, PRM (RFC 9728).
  { method: 'POST', url: '/api/auth/two-factor/verify', auth: 'session', mfa: 'pending' },
  { method: 'POST', url: '/api/auth/password-reset/request', auth: 'public' },
  { method: 'POST', url: '/api/auth/password-reset/confirm', auth: 'public' },
  { method: 'GET', url: '/api/auth/oidc/start', auth: 'public' },
  { method: 'GET', url: '/api/auth/oidc/callback', auth: 'public' },
  { method: 'GET', url: '/api/sso', auth: 'public' },
  { method: 'GET', url: '/.well-known/oauth-protected-resource', auth: 'public' },
  // Compte de l'appelant : sessions, 2FA, audit.
  { method: 'GET', url: '/api/me/sessions', auth: 'session', permission: 'account:sessions', resource: { type: 'auth_session', kind: 'collection' } },
  { method: 'DELETE', url: '/api/me/sessions', auth: 'session', permission: 'account:sessions' },
  { method: 'DELETE', url: '/api/me/sessions/:id', auth: 'session', permission: 'account:sessions', resource: { type: 'auth_session', kind: 'item' } },
  { method: 'POST', url: '/api/me/2fa/enroll', auth: 'session', permission: 'account:mfa', mfa: 'enroll' },
  { method: 'POST', url: '/api/me/2fa/confirm', auth: 'session', permission: 'account:mfa', mfa: 'enroll' },
  { method: 'POST', url: '/api/me/2fa/backup-codes', auth: 'session', permission: 'account:mfa' },
  { method: 'DELETE', url: '/api/me/2fa', auth: 'session', permission: 'account:mfa' },
  { method: 'GET', url: '/api/me/audit', auth: 'session', resource: { type: 'audit_event', kind: 'collection' } },
  // Administration des comptes : rôle relu en base, hiérarchie vérifiée par la route (canActOnAccount).
  { method: 'GET', url: '/api/users', auth: 'session', permission: 'users:list' },
  { method: 'PATCH', url: '/api/users/:id', auth: 'session', permission: 'users:deactivate' },
  { method: 'DELETE', url: '/api/users/:id', auth: 'session', permission: 'users:delete' },
  { method: 'POST', url: '/api/users/:id/reset-link', auth: 'session', permission: 'users:deactivate' },
  { method: 'POST', url: '/api/users/:id/revoke-access', auth: 'session', permission: 'users:revoke_sessions' },
  { method: 'DELETE', url: '/api/users/:id/2fa', auth: 'session', permission: 'users:deactivate' },
  { method: 'POST', url: '/api/owner/transfer', auth: 'session', permission: 'owner:transfer' },
  { method: 'GET', url: '/api/invitations', auth: 'session', permission: 'users:invite' },
  { method: 'POST', url: '/api/invitations', auth: 'session', permission: 'users:invite' },
  { method: 'DELETE', url: '/api/invitations/:id', auth: 'session', permission: 'users:invite' },
  { method: 'POST', url: '/api/invitations/:id/resend', auth: 'session', permission: 'users:invite' },
  { method: 'POST', url: '/api/invitations/accept', auth: 'public' },
  { method: 'GET', url: '/api/audit', auth: 'session', permission: 'audit:read' },
  { method: 'GET', url: '/api/audit/export', auth: 'session', permission: 'audit:export' },
  { method: 'GET', url: '/api/settings/security', auth: 'session', permission: 'settings:security:write' },
  { method: 'PUT', url: '/api/settings/security', auth: 'session', permission: 'settings:security:write' },
  { method: 'GET', url: '/api/settings/sso', auth: 'session', permission: 'settings:sso:write' },
  { method: 'PUT', url: '/api/settings/sso', auth: 'session', permission: 'settings:sso:write' },
];

const byKey = new Map(ROUTES.map((r) => [`${r.method} ${r.url}`, r]));

export function findRoute(method: string, url: string): RouteSpec | undefined {
  return byKey.get(`${method} ${url}`);
}
