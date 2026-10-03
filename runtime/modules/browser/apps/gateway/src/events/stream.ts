// SPDX-License-Identifier: AGPL-3.0-only
// Un flux SSE d'événements (tâche 2.5 ; WHATWG HTML § 9.2 « Server-sent events ») : `id` = identifiant de `session_events`,
// `event` = type, `data` = `SessionEvent` du contrat ({type, sessionId, at, data}). Déroulé sans perte :
//   1. abonnement au concentrateur (les notifications reçues pendant le rejeu sont mises de côté) ;
//   2. rejeu depuis la base strictement après `Last-Event-ID` ; sans lui, le flux d'une session rejoue toute son histoire et
//      celui du client part de maintenant (plancher lu après l'abonnement : ni trou, ni rejeu de tout l'historique) ;
//   3. direct : notifications filtrées par client (et session), dans l'ordre des validations, sans doublon ;
//   4. reconnexion du concentrateur : relecture de la base depuis le dernier identifiant envoyé.
// Le flux d'une session se ferme après son état final ; celui du client reste ouvert. Battement `: ping` ; un client trop
// lent (plus de 1 Mio en attente) est coupé et reprend par `Last-Event-ID`.
import type { ServerResponse } from 'node:http';
import { isTerminal } from '@sym-browser/core';
import { getSessionEvent, listSessionEvents, type SessionEventNotification, type StoredSessionEvent } from '@sym-browser/db';
import type { SessionState } from '@sym/contracts/browser';
import type pg from 'pg';
import type { EventHub } from './hub.js';

const REPLAY_PAGE = 500;
const MAX_BUFFERED_BYTES = 1_048_576;
const RECENT_IDS = 4_096;

type StreamScope = { tenantId: string; sessionId?: string };

export type StreamOptions = {
  db: pg.Pool;
  hub: EventHub;
  scope: StreamScope;
  /** Dernier identifiant reçu par le client (`Last-Event-ID`). */
  afterId: string | undefined;
  /** Sans `Last-Event-ID` : rejouer l'histoire (session) ou partir de maintenant (client). */
  replayHistory: boolean;
  /** Session déjà terminée à l'ouverture : le flux se ferme après le rejeu. */
  sessionFinished?: boolean;
  heartbeatMs: number;
  /** En-têtes ajoutés à la réponse (`x-request-id`). */
  headers: Record<string, string>;
  onError: (error: unknown) => void;
  /** Appelé à la fermeture du flux (suivi des flux ouverts). */
  onClose: () => void;
};

export type OpenStream = { end(): void };

function frame(event: StoredSessionEvent): string {
  const body = { type: event.type, sessionId: event.sessionId, at: event.at.toISOString(), data: event.data };
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(body)}\n\n`;
}

const isFinalState = (event: Pick<StoredSessionEvent, 'type' | 'data'>): boolean =>
  event.type === 'state' && typeof event.data.state === 'string' && isTerminal(event.data.state as SessionState);

export function serveEventStream(raw: ServerResponse, options: StreamOptions): OpenStream {
  const { db, hub, scope } = options;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...options.headers,
  });
  raw.write('retry: 3000\n\n');

  let cursor = options.afterId;
  let replaying = true;
  let finished = false;
  const parked: SessionEventNotification[] = [];
  const recent = new Set<string>();
  const remember = (id: string): void => {
    recent.add(id);
    if (recent.size > RECENT_IDS) recent.delete(recent.values().next().value as string);
  };
  let chain: Promise<void> = Promise.resolve();
  const later = (work: () => Promise<void>): void => {
    chain = chain.then(work).catch((error: unknown) => {
      options.onError(error);
      end();
    });
  };

  const heartbeat = setInterval(() => {
    if (!finished) raw.write(': ping\n\n');
  }, options.heartbeatMs);
  heartbeat.unref();

  let unsubscribe: () => void = () => undefined;
  const end = (): void => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!raw.writableEnded) raw.end();
    options.onClose();
  };

  const send = (event: StoredSessionEvent): void => {
    if (finished || recent.has(event.id)) return;
    remember(event.id);
    if (cursor === undefined || BigInt(event.id) > BigInt(cursor)) cursor = event.id;
    raw.write(frame(event));
    if (raw.writableLength > MAX_BUFFERED_BYTES) {
      // Client trop lent : coupure ; il reprend par Last-Event-ID.
      raw.destroy();
      end();
      return;
    }
    if (scope.sessionId !== undefined && isFinalState(event)) end();
  };

  /** Départ « maintenant » : rien d'antérieur au plancher, même reçu en notification pendant l'ouverture. */
  let floor: bigint | undefined;
  const matches = (event: SessionEventNotification): boolean =>
    event.tenantId === scope.tenantId && (scope.sessionId === undefined || event.sessionId === scope.sessionId) && (floor === undefined || BigInt(event.id) > floor);

  const deliver = async (note: SessionEventNotification): Promise<void> => {
    if (finished || recent.has(note.id)) return;
    if (note.data !== undefined) {
      send({ id: note.id, sessionId: note.sessionId, tenantId: note.tenantId, type: note.type, at: note.at, data: note.data });
      return;
    }
    // Notification sans données (trop grosses pour `pg_notify`) : relues en base.
    const stored = await getSessionEvent(db, { tenantId: scope.tenantId, id: note.id });
    if (stored !== null) send(stored);
  };

  /** Relecture de la base après le dernier identifiant envoyé (rejeu, ou rattrapage après reconnexion). */
  const catchUp = async (): Promise<void> => {
    for (;;) {
      if (finished) return;
      const page = await listSessionEvents(db, { ...scope, ...(cursor === undefined ? {} : { afterId: cursor }), limit: REPLAY_PAGE });
      for (const event of page) send(event);
      if (page.length < REPLAY_PAGE) return;
    }
  };

  unsubscribe = hub.subscribe({
    onEvent: (note) => {
      if (!matches(note)) return;
      if (replaying) parked.push(note);
      else later(() => deliver(note));
    },
    onResync: () => later(catchUp),
  });

  raw.on('close', end);

  later(async () => {
    if (cursor === undefined && !options.replayHistory) {
      const { rows } = await db.query<{ max: string }>('SELECT coalesce(max(id), 0)::text AS max FROM session_events');
      cursor = rows[0]?.max ?? '0';
      floor = BigInt(cursor);
      parked.splice(0, parked.length, ...parked.filter(matches));
    }
    await catchUp();
    replaying = false;
    for (const note of parked.splice(0)) await deliver(note);
    if (options.sessionFinished === true) end();
  });

  return { end };
}
