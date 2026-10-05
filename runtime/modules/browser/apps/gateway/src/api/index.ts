// SPDX-License-Identifier: AGPL-3.0-only
// API REST `/v1` de la passerelle (tâche 2.2) : application Fastify et interfaces à brancher (types.ts).
// Dépendances : clés et jetons de la tâche 2.1 (ApiKeyAuthenticator, ConnectTokens), SessionLauncher : voir GatewayDeps.
export { createGatewayApi } from './app.js';
export type { EgressOutcome, GatewayDeps, LaunchRequest, Principal, Scope, SessionLauncher } from './types.js';
