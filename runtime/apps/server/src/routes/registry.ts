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
  | 'extension'
  /** Clé d'API seulement (serveur MCP, 05 § 3) : ni session d'interface, ni jeton d'appareil ; scope vérifié par outil. */
  | 'key';

/**
 * Ressources appartenant à un utilisateur exposées par les routes (s'étend avec chaque tâche). API REST (3.1) : `api` (par
 * son slug), `api_investigation` (par son identifiant : validation du schéma), `run`, `dataset`, `schedule` (slug de l'API et
 * identifiant), `webhook_subscription`.
 */
export type OwnedResource =
  | 'api_key'
  | 'tunnel'
  | 'site_session'
  | 'auth_session'
  | 'audit_event'
  | 'auth_identity'
  | 'api'
  | 'api_investigation'
  | 'run'
  | 'dataset'
  | 'schedule'
  | 'webhook_subscription';

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
  /** Flux sans fin (SSE, 06 § 3) : les harnais qui lisent une réponse entière ne l'appellent pas sans le couper. */
  stream?: true;
  /** Protocole MCP (JSON-RPC, 05 § 1), hors de l'OpenAPI REST : ses outils sont contrôlés par apps/server/src/mcp.integration.test.ts. */
  mcp?: true;
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
  // Tunnel WSS (tâche 2.7, 07 § 6) : ouverture publique (Origin d'extension, aucun paramètre d'URL), puis jeton
  // d'appareil dans le premier message ; l'utilisateur est celui du jeton (INV5), jamais un champ choisi par le client.
  { method: 'GET', url: '/api/extension/tunnel', auth: 'public' },
  { method: 'DELETE', url: '/api/admin/tunnels/:id', auth: 'session', permission: 'tunnel:revoke_other' },
  // Comptes avancés (tâche 3.7, 13 § 13.1) : second facteur, réinitialisation, OIDC, SSO public, PRM (RFC 9728).
  { method: 'POST', url: '/api/auth/two-factor/verify', auth: 'session', mfa: 'pending' },
  { method: 'POST', url: '/api/auth/password-reset/request', auth: 'public' },
  { method: 'POST', url: '/api/auth/password-reset/confirm', auth: 'public' },
  { method: 'GET', url: '/api/auth/oidc/start', auth: 'public' },
  { method: 'GET', url: '/api/auth/oidc/callback', auth: 'public' },
  { method: 'GET', url: '/api/sso', auth: 'public' },
  { method: 'GET', url: '/.well-known/oauth-protected-resource', auth: 'public' },
  // Serveur MCP (tâche 3.2, 05 § 1 et § 3) : Streamable HTTP sans état, clé d'API seulement ; chaque outil exige son scope
  // (403 insufficient_scope) et filtre par propriétaire comme la route REST qu'il appelle (INV12). GET et DELETE : 405.
  { method: 'POST', url: '/mcp', auth: 'key', mcp: true },
  { method: 'GET', url: '/mcp', auth: 'key', mcp: true },
  { method: 'DELETE', url: '/mcp', auth: 'key', mcp: true },
  { method: 'GET', url: '/.well-known/oauth-protected-resource/mcp', auth: 'public', mcp: true },
  // Compte de l'appelant : sessions, 2FA, audit.
  { method: 'POST', url: '/api/me/password', auth: 'session', permission: 'account:update' },
  { method: 'GET', url: '/api/me/sessions', auth: 'session', permission: 'account:sessions', resource: { type: 'auth_session', kind: 'collection' } },
  { method: 'DELETE', url: '/api/me/sessions', auth: 'session', permission: 'account:sessions' },
  { method: 'DELETE', url: '/api/me/sessions/:id', auth: 'session', permission: 'account:sessions', resource: { type: 'auth_session', kind: 'item' } },
  { method: 'POST', url: '/api/me/2fa/enroll', auth: 'session', permission: 'account:mfa', mfa: 'enroll' },
  { method: 'POST', url: '/api/me/2fa/confirm', auth: 'session', permission: 'account:mfa', mfa: 'enroll' },
  { method: 'POST', url: '/api/me/2fa/backup-codes', auth: 'session', permission: 'account:mfa' },
  { method: 'DELETE', url: '/api/me/2fa', auth: 'session', permission: 'account:mfa' },
  // Identités OIDC liées (13 § 7) : liaison après ré-authentification, liste et retrait par le titulaire.
  { method: 'POST', url: '/api/me/identities/oidc', auth: 'session', permission: 'account:mfa' },
  { method: 'GET', url: '/api/me/identities', auth: 'session', permission: 'account:mfa', resource: { type: 'auth_identity', kind: 'collection' } },
  { method: 'DELETE', url: '/api/me/identities/:id', auth: 'session', permission: 'account:mfa', resource: { type: 'auth_identity', kind: 'item' } },
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
  { method: 'GET', url: '/api/settings/identity', auth: 'session', permission: 'settings:identity:write' },
  { method: 'PUT', url: '/api/settings/identity', auth: 'session', permission: 'settings:identity:write' },
  { method: 'GET', url: '/api/settings/sso', auth: 'session', permission: 'settings:sso:write' },
  { method: 'PUT', url: '/api/settings/sso', auth: 'session', permission: 'settings:sso:write' },
  // API REST (tâche 3.1, 05 § 4.2) : catalogue, enquête, runs, datasets, flux SSE, planifications, webhooks, réglages,
  // droits des personnes. Scopes de clé de 13 § 8 ; lectures sous RLS, écritures au propriétaire (404 uniforme).
  { method: 'GET', url: '/api/openapi.json', auth: 'session_or_key' },
  { method: 'GET', url: '/api/events', auth: 'session_or_key', scope: 'runs:read', permission: 'runs:read', stream: true },
  { method: 'GET', url: '/api/apis', auth: 'session_or_key', scope: 'apis:read', permission: 'apis:read', resource: { type: 'api', kind: 'collection' } },
  { method: 'POST', url: '/api/apis', auth: 'session_or_key', scope: 'apis:write', permission: 'apis:create' },
  { method: 'POST', url: '/api/apis/:id/validate-schema', auth: 'session_or_key', scope: 'apis:write', permission: 'apis:create', resource: { type: 'api_investigation', kind: 'item' } },
  { method: 'GET', url: '/api/apis/:slug', auth: 'session_or_key', scope: 'apis:read', permission: 'apis:read', resource: { type: 'api', kind: 'item' } },
  { method: 'PATCH', url: '/api/apis/:slug', auth: 'session_or_key', scope: 'apis:write', permission: 'apis:update', resource: { type: 'api', kind: 'item' } },
  { method: 'DELETE', url: '/api/apis/:slug', auth: 'session_or_key', scope: 'apis:write', permission: 'apis:delete', resource: { type: 'api', kind: 'item' } },
  { method: 'POST', url: '/api/apis/:slug/runs', auth: 'session_or_key', scope: 'apis:run', permission: 'apis:run', resource: { type: 'api', kind: 'item' } },
  { method: 'POST', url: '/api/apis/:slug/investigate', auth: 'session_or_key', scope: 'apis:write', permission: 'apis:update', resource: { type: 'api', kind: 'item' } },
  { method: 'GET', url: '/api/apis/:slug/versions', auth: 'session_or_key', scope: 'apis:read', permission: 'apis:read', resource: { type: 'api', kind: 'item' } },
  { method: 'GET', url: '/api/apis/:slug/versions/:version', auth: 'session_or_key', scope: 'apis:read', permission: 'apis:read', resource: { type: 'api', kind: 'item' } },
  { method: 'GET', url: '/api/apis/:slug/versions/:version/diff', auth: 'session_or_key', scope: 'apis:read', permission: 'apis:read', resource: { type: 'api', kind: 'item' } },
  { method: 'POST', url: '/api/apis/:slug/versions/:version/revert', auth: 'session_or_key', scope: 'apis:write', permission: 'apis:update', resource: { type: 'api', kind: 'item' } },
  { method: 'GET', url: '/api/apis/:slug/status-events', auth: 'session_or_key', scope: 'apis:read', permission: 'apis:read', resource: { type: 'api', kind: 'item' } },
  // Portabilité (tâche 3.12, 16 § 6) : export (propriétaire seulement), import (repasse par l'enquête), OpenAPI par API.
  { method: 'GET', url: '/api/apis/:slug/export', auth: 'session_or_key', scope: 'apis:read', permission: 'apis:read', resource: { type: 'api', kind: 'item' } },
  { method: 'POST', url: '/api/apis/import', auth: 'session_or_key', scope: 'apis:write', permission: 'apis:create' },
  { method: 'GET', url: '/api/apis/:slug/openapi.json', auth: 'session_or_key', scope: 'apis:read', permission: 'apis:read', resource: { type: 'api', kind: 'item' } },
  { method: 'GET', url: '/api/apis/:slug/schedules', auth: 'session_or_key', scope: 'apis:read', permission: 'schedules:manage', resource: { type: 'api', kind: 'item' } },
  { method: 'POST', url: '/api/apis/:slug/schedules', auth: 'session_or_key', scope: 'schedules:write', permission: 'schedules:manage', resource: { type: 'api', kind: 'item' } },
  { method: 'GET', url: '/api/apis/:slug/schedules/:id', auth: 'session_or_key', scope: 'apis:read', permission: 'schedules:manage', resource: { type: 'schedule', kind: 'item' } },
  { method: 'PATCH', url: '/api/apis/:slug/schedules/:id', auth: 'session_or_key', scope: 'schedules:write', permission: 'schedules:manage', resource: { type: 'schedule', kind: 'item' } },
  { method: 'DELETE', url: '/api/apis/:slug/schedules/:id', auth: 'session_or_key', scope: 'schedules:write', permission: 'schedules:manage', resource: { type: 'schedule', kind: 'item' } },
  { method: 'GET', url: '/api/runs', auth: 'session_or_key', scope: 'runs:read', permission: 'runs:read', resource: { type: 'run', kind: 'collection' } },
  { method: 'GET', url: '/api/runs/:id', auth: 'session_or_key', scope: 'runs:read', permission: 'runs:read', resource: { type: 'run', kind: 'item' } },
  { method: 'POST', url: '/api/runs/:id/cancel', auth: 'session_or_key', scope: 'apis:run', permission: 'apis:run', resource: { type: 'run', kind: 'item' } },
  { method: 'POST', url: '/api/runs/:id/pause', auth: 'session_or_key', scope: 'apis:run', permission: 'apis:run', resource: { type: 'run', kind: 'item' } },
  { method: 'POST', url: '/api/runs/:id/resume', auth: 'session_or_key', scope: 'apis:run', permission: 'apis:run', resource: { type: 'run', kind: 'item' } },
  { method: 'GET', url: '/api/runs/:id/events', auth: 'session_or_key', scope: 'runs:read', permission: 'runs:read', resource: { type: 'run', kind: 'item' } },
  { method: 'GET', url: '/api/runs/:id/logs', auth: 'session_or_key', scope: 'runs:read', permission: 'runs:read', resource: { type: 'run', kind: 'item' } },
  { method: 'GET', url: '/api/datasets/:id/items', auth: 'session_or_key', scope: 'datasets:read', permission: 'datasets:read', resource: { type: 'dataset', kind: 'item' } },
  { method: 'GET', url: '/api/webhook-subscriptions', auth: 'session_or_key', scope: 'schedules:write', permission: 'schedules:manage', resource: { type: 'webhook_subscription', kind: 'collection' } },
  { method: 'POST', url: '/api/webhook-subscriptions', auth: 'session_or_key', scope: 'schedules:write', permission: 'schedules:manage' },
  { method: 'GET', url: '/api/webhook-subscriptions/:id', auth: 'session_or_key', scope: 'schedules:write', permission: 'schedules:manage', resource: { type: 'webhook_subscription', kind: 'item' } },
  { method: 'PATCH', url: '/api/webhook-subscriptions/:id', auth: 'session_or_key', scope: 'schedules:write', permission: 'schedules:manage', resource: { type: 'webhook_subscription', kind: 'item' } },
  { method: 'DELETE', url: '/api/webhook-subscriptions/:id', auth: 'session_or_key', scope: 'schedules:write', permission: 'schedules:manage', resource: { type: 'webhook_subscription', kind: 'item' } },
  { method: 'POST', url: '/api/webhook-subscriptions/:id/test', auth: 'session_or_key', scope: 'schedules:write', permission: 'schedules:manage', resource: { type: 'webhook_subscription', kind: 'item' } },
  // Réglages d'instance (08 § 7) : admin et owner, session seulement ; secrets en écriture seule (INV8).
  { method: 'GET', url: '/api/settings/llm', auth: 'session', permission: 'settings:llm:write' },
  { method: 'PUT', url: '/api/settings/llm', auth: 'session', permission: 'settings:llm:write' },
  { method: 'POST', url: '/api/settings/llm/test', auth: 'session', permission: 'settings:llm:write' },
  { method: 'GET', url: '/api/settings/proxies', auth: 'session', permission: 'settings:proxies:write' },
  { method: 'POST', url: '/api/settings/proxies', auth: 'session', permission: 'settings:proxies:write' },
  { method: 'GET', url: '/api/settings/proxies/:id', auth: 'session', permission: 'settings:proxies:write' },
  { method: 'PATCH', url: '/api/settings/proxies/:id', auth: 'session', permission: 'settings:proxies:write' },
  { method: 'DELETE', url: '/api/settings/proxies/:id', auth: 'session', permission: 'settings:proxies:write' },
  { method: 'POST', url: '/api/settings/proxies/:id/test', auth: 'session', permission: 'settings:proxies:write' },
  { method: 'GET', url: '/api/settings/smtp', auth: 'session', permission: 'settings:smtp:write' },
  { method: 'PUT', url: '/api/settings/smtp', auth: 'session', permission: 'settings:smtp:write' },
  { method: 'POST', url: '/api/settings/smtp/test', auth: 'session', permission: 'settings:smtp:write' },
  // Droits des personnes (17 § 6) : portée de l'appelant (membre : ses données ; admin : l'instance, métadonnées).
  { method: 'POST', url: '/api/subjects/export', auth: 'session' },
  { method: 'POST', url: '/api/subjects/erase', auth: 'session' },
  // Appairage de l'extension sous le nom de 05 § 4.2 et 07 § 1 (même service que /api/extension/pairing-codes).
  { method: 'POST', url: '/api/tunnel/pairing-code', auth: 'session', permission: 'tunnel:pair' },
  // Case « j'ai lu » de la page « Usage responsable » (17 § 11) : acte humain, session seulement.
  { method: 'GET', url: '/api/me/responsible-use', auth: 'session', permission: 'account:update' },
  { method: 'POST', url: '/api/me/responsible-use', auth: 'session', permission: 'account:update' },
];

const byKey = new Map(ROUTES.map((r) => [`${r.method} ${r.url}`, r]));

export function findRoute(method: string, url: string): RouteSpec | undefined {
  return byKey.get(`${method} ${url}`);
}
