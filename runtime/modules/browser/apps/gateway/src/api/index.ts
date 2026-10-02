// SPDX-License-Identifier: AGPL-3.0-only
// API REST `/v1` de la passerelle (tâche 2.2) : application Fastify et interfaces à brancher (types.ts).
// Interfaces à implémenter (Authenticator, ConnectTokenIssuer, SessionLauncher) : voir GatewayDeps.
export { createGatewayApi } from './app.js';
export type { GatewayDeps, Principal, Scope, SessionLauncher } from './types.js';
