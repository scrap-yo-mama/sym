// SPDX-License-Identifier: AGPL-3.0-only
// Webhooks (08b §1, 08 §5) : même garde, mêmes exceptions (ALLOWED_PRIVATE_HOSTS), pas de variable à part.
// Refus précoce à l'enregistrement, puis envoi par guardedFetch (recontrôle à la connexion, donc aussi après un
// rebinding entre l'enregistrement et l'envoi). Aucune redirection n'est suivie : une réponse 3xx est rendue telle
// quelle et vaut échec de livraison pour l'appelant. `sendWebhookAttempt` ajoute la signature Standard Webhooks, le
// délai de 15 s et le classement du résultat ; le barème de relance et le journal sont dans `@runtime/db`.
import type { Response } from 'undici';
import { WEBHOOK_TIMEOUT_MS } from '../webhook/events.js';
import { webhookHeaders } from '../webhook/standard.js';
import { guardedFetch, type GuardedFetchOptions } from './fetch.js';
import { findSsrfBlocked, type SsrfDenyDetail, type SsrfGuard } from './guard.js';

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
  options: GuardedFetchOptions & { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<Response> {
  return guardedFetch(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(payload),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    { ...options, followRedirects: false },
  );
}

export type WebhookAttempt = {
  httpStatus: number | null;
  durationMs: number;
  /** Début de la réponse (512 caractères au plus), pour le journal de livraison. */
  excerpt: string | null;
  error: 'ssrf_blocked' | 'timeout' | 'network' | null;
  /** Détail de la garde, réservé au journal admin : jamais renvoyé à un membre. */
  ssrf?: SsrfDenyDetail;
};

const EXCERPT_CHARS = 512;

async function excerptOf(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < EXCERPT_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  // Pas de caractère de contrôle dans le journal.
  // eslint-disable-next-line no-control-regex
  const clean = text.slice(0, EXCERPT_CHARS).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return clean === '' ? null : clean;
}

/**
 * Une tentative de livraison : signature fraîche (horodatage du moment, `webhook-id` stable), POST sous garde SSRF,
 * réponse attendue en 15 s. Le résultat dit ce qui s'est passé ; seul un secret invalide lève `WebhookSecretError`.
 */
export async function sendWebhookAttempt(input: {
  url: string;
  /** `webhook-id` : stable d'une relance à l'autre. */
  messageId: string;
  dispatchId: string;
  payload: unknown;
  secrets: readonly string[];
  guard: SsrfGuard;
  now?: Date;
  timeoutMs?: number;
  dispatcher?: GuardedFetchOptions['dispatcher'];
}): Promise<WebhookAttempt> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), input.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
  const headers = webhookHeaders({
    id: input.messageId,
    dispatchId: input.dispatchId,
    body: JSON.stringify(input.payload),
    secrets: input.secrets,
    now: input.now ?? new Date(),
  });
  try {
    const response = await deliverWebhook(input.url, input.payload, {
      guard: input.guard,
      headers,
      signal: controller.signal,
      ...(input.dispatcher ? { dispatcher: input.dispatcher } : {}),
    });
    const excerpt = await excerptOf(response);
    return { httpStatus: response.status, durationMs: Date.now() - started, excerpt, error: null };
  } catch (error) {
    const blocked = findSsrfBlocked(error);
    if (blocked) return { httpStatus: null, durationMs: Date.now() - started, excerpt: null, error: 'ssrf_blocked', ssrf: blocked.detail };
    return { httpStatus: null, durationMs: Date.now() - started, excerpt: null, error: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
