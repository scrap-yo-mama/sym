// SPDX-License-Identifier: AGPL-3.0-only
// Standard Webhooks (https://www.standardwebhooks.com, spécification 1.0) : secret `whsec_<base64>`, signature `v1` =
// base64(HMAC-SHA256(clé, `webhook-id.webhook-timestamp.corps`)), en-têtes `webhook-id` (stable d'une relance à l'autre),
// `webhook-timestamp` (secondes Unix de l'envoi), `webhook-signature`. Même schéma que les webhooks de SYM
// (`runtime/packages/core/src/webhook/standard.ts`, lu sans être importé). Vérifié par la bibliothèque de référence
// `standardwebhooks` dans les tests. Sans I/O.
import { createHmac, randomBytes } from 'node:crypto';

const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** Nouveau secret : 32 octets aléatoires. Affiché une seule fois, scellé au repos par l'appelant (BINV6). */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64')}`;
}

function keyOf(secret: string): Buffer {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) throw new Error('secret de webhook sans préfixe whsec_');
  const key = Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64');
  if (key.length < 24 || key.length > 64) throw new Error('secret de webhook : clé de 24 à 64 octets attendue');
  return key;
}

export type WebhookHeaders = { 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string };

/** En-têtes d'une tentative : horodatage et signature frais à chaque envoi, `webhook-id` inchangé. */
export function webhookHeaders(input: { id: string; body: string; secret: string; now: Date }): WebhookHeaders {
  const timestamp = Math.floor(input.now.getTime() / 1000);
  const signature = createHmac('sha256', keyOf(input.secret)).update(`${input.id}.${timestamp}.${input.body}`).digest('base64');
  return { 'webhook-id': input.id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${signature}` };
}
