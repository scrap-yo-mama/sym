// SPDX-License-Identifier: AGPL-3.0-only
// Webhooks de la passerelle (tâche 2.5) : Standard Webhooks, secret scellé, envoi sous garde réseau, livreur.
export { createWebhookDispatcher, type WebhookDispatcher, type WebhookDispatcherOptions } from './dispatcher.js';
export { openWebhookSecret, sealWebhookSecret } from './secret.js';
export { WebhookUrlError, checkWebhookUrl, sendWebhook, type WebhookResult, type WebhookUrlProblem } from './send.js';
export { generateWebhookSecret, webhookHeaders, type WebhookHeaders } from './standard.js';
