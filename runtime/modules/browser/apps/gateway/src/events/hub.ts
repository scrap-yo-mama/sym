// SPDX-License-Identifier: AGPL-3.0-only
// Concentrateur des événements de session de la passerelle (tâche 2.5) : UNE connexion PostgreSQL dédiée en `LISTEN` sur
// `symb_session_events`, partagée par tous les flux SSE du processus. Les notifications arrivent à la validation de chaque
// événement, dans l'ordre des validations, quel que soit l'écrivain (nœud, balayeur, API). Connexion perdue : reconnexion
// avec délai croissant, puis `onResync` pour que chaque flux relise la base depuis son dernier identifiant (rien de perdu).
import { SESSION_EVENTS_CHANNEL, parseSessionEventNotification, type SessionEventNotification } from '@sym-browser/db';
import pg from 'pg';

/** Nom de la connexion d'écoute (visible dans `pg_stat_activity`). */
export const EVENTS_APPLICATION_NAME = 'symb-gateway-events';

export type HubListener = {
  onEvent(event: SessionEventNotification): void;
  /** La connexion d'écoute a été rétablie : des notifications ont pu manquer, relire la base. */
  onResync(): void;
};

export type EventHub = {
  subscribe(listener: HubListener): () => void;
  /** Résolu quand la première écoute est active. */
  ready(): Promise<void>;
  close(): Promise<void>;
};

export type EventHubOptions = {
  /** Paramètres de connexion (ceux du pool de la passerelle). */
  connection: pg.ClientConfig;
  onError?: (error: unknown) => void;
  /** Délai initial de reconnexion (250 ms), doublé jusqu'à 5 s. */
  reconnectMs?: number;
};

export function createEventHub(options: EventHubOptions): EventHub {
  const listeners = new Set<HubListener>();
  const onError = options.onError ?? (() => undefined);
  const initialDelay = options.reconnectMs ?? 250;
  let client: pg.Client | undefined;
  let closed = false;
  let delay = initialDelay;
  let timer: NodeJS.Timeout | undefined;
  let resolveReady: () => void = () => undefined;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const dispatch = (payload: string | undefined): void => {
    let event: SessionEventNotification;
    try {
      event = parseSessionEventNotification(payload ?? '');
    } catch (error) {
      onError(error);
      return;
    }
    for (const listener of [...listeners]) listener.onEvent(event);
  };

  const connect = async (resync: boolean): Promise<void> => {
    if (closed) return;
    const next = new pg.Client({ ...options.connection, application_name: EVENTS_APPLICATION_NAME });
    let lost = false;
    const onLost = (error?: unknown): void => {
      if (lost) return;
      lost = true;
      if (error !== undefined && !closed) onError(error);
      if (client === next) client = undefined;
      next.removeAllListeners('notification');
      void next.end().catch(() => undefined);
      schedule();
    };
    next.on('error', onLost);
    next.on('end', () => onLost());
    next.on('notification', (message) => {
      if (message.channel === SESSION_EVENTS_CHANNEL) dispatch(message.payload);
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${SESSION_EVENTS_CHANNEL}`);
    } catch (error) {
      onLost(error);
      return;
    }
    if (closed) {
      await next.end().catch(() => undefined);
      return;
    }
    client = next;
    delay = initialDelay;
    resolveReady();
    if (resync) for (const listener of [...listeners]) listener.onResync();
  };

  const schedule = (): void => {
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void connect(true);
    }, delay);
    timer.unref();
    delay = Math.min(delay * 2, 5_000);
  };

  void connect(false);

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    ready: () => readyPromise,
    close: async () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      listeners.clear();
      const current = client;
      client = undefined;
      if (current !== undefined) {
        current.removeAllListeners();
        current.on('error', () => undefined);
        await current.end().catch(() => undefined);
      }
    },
  };
}
