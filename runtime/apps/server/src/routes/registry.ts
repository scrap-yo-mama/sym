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
export type OwnedResource = 'api_key' | 'tunnel' | 'site_session';

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
  /** Géré par la bibliothèque d'auth (liste blanche : tout autre chemin /api/auth/* répond 404). */
  library?: true;
};

export const ROUTES: readonly RouteSpec[] = [
  { method: 'GET', url: '/api/health', auth: 'public', beforeInit: true },
  { method: 'GET', url: '/api/ready', auth: 'public', beforeInit: true },
  { method: 'POST', url: '/api/setup', auth: 'public', beforeInit: true },
  { method: 'POST', url: '/api/auth/sign-in/email', auth: 'public', library: true },
  { method: 'POST', url: '/api/auth/sign-out', auth: 'public', library: true },
  { method: 'GET', url: '/api/auth/get-session', auth: 'public', library: true },
  { method: 'GET', url: '/api/me', auth: 'session_or_key' },
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
];

const byKey = new Map(ROUTES.map((r) => [`${r.method} ${r.url}`, r]));

export function findRoute(method: string, url: string): RouteSpec | undefined {
  return byKey.get(`${method} ${url}`);
}
