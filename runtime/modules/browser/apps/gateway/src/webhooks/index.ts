// SPDX-License-Identifier: AGPL-3.0-only
// Webhooks de la passerelle (tâche 2.5) : Standard Webhooks, secret scellé, envoi sous garde réseau, livreur.
export { WEBHOOK_RETRY_DELAYS_MS, WEBHOOK_TIMEOUT_MS, createWebhookDispatcher, type WebhookDispatcher, type WebhookDispatcherOptions } from './dispatcher.js';
export { openWebhookSecret, sealWebhookSecret } from './secret.js';
export { WebhookUrlError, checkWebhookUrl, sendWebhook, type WebhookResult, type WebhookUrlProblem } from './send.js';
export { WEBHOOK_SECRET_PREFIX, generateWebhookSecret, webhookHeaders, type WebhookHeaders } from './standard.js';
