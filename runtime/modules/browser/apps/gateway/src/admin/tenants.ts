// SPDX-License-Identifier: AGPL-3.0-only
// Réglages d'un client par son admin (scope `admin`, 03 § 6 : « chaque client configure son webhookUrl ») — tâche 2.5, partie
// webhook de `/v1/admin/tenants` (04 § 2) : `GET` et `PATCH /v1/admin/tenants/{id}` sur le client de la clé (un autre client
// répond 404, BINV7). L'URL passe la garde réseau de l'egress (refus précoce ; l'envoi la recontrôle). Le secret `whsec_` est
// tiré à la première URL ou sur `rotateWebhookSecret`, rendu UNE fois, scellé au repos ; `webhookUrl: null` efface les deux.
// Création des clients et quotas (admin d'instance) : tâches 2.1, 2.4 et 3.5.
import { getTenantWebhook, setTenantWebhook } from '@sym-browser/db';
import type { EgressGuard, Keys } from '@sym-browser/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ApiProblem, invalidOption } from '../api/errors.js';
import { UUID } from '../api/validation.js';
import type { Principal, Scope } from '../api/types.js';
import { sealWebhookSecret } from '../webhooks/secret.js';
import { WebhookUrlError, checkWebhookUrl } from '../webhooks/send.js';
import { generateWebhookSecret } from '../webhooks/standard.js';

const MAX_URL_LENGTH = 2_048;

export type TenantView = { id: string; name: string; webhookUrl: string | null; webhookSecretSet: boolean };

type Deps = {
  db: pg.Pool;
  authorize: (scope: Scope) => (request: FastifyRequest) => Promise<void>;
  principalOf: (request: FastifyRequest) => Principal;
  guard: EgressGuard;
  keys: Keys;
};

/**
 * Client inconnu ou autre que celui de la clé : 404. Le contrat (`ERROR_CODES`) n'a pas encore de code « client introuvable »
 * (changement de contrat : tâche séparée) ; le corps porte `invalid_option` sur le champ `id`.
 */
class TenantNotFound extends ApiProblem {
  override get status(): number {
    return 404;
  }
}
const notFound = (): ApiProblem => new TenantNotFound('invalid_option', 'Unknown tenant.', { details: [{ field: 'id', reason: 'unknown tenant' }] });

function parsePatch(body: unknown): { webhookUrl?: string | null; rotateWebhookSecret: boolean } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalidOption([{ field: '', reason: 'JSON object expected' }]);
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'webhookUrl' && key !== 'rotateWebhookSecret') throw invalidOption([{ field: key, reason: 'unknown field' }]);
  }
  const url = record['webhookUrl'];
  if (url !== undefined && url !== null && (typeof url !== 'string' || url.length > MAX_URL_LENGTH)) throw invalidOption([{ field: 'webhookUrl', reason: 'URL string or null expected' }]);
  const rotate = record['rotateWebhookSecret'];
  if (rotate !== undefined && typeof rotate !== 'boolean') throw invalidOption([{ field: 'rotateWebhookSecret', reason: 'boolean expected' }]);
  return { ...(url === undefined ? {} : { webhookUrl: url as string | null }), rotateWebhookSecret: rotate === true };
}

export function registerTenantRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  /** Client de la clé seulement : l'identifiant d'un autre client répond comme un client inconnu. */
  const ownTenant = (request: FastifyRequest): string => {
    const id = (request.params as { id: string }).id;
    if (!UUID.test(id) || id !== deps.principalOf(request).tenantId) throw notFound();
    return id;
  };

  const view = async (tenantId: string): Promise<TenantView> => {
    const { rows } = await db.query<{ name: string; webhook_url: string | null; webhook_secret_encrypted: string | null }>(
      'SELECT name, webhook_url, webhook_secret_encrypted FROM tenants WHERE id = $1::uuid',
      [tenantId],
    );
    const row = rows[0];
    if (row === undefined) throw notFound();
    return { id: tenantId, name: row.name, webhookUrl: row.webhook_url, webhookSecretSet: row.webhook_url !== null && row.webhook_secret_encrypted !== null };
  };

  app.get('/v1/admin/tenants/:id', { preHandler: deps.authorize('admin') }, async (request) => view(ownTenant(request)));

  app.patch('/v1/admin/tenants/:id', { preHandler: deps.authorize('admin') }, async (request) => {
    const tenantId = ownTenant(request);
    const patch = parsePatch(request.body);
    const current = await getTenantWebhook(db, tenantId);
    if (current === null) throw notFound();
    const url = patch.webhookUrl === undefined ? current.url : patch.webhookUrl;
    if (url === null) {
      await setTenantWebhook(db, { tenantId, url: null, secretEncrypted: null });
      return view(tenantId);
    }
    if (patch.webhookUrl !== undefined) {
      try {
        await checkWebhookUrl(url, deps.guard);
      } catch (error) {
        if (error instanceof WebhookUrlError) throw invalidOption([{ field: 'webhookUrl', reason: error.reason }]);
        throw error;
      }
    }
    let secret: string | undefined;
    let sealed = current.secretEncrypted;
    if (sealed === null || patch.rotateWebhookSecret) {
      secret = generateWebhookSecret();
      sealed = sealWebhookSecret(secret, deps.keys, tenantId);
    }
    await setTenantWebhook(db, { tenantId, url, secretEncrypted: sealed });
    return { ...(await view(tenantId)), ...(secret === undefined ? {} : { webhookSecret: secret }) };
  });
}
