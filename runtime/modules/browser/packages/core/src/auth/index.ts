// SPDX-License-Identifier: AGPL-3.0-only
// Authentification de SYM Browser (tâche 2.1, BINV7) : clés d'API argon2id à préfixe affiché, scopes fermés, expiration et
// révocation ; jetons de connexion HMAC par session et protocole ; premier démarrage. Pur : le stockage est injecté
// (`pgApiKeyStore` de @sym-browser/db). Branchement de l'API REST (2.2) et du relais WSS (2.3) : voir le CLAUDE.md du module.
export * from './access.js';
export * from './api-key.js';
export * from './authenticator.js';
export * from './bootstrap.js';
export * from './connect-token.js';
export * from './hash.js';
export * from './scopes.js';
