// SPDX-License-Identifier: AGPL-3.0-only
// Webhooks sortants Standard Webhooks (tâche 2.5) : signature, vérification, événements, barème. Sans I/O.
// L'envoi lui-même (garde SSRF) est `deliverWebhook`, dans `@runtime/core/net`.
export * from './standard.js';
export * from './events.js';
