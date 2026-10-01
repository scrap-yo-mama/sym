// SPDX-License-Identifier: AGPL-3.0-only
// Standard Webhooks (08 § 5, O7) : HMAC-SHA256 `v1`, secret `whsec_` (clé de 24 à 64 octets en base64), contenu signé
// `webhook-id.webhook-timestamp.corps`, plusieurs signatures dans l'en-tête (rotation), tolérance de 5 minutes,
// comparaison à temps constant. Les schémas autres que `v1` sont ignorés (anti-repli). Sans I/O.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
export const WEBHOOK_TOLERANCE_SECONDS = 300;
const MIN_KEY_BYTES = 24;
const MAX_KEY_BYTES = 64;

export class WebhookSecretError extends Error {
  override name = 'WebhookSecretError';
}

export type WebhookVerificationFailure = 'missing_headers' | 'invalid_timestamp' | 'timestamp_out_of_tolerance' | 'no_valid_signature' | 'no_secret';

export class WebhookVerificationError extends Error {
  override name = 'WebhookVerificationError';
  readonly reason: WebhookVerificationFailure;
  constructor(reason: WebhookVerificationFailure) {
    super(`webhook : ${reason}`);
    this.reason = reason;
  }
}

/** Nouveau secret `whsec_<base64 de 32 octets>`. Affiché une fois, chiffré au repos (INV8) par l'appelant. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64')}`;
}

function keyOf(secret: string): Buffer {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) throw new WebhookSecretError(`secret de webhook sans préfixe ${WEBHOOK_SECRET_PREFIX}`);
  const key = Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64');
  if (key.length < MIN_KEY_BYTES || key.length > MAX_KEY_BYTES) {
    throw new WebhookSecretError(`secret de webhook : clé de ${MIN_KEY_BYTES} à ${MAX_KEY_BYTES} octets attendue`);
  }
  return key;
}

export type SignedMessage = { id: string; timestamp: number; body: string };

function digest(message: SignedMessage, key: Buffer): string {
  return createHmac('sha256', key).update(`${message.id}.${message.timestamp}.${message.body}`).digest('base64');
}

/** Valeur de `webhook-signature` : une signature `v1,<base64>` par secret valide, séparées par une espace. */
export function signWebhook(message: SignedMessage, secrets: readonly string[]): string {
  if (secrets.length === 0) throw new WebhookSecretError('aucun secret de signature');
  return secrets.map((s) => `v1,${digest(message, keyOf(s))}`).join(' ');
}

export type WebhookHeaders = {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
  /** Identifie la livraison (un événement, une cible) pour l'idempotence côté récepteur. */
  'dispatch-id': string;
};

/** En-têtes d'une tentative : `webhook-id` stable d'une relance à l'autre, horodatage et signature frais à chaque envoi. */
export function webhookHeaders(input: { id: string; dispatchId: string; body: string; secrets: readonly string[]; now: Date }): WebhookHeaders {
  const timestamp = Math.floor(input.now.getTime() / 1000);
  return {
    'webhook-id': input.id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signWebhook({ id: input.id, timestamp, body: input.body }, input.secrets),
    'dispatch-id': input.dispatchId,
  };
}

const header = (headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string | undefined => {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  return undefined;
};

/**
 * Vérification côté récepteur (sert aux tests et à « Tester » dans la console). Lève `WebhookVerificationError`.
 * Une signature valide pour UN des secrets suffit (rotation).
 */
export function verifyWebhook(input: {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
  secrets: readonly string[];
  now?: Date;
  toleranceSeconds?: number;
}): void {
  if (input.secrets.length === 0) throw new WebhookVerificationError('no_secret');
  const id = header(input.headers, 'webhook-id');
  const rawTimestamp = header(input.headers, 'webhook-timestamp');
  const signatures = header(input.headers, 'webhook-signature');
  if (!id || !rawTimestamp || !signatures) throw new WebhookVerificationError('missing_headers');
  if (!/^\d{1,12}$/.test(rawTimestamp)) throw new WebhookVerificationError('invalid_timestamp');
  const timestamp = Number(rawTimestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) {
    throw new WebhookVerificationError('timestamp_out_of_tolerance');
  }
  const message = { id, timestamp, body: input.body };
  const candidates = signatures
    .split(' ')
    .filter((s) => s.startsWith('v1,'))
    .map((s) => Buffer.from(s.slice(3), 'base64'));
  let valid = false;
  for (const secret of input.secrets) {
    const expected = Buffer.from(digest(message, keyOf(secret)), 'base64');
    for (const candidate of candidates) {
      // Pas de court-circuit : la durée ne dépend pas du rang de la signature valide.
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) valid = true;
    }
  }
  if (!valid) throw new WebhookVerificationError('no_valid_signature');
}
