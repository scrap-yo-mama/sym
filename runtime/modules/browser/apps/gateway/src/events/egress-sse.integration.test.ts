// SPDX-License-Identifier: AGPL-3.0-only
// BINV2 et tâche 2.5 (06 ligne 2.5 : « événement `egress.blocked` reçu en SSE < 500 ms après la tentative » ; recette 9) :
// egress réel de la tâche 1.5, ses événements écrits par le puits du nœud (`forwardEgressEvents` → `session_events`), lus par
// le client sur le flux SSE de la passerelle. Aucune connexion n'atteint l'hôte refusé.
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { createEgressGuard } from '@sym-browser/core';
import { createPgSessionEventSink } from '@sym-browser/db';
import { startSessionEgress, type SessionEgress } from '@sym-browser/node/egress';
import { forwardEgressEvents } from '@sym-browser/node/events';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../../test/helpers/harness.js';
import { eventOf, openSse } from '../../test/helpers/sse.js';

let h: Harness;
let base: string;
let fixture: Server;
let fixturePort: number;
let fixtureConnections = 0;

beforeAll(async () => {
  h = await createHarness();
  base = await h.listen();
  fixture = createServer((_req, res) => res.writeHead(200, { connection: 'close' }).end('ok'));
  fixture.on('connection', () => void (fixtureConnections += 1));
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', () => resolve()));
  fixturePort = (fixture.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await h.close();
});

/** Requête du navigateur à travers l'egress (forme absolue) ; rend le statut. */
function attempt(egress: SessionEgress, url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(egress.port, '127.0.0.1', () => socket.write(`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n\r\n`));
    const parts: Buffer[] = [];
    socket.on('data', (p: Buffer) => parts.push(p));
    socket.on('error', reject);
    socket.once('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(Buffer.concat(parts).toString('latin1'))?.[1] ?? '0')));
  });
}

describe('assert_session_egress_enforced (recette 9, tâche 2.5) : egress.blocked de l’egress réel reçu en SSE', () => {
  test('assert_session_egress_enforced : tentative vers un hôte hors politique → 403, 0 connexion, egress.blocked reçu en SSE en moins de 500 ms', async () => {
    const created = await h.call({ method: 'POST', url: '/v1/sessions', key: 'a', body: { egress: { allowedHosts: ['site-a.test'] } } });
    const sessionId = created.body.id as string;
    const errors: unknown[] = [];
    const forward = forwardEgressEvents(sessionId, createPgSessionEventSink(h.pool), (error) => errors.push(error));
    const egress = await startSessionEgress(
      { allowedHosts: ['site-a.test'], ports: [fixturePort] },
      {
        guard: createEgressGuard({ privateHosts: ['site-a.test', 'site-b.test'], resolver: async () => [{ address: '127.0.0.1', family: 4 }] }),
        onEvent: forward.onEvent,
      },
    );
    const stream = await openSse(`${base}/v1/sessions/${sessionId}/events`, { authorization: `Bearer ${h.keys.aRead}` });
    try {
      await stream.waitFor((f) => f.some((x) => x.event === 'state'));
      expect(await attempt(egress, `http://site-a.test:${fixturePort}/`)).toBe(200);
      const connectionsBefore = fixtureConnections;
      const started = Date.now();
      expect(await attempt(egress, `http://site-b.test:${fixturePort}/secret?jeton=zz_test`)).toBe(403);
      const frames = await stream.waitFor((f) => f.some((x) => x.event === 'egress.blocked'), 2_000);
      const blocked = frames.find((x) => x.event === 'egress.blocked');
      expect(blocked).toBeDefined();
      expect((blocked?.receivedAt ?? Infinity) - started).toBeLessThan(500);
      expect(eventOf(blocked!)).toMatchObject({ type: 'egress.blocked', sessionId, data: { host: 'site-b.test', reason: 'domain_not_allowed', port: fixturePort, count: 1 } });
      // L'hôte est normalisé ; l'URL complète (chemin, requête) reste côté navigateur.
      expect(blocked?.data).not.toContain('secret');
      expect(blocked?.data).not.toContain('zz_test');
      expect(fixtureConnections).toBe(connectionsBefore);
      await forward.flush();
      expect(errors).toEqual([]);
    } finally {
      stream.close();
      await egress.close();
    }
  });
});
