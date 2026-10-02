// SPDX-License-Identifier: AGPL-3.0-only
// Livreur des webhooks d'une passerelle (tâche 2.5) : relève à intervalle court les livraisons dues (mises en file par la base
// avec l'événement, migration 0003), les réserve sous bail (`SKIP LOCKED` : plusieurs passerelles, une seule livraison), les
// signe (Standard Webhooks, secret du client rouvert en mémoire) et les envoie sous la garde réseau. Succès : 2xx. Sinon,
// relance au même `webhook-id` selon le barème, puis `failed`. Charges minces : la session (état, raison, usage, metadata) ou
// les données de `recording.ready`, jamais d'URL de connexion, de jeton ni de secret.
import { claimWebhookDeliveries, completeWebhookDelivery, getSessionView, getTenantWebhook, type ClaimedWebhookDelivery } from '@sym-browser/db';
import type { EgressGuard, Keys } from '@sym-browser/core';
import type pg from 'pg';
import { openWebhookSecret } from './secret.js';
import { sendWebhook } from './send.js';
import { webhookHeaders } from './standard.js';

/** Délai avant chaque tentative, en ms : immédiat, 5 s, 5 min, 30 min, 2 h (barème de SYM, à valider). */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [0, 5_000, 300_000, 1_800_000, 7_200_000];
/** Une réponse 2xx dans les 15 s vaut livraison. */
export const WEBHOOK_TIMEOUT_MS = 15_000;

export type WebhookDispatcherOptions = {
  db: pg.Pool;
  guard: EgressGuard;
  keys: Keys;
  /** Période de relève (1 s par défaut). */
  pollMs?: number;
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
  /** Livraisons réservées par relève (10 par défaut). */
  batch?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
};

export type WebhookDispatcher = {
  start(): void;
  /** Arrête la relève et attend la fin des envois en cours. */
  stop(): Promise<void>;
  /** Une relève (tests, arrêt gracieux). Rend le nombre de livraisons traitées. */
  runOnce(): Promise<number>;
};

async function payloadOf(db: pg.Pool, delivery: ClaimedWebhookDelivery): Promise<Record<string, unknown>> {
  const timestamp = delivery.event.at.toISOString();
  if (delivery.type === 'recording.ready') {
    return { type: delivery.type, timestamp, data: { sessionId: delivery.sessionId, ...delivery.event.data } };
  }
  const view = await getSessionView(db, { tenantId: delivery.tenantId, sessionId: delivery.sessionId });
  const session = {
    id: delivery.sessionId,
    state: delivery.event.data.state,
    ...(delivery.event.data.endReason === undefined ? {} : { endReason: delivery.event.data.endReason }),
    ...(view === null
      ? {}
      : {
          type: view.type,
          createdAt: view.createdAt.toISOString(),
          ...(view.usage === null ? {} : { usage: view.usage }),
          metadata: view.metadata,
        }),
  };
  return { type: delivery.type, timestamp, data: { session } };
}

export function createWebhookDispatcher(options: WebhookDispatcherOptions): WebhookDispatcher {
  const { db, guard, keys } = options;
  const delays = options.retryDelaysMs ?? WEBHOOK_RETRY_DELAYS_MS;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const batch = options.batch ?? 10;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<number> | undefined;
  let stopped = true;

  const deliver = async (delivery: ClaimedWebhookDelivery): Promise<void> => {
    const hook = await getTenantWebhook(db, delivery.tenantId);
    if (hook === null || hook.secretEncrypted === null) {
      await completeWebhookDelivery(db, { id: delivery.id, outcome: { kind: 'failed', httpStatus: null, error: 'no_secret' } });
      return;
    }
    const secret = openWebhookSecret(hook.secretEncrypted, keys, delivery.tenantId);
    const body = JSON.stringify(await payloadOf(db, delivery));
    const result = await sendWebhook({ url: delivery.url, guard, headers: { ...webhookHeaders({ id: delivery.id, body, secret, now: now() }) }, body, timeoutMs });
    if ('status' in result && result.status >= 200 && result.status < 300) {
      await completeWebhookDelivery(db, { id: delivery.id, outcome: { kind: 'delivered', httpStatus: result.status } });
      return;
    }
    const httpStatus = 'status' in result ? result.status : null;
    const error = 'status' in result ? `http_${result.status}` : result.error;
    const delay = delays[delivery.attempts];
    await completeWebhookDelivery(db, {
      id: delivery.id,
      outcome: delay === undefined ? { kind: 'failed', httpStatus, error } : { kind: 'retry', at: new Date(now().getTime() + delay), httpStatus, error },
    });
  };

  const runOnce = async (): Promise<number> => {
    const claimed = await claimWebhookDeliveries(db, { limit: batch, lockMs: timeoutMs + 5_000 });
    await Promise.all(
      claimed.map((delivery) =>
        deliver(delivery).catch(async (error: unknown) => {
          onError(error);
          const delay = delays[delivery.attempts];
          await completeWebhookDelivery(db, {
            id: delivery.id,
            outcome: delay === undefined ? { kind: 'failed', httpStatus: null, error: 'internal' } : { kind: 'retry', at: new Date(now().getTime() + delay), httpStatus: null, error: 'internal' },
          }).catch(onError);
        }),
      ),
    );
    return claimed.length;
  };

  const tick = (): void => {
    if (stopped) return;
    running = runOnce()
      .catch((error: unknown) => {
        onError(error);
        return 0;
      })
      .finally(() => {
        running = undefined;
        if (!stopped) {
          timer = setTimeout(tick, options.pollMs ?? 1_000);
          timer.unref();
        }
      });
  };

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      tick();
    },
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
    runOnce,
  };
}
