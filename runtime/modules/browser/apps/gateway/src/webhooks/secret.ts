// SPDX-License-Identifier: AGPL-3.0-only
// Secret de webhook d'un client scellé au repos (BINV6) par l'enveloppe AES-256-GCM de la tâche 0.3, AAD
// `webhook_secret|tenantId` (une ligne copiée chez un autre client ne s'ouvre pas). Ouvert en mémoire à chaque envoi et inscrit
// au registre de masquage des journaux.
import { buildAad, kekForSealed, openSecret, parseSealed, sealSecret, secretValues, serializeSealed, type Keys } from '@sym-browser/core';

const aadOf = (tenantId: string): string => buildAad(['webhook_secret', tenantId]);

export function sealWebhookSecret(secret: string, keys: Keys, tenantId: string): string {
  return serializeSealed(sealSecret(secret, keys.current, aadOf(tenantId)));
}

export function openWebhookSecret(text: string, keys: Keys, tenantId: string): string {
  const sealed = parseSealed(text);
  const secret = openSecret(sealed, kekForSealed(keys, sealed), aadOf(tenantId));
  secretValues.add(secret);
  return secret;
}
