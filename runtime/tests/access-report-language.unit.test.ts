// SPDX-License-Identifier: AGPL-3.0-only
// assert_accept_language_engine_real, volet rapport d'accès (tâche 3.20, 21 § 6.6, 21b M8) : l'`Accept-Language` du rapport est
// celui que la sonde a RÉELLEMENT envoyé au site (relevé au dernier moment, après le retrait du client HTTP), jamais une constante.
// Une fixture locale enregistre l'en-tête reçu : le rapport affiche exactement la même chose (absence comprise).
import { createServer, type Server } from 'node:http';
import { accessReportView, buildAccessReport, RobotsGate, sessionAccessProbe, sessionRobotsFetcher } from '@runtime/core/access';
import * as net from '@runtime/core/net';
import { openNetworkSession } from '@runtime/core/net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fixtureGuard } from './helpers/fixture-net.ts';

const HOST = 'zz_test_access_lang.localhost';
const signal = new AbortController().signal;
let server: Server;
let port: number;
let received: (string | undefined)[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow:\n');
    received.push(req.headers['accept-language']);
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body>ok</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function reportWith(options: { userAgent?: string }) {
  received = [];
  const guard = fixtureGuard(port, [HOST], net);
  const robotsSession = openNetworkSession({ rung: { mode: 'direct' }, guard, ...options });
  const gate = new RobotsGate({ fetch: sessionRobotsFetcher(robotsSession) });
  const session = openNetworkSession({ rung: { mode: 'direct' }, guard, checkUrl: gate.checkUrl, ...options });
  try {
    const report = await buildAccessReport({ url: `http://${HOST}:${port}/page`, gate, probe: sessionAccessProbe(session), signal, probeLlmsTxt: false });
    return { report, view: accessReportView(report) };
  } finally {
    await session.close();
    await robotsSession.close();
  }
}

describe('rapport d’accès : Accept-Language relevé pendant la sonde', () => {
  test('assert_accept_language_engine_real : identité du robot (E1) → aucun en-tête reçu, le rapport affiche null', async () => {
    const { report, view } = await reportWith({ userAgent: 'ZzTestBot/1.0 (+mailto:ops@zz-test.example)' });
    expect(received).toEqual([undefined]);
    expect(report.accept_language).toBeNull();
    expect(view.accept_language).toBeNull();
  });

  test('assert_accept_language_engine_real : sans retrait (session sans identité) → la valeur réellement reçue par le site, pas une constante', async () => {
    const { report, view } = await reportWith({});
    expect(received).toHaveLength(1);
    expect(typeof received[0]).toBe('string');
    expect(report.accept_language).toBe(received[0]);
    expect(view.accept_language).toBe(received[0]);
  });
});
