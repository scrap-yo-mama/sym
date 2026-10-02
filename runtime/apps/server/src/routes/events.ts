// SPDX-License-Identifier: AGPL-3.0-only
// Routes SSE (tâche 3.1, 06 § 3) : `GET /api/events` (un flux multiplexé par onglet) et `GET /api/runs/{id}/events`
// (vue filtrée d'un run ou d'une enquête, rejouée depuis le début). Trames `id:`/`event:`/`data:`, commentaire `: ping`
// périodique, reprise par `Last-Event-ID`, plafond de flux simultanés par utilisateur (429 `too_many_streams`).
import { withActor } from '@runtime/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { RunFeed, sseFrame, UserFeed, type SseFrame } from '../rest/events.js';
import { readRunRow } from '../rest/runs.js';
import { UUID } from './account-helpers.js';
import { notFound, sendError } from './guard.js';

type Feed = { poll(): Promise<SseFrame[]>; readonly done?: boolean };

export function eventRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /** Flux ouverts par utilisateur (plafond) et ensemble des flux à fermer à l'arrêt du serveur. */
  const perUser = new Map<string, number>();
  const open = new Set<AbortController>();
  app.addHook('onClose', async () => {
    for (const controller of open) controller.abort();
  });

  const lastEventId = (request: FastifyRequest): string | undefined => {
    const raw = request.headers['last-event-id'];
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  };

  /** Ouvre le flux et le nourrit jusqu'à la déconnexion, l'arrêt du serveur ou la fin du flux (run terminé). */
  async function stream(request: FastifyRequest, reply: FastifyReply, feed: Feed): Promise<FastifyReply> {
    const actor = request.actor!;
    const count = perUser.get(actor.userId) ?? 0;
    if (count >= ctx.rest.maxStreamsPerUser) {
      reply.header('retry-after', '30');
      return sendError(reply, 429, 'too_many_streams', 'trop de flux ouverts : fermez un onglet ou réessayez plus tard');
    }
    perUser.set(actor.userId, count + 1);
    const controller = new AbortController();
    open.add(controller);
    const raw = reply.raw;
    reply.hijack();
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    const closed = () => controller.abort();
    request.raw.once('close', closed);
    raw.once('close', closed);
    const write = async (chunk: string) => {
      if (controller.signal.aborted) return;
      if (!raw.write(chunk)) await new Promise<void>((resolve) => {
        raw.once('drain', resolve);
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    try {
      await write(`retry: 3000\n: connected\n\n`);
      let lastWrite = Date.now();
      while (!controller.signal.aborted) {
        const frames = await feed.poll();
        for (const frame of frames) await write(sseFrame(frame));
        if (frames.length > 0) lastWrite = Date.now();
        if (feed.done) break;
        if (Date.now() - lastWrite >= ctx.rest.pingMs) {
          await write(': ping\n\n');
          lastWrite = Date.now();
        }
        await sleep(ctx.rest.pollMs);
      }
    } catch (error) {
      request.log.warn({ err: error instanceof Error ? error.name : 'error' }, 'flux SSE interrompu');
    } finally {
      open.delete(controller);
      const left = (perUser.get(actor.userId) ?? 1) - 1;
      if (left <= 0) perUser.delete(actor.userId);
      else perUser.set(actor.userId, left);
      raw.end();
    }
    return reply;
  }

  app.get('/api/events', async (request, reply) => stream(request, reply, new UserFeed(ctx, request.actor!, lastEventId(request), ctx.rest.pollMs)));

  app.get<{ Params: { id: string } }>('/api/runs/:id/events', async (request, reply) => {
    const actor = request.actor!;
    if (!UUID.test(request.params.id)) return notFound(reply);
    const run = await withActor(ctx.pool, actor, (db) => readRunRow(db, request.params.id));
    if (run === null) return notFound(reply);
    return stream(request, reply, new RunFeed(ctx, actor, run.id, lastEventId(request)));
  });
}
