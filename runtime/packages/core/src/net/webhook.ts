// SPDX-License-Identifier: AGPL-3.0-only
// Webhooks (08b §1) : même garde, mêmes exceptions (ALLOWED_PRIVATE_HOSTS), pas de variable à part.
// Squelette pour la tâche 2.5 : refus précoce à l'enregistrement, puis envoi par guardedFetch (recontrôle à la
// connexion, donc aussi après un rebinding entre l'enregistrement et l'envoi). Aucune redirection n'est suivie :
// une réponse 3xx est rendue telle quelle et vaut échec de livraison pour l'appelant.
import type { Response } from 'undici';
import { guardedFetch, type GuardedFetchOptions } from './fetch.js';
import type { SsrfGuard } from './guard.js';

/** Refus à l'enregistrement d'une URL de webhook ; lève `SsrfBlockedError`. */
export async function assertWebhookUrlAllowed(url: string, guard: SsrfGuard): Promise<URL> {
  const parsed = new URL(url);
  await guard.checkUrl(parsed);
  return parsed;
}

/** Envoi d'un webhook (POST JSON) sous garde, sans suivre de redirection. */
export function deliverWebhook(
  url: string,
  payload: unknown,
  options: GuardedFetchOptions & { headers?: Record<string, string> },
): Promise<Response> {
  return guardedFetch(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(payload),
    },
    { ...options, followRedirects: false },
  );
}
