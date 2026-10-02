// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.5 (04 § 2, 04d § 6, 03 § 5) : flux SSE des événements, par session (`GET /v1/sessions/{id}/events`) et par client
// (`GET /v1/events`), scope `sessions:read`. Rejeu depuis `session_events` puis direct (notifications PostgreSQL), reprise
// par `Last-Event-ID` (en-tête, ou `lastEventId` en requête pour les clients sans en-tête), battement `: ping`, fin du flux de
// session après son état final. Un client ne voit jamais les événements d'un autre (BINV7).
import { appendSessionEvent, transitionSession } from '@sym-browser/db';
import { SESSION_EVENT_TYPES, SESSION_STATES } from '@sym/contracts/browser';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../../test/helpers/harness.js';
import { eventOf, openSse, type SseStream } from '../../test/helpers/sse.js';

let h: Harness;
let base: string;
const streams: SseStream[] = [];

beforeAll(async () => {
  h = await createHarness({ events: { heartbeatMs: 200 } });
  base = await h.listen();
});
afterAll(async () => {
  for (const s of streams) s.close();
  await h.close();
});

async function open(path: string, key: keyof Harness['keys'] | null = 'a', headers: Record<string, string> = {}): Promise<SseStream> {
  const stream = await openSse(`${base}${path}`, { ...(key === null ? {} : { authorization: `Bearer ${h.keys[key]}` }), ...headers });
  streams.push(stream);
  return stream;
}

async function newSession(key: 'a' | 'b' = 'a'): Promise<string> {
  const created = await h.call({ method: 'POST', url: '/v1/sessions', key, body: { type: 'dedicated' } });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

describe('flux SSE d’une session', () => {
  test('rejeu depuis le début puis fin du flux après l’état final ; trames au format du contrat (id, event, data SessionEvent)', async () => {
    const id = await newSession();
    await appendSessionEvent(h.pool, { sessionId: id, type: 'egress.blocked', data: { host: 'site-b.test', reason: 'domain_not_allowed', count: 1 } });
    await h.call({ method: 'DELETE', url: `/v1/sessions/${id}` });
    const stream = await open(`/v1/sessions/${id}/events`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('cache-control')).toContain('no-store');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    await stream.ended;
    expect(stream.frames.map((f) => [f.event, eventOf(f).data.state ?? eventOf(f).data.reason])).toEqual([
      ['state', 'running'],
      ['egress.blocked', 'domain_not_allowed'],
      ['state', 'ended'],
    ]);
    for (const frame of stream.frames) {
      const event = eventOf(frame);
      expect(frame.id).toMatch(/^\d+$/);
      expect(Object.keys(event).sort()).toEqual(['at', 'data', 'sessionId', 'type']);
      expect(event.sessionId).toBe(id);
      expect(event.type).toBe(frame.event);
      expect(SESSION_EVENT_TYPES).toContain(event.type);
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }
    expect(SESSION_STATES).toContain(eventOf(stream.frames[2] ?? stream.frames[0]!).data.state);
  });

  test('direct : un événement écrit pendant que le flux est ouvert arrive en moins de 500 ms', async () => {
    const id = await newSession();
    const stream = await open(`/v1/sessions/${id}/events`);
    await stream.waitFor((f) => f.length >= 1);
    const written = Date.now();
    await appendSessionEvent(h.pool, { sessionId: id, type: 'egress.blocked', data: { host: 'site-c.test', reason: 'port_not_allowed', port: 8443, count: 1 } });
    const frames = await stream.waitFor((f) => f.some((x) => x.event === 'egress.blocked'), 2_000);
    const frame = frames.find((x) => x.event === 'egress.blocked');
    expect(frame).toBeDefined();
    expect((frame?.receivedAt ?? Infinity) - written).toBeLessThan(500);
    expect(eventOf(frame!).data).toEqual({ host: 'site-c.test', reason: 'port_not_allowed', port: 8443, count: 1 });
    await h.call({ method: 'DELETE', url: `/v1/sessions/${id}` });
    await stream.ended;
    expect(stream.frames.at(-1)?.event).toBe('state');
    expect(eventOf(stream.frames.at(-1)!).data).toMatchObject({ state: 'ended', endReason: 'released' });
  });

  test('reprise par Last-Event-ID (en-tête) ou lastEventId (requête) : seulement les événements suivants, sans doublon ni trou', async () => {
    const id = await newSession();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await appendSessionEvent(h.pool, { sessionId: id, type: 'live.input', data: { n: i } })).id);
    await h.call({ method: 'DELETE', url: `/v1/sessions/${id}` });
    const all = await open(`/v1/sessions/${id}/events`);
    await all.ended;
    const resumed = await open(`/v1/sessions/${id}/events`, 'a', { 'last-event-id': ids[1] ?? '' });
    await resumed.ended;
    expect(resumed.frames.map((f) => f.id)).toEqual(all.frames.map((f) => f.id).slice(all.frames.findIndex((f) => f.id === ids[1]) + 1));
    const query = await open(`/v1/sessions/${id}/events?lastEventId=${ids[2]}`);
    await query.ended;
    expect(query.frames.map((f) => eventOf(f).data.n ?? eventOf(f).data.state)).toEqual([3, 'ended']);
  });

  test('reprise pendant le direct : rien de perdu entre le rejeu et l’abonnement', async () => {
    const id = await newSession();
    const writer = (async () => {
      for (let i = 0; i < 40; i++) await appendSessionEvent(h.pool, { sessionId: id, type: 'live.input', data: { n: i } });
    })();
    const stream = await open(`/v1/sessions/${id}/events`);
    await writer;
    await h.call({ method: 'DELETE', url: `/v1/sessions/${id}` });
    await stream.ended;
    const inputs = stream.frames.filter((f) => f.event === 'live.input').map((f) => eventOf(f).data.n);
    expect(inputs).toEqual(Array.from({ length: 40 }, (_, i) => i));
    const ids = stream.frames.map((f) => BigInt(f.id ?? '0'));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('battement `: ping` sur un flux silencieux', async () => {
    const id = await newSession();
    const stream = await open(`/v1/sessions/${id}/events`);
    const end = Date.now() + 2_000;
    while (stream.comments.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(stream.comments).toContain('ping');
    stream.close();
  });

  test('accès : sans clé 401, scope sessions:read requis (403), session d’un autre client 404, Last-Event-ID invalide 422', async () => {
    const id = await newSession();
    expect((await open(`/v1/sessions/${id}/events`, null)).status).toBe(401);
    expect((await open(`/v1/sessions/${id}/events`, 'aAdmin')).status).toBe(403);
    const other = await open(`/v1/sessions/${id}/events`, 'b');
    expect(other.status).toBe(404);
    expect(other.body).toMatchObject({ error: { code: 'session_not_found' } });
    expect((await open(`/v1/sessions/00000000-0000-4000-8000-000000000000/events`)).status).toBe(404);
    const bad = await open(`/v1/sessions/${id}/events`, 'a', { 'last-event-id': 'abc' });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ error: { code: 'invalid_option', details: [{ field: 'Last-Event-ID' }] } });
  });
});

describe('flux SSE du client (toutes ses sessions)', () => {
  test('événements de toutes les sessions du client, jamais ceux d’un autre client ; part de maintenant ; reste ouvert ; reprise par Last-Event-ID', async () => {
    const older = await newSession('a');
    await appendSessionEvent(h.pool, { sessionId: older, type: 'live.input', data: { avant: true } });
    const stream = await open('/v1/events');
    await new Promise((r) => setTimeout(r, 100));
    const mine = await newSession('a');
    const theirs = await newSession('b');
    await appendSessionEvent(h.pool, { sessionId: theirs, type: 'egress.blocked', data: { host: 'secret-b.test', reason: 'domain_not_allowed', count: 1 } });
    await appendSessionEvent(h.pool, { sessionId: mine, type: 'egress.blocked', data: { host: 'site-a2.test', reason: 'domain_not_allowed', count: 1 } });
    const frames = await stream.waitFor((f) => f.some((x) => x.event === 'egress.blocked'));
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.every((f) => eventOf(f).sessionId !== theirs)).toBe(true);
    // Sans Last-Event-ID, le flux du client ne rejoue pas l'historique.
    expect(frames.every((f) => eventOf(f).sessionId !== older)).toBe(true);
    expect(JSON.stringify(frames)).not.toContain('secret-b.test');
    const blocked = frames.find((x) => x.event === 'egress.blocked');
    expect(eventOf(blocked!).sessionId).toBe(mine);

    await h.call({ method: 'DELETE', url: `/v1/sessions/${mine}` });
    await stream.waitFor((f) => f.some((x) => x.event === 'state' && eventOf(x).data.state === 'ended'));
    // Le flux du client ne se ferme pas à la fin d'une session.
    let open_ = true;
    void stream.ended.then(() => (open_ = false));
    await new Promise((r) => setTimeout(r, 200));
    expect(open_).toBe(true);
    stream.close();

    const resumed = await open('/v1/events', 'a', { 'last-event-id': blocked?.id ?? '' });
    const after = await resumed.waitFor((f) => f.some((x) => x.event === 'state' && eventOf(x).data.state === 'ended'));
    expect(after.every((f) => BigInt(f.id ?? '0') > BigInt(blocked?.id ?? '0'))).toBe(true);
    expect(after.every((f) => eventOf(f).sessionId === mine)).toBe(true);
  });

  test('connexion d’écoute PostgreSQL perdue : reconnexion et rattrapage depuis la base, aucun événement perdu', async () => {
    const id = await newSession();
    const stream = await open(`/v1/sessions/${id}/events`);
    await stream.waitFor((f) => f.length >= 1);
    // Coupe la connexion LISTEN de la passerelle côté serveur PostgreSQL (fin de backend, pas un signal à un processus local).
    const { rowCount } = await h.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'symb-gateway-events'");
    expect(rowCount).toBeGreaterThan(0);
    await appendSessionEvent(h.pool, { sessionId: id, type: 'live.input', data: { n: 'pendant la coupure' } });
    await transitionSession(h.pool, { sessionId: id, to: 'ended', reason: 'released' });
    await stream.ended;
    expect(stream.frames.map((f) => f.event)).toEqual(['state', 'live.input', 'state']);
  }, 30_000);
});
