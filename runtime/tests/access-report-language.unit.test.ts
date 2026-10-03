// SPDX-License-Identifier: AGPL-3.0-only
// assert_accept_language_engine_real, volet rapport d'accès (tâche 3.20, 21 § 6.6, 21b M8) : l'`Accept-Language` du rapport est
// celui que la sonde a RÉELLEMENT envoyé au site (relevé au dernier moment, après le retrait du client HTTP), jamais une constante.
// Une fixture locale enregistre l'en-tête reçu : le rapport affiche exactement la même chose (absence comprise).
import { createServer, type Server } from 'node:http';
import { accessReportView, buildAccessReport, sessionAccessProbe } from '@runtime/core/access';
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
  const session = openNetworkSession({ rung: { mode: 'direct' }, guard, ...options });
  try {
    const report = await buildAccessReport({ url: `http://${HOST}:${port}/page`, probe: sessionAccessProbe(session), signal, probeLlmsTxt: false, probeSitemap: false });
    return { report, view: accessReportView(report) };
  } finally {
    await session.close();
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

describe('rapport d’accès en tunnel : la langue est celle du navigateur de l’utilisateur (21 § 6.4)', () => {
  // En tunnel, la sonde part par `page_fetch` dans l'onglet de l'utilisateur : son Chrome envoie SA langue
  // réelle, que le worker ne relève pas. Le rapport ne doit jamais dire « aucune » (ce serait faux), ni inventer une valeur.
  const browserProbe = async (url: string) => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body>ok</body></html>', url });

  test('assert_accept_language_engine_real : sonde par le tunnel → source user_browser, aucune valeur, jamais null (« Aucune »)', async () => {
    const report = await buildAccessReport({ url: 'https://zz-test-tunnel-lang.example/page', probe: browserProbe, requestsFrom: 'user_browser', signal, probeLlmsTxt: false, probeSitemap: false });
    const view = accessReportView(report);
    expect(report.accept_language_source).toBe('user_browser');
    expect(view.accept_language_source).toBe('user_browser');
    expect('accept_language' in view).toBe(false);
    expect(view.accept_language).not.toBeNull();
  });

  test('assert_accept_language_engine_real : tunnel, sonde qui relèverait un en-tête → ignoré (le navigateur de l’utilisateur décide) ; site qui refuse (403) → toujours user_browser', async () => {
    const reporting = async (url: string) => ({ ...(await browserProbe(url)), sent_accept_language: null });
    const view = accessReportView(await buildAccessReport({ url: 'https://zz-test-tunnel-lang.example/page', probe: reporting, requestsFrom: 'user_browser', signal, probeLlmsTxt: false, probeSitemap: false }));
    expect(view).toMatchObject({ accept_language_source: 'user_browser' });
    expect('accept_language' in view).toBe(false);
    const refusing = async (url: string) => ({ ...(await browserProbe(url)), status: 403 });
    const denied = accessReportView(await buildAccessReport({ url: 'https://zz-test-tunnel-lang.example/page', probe: refusing, requestsFrom: 'user_browser', signal, probeLlmsTxt: false, probeSitemap: false }));
    expect(denied).toMatchObject({ signal: 'review', accept_language_source: 'user_browser' });
    expect('accept_language' in denied).toBe(false);
  });

  test('assert_accept_language_engine_real : moteur (défaut) → source engine, la valeur relevée ou null', async () => {
    const { view } = await reportWith({ userAgent: 'ZzTestBot/1.0 (+mailto:ops@zz-test.example)' });
    expect(view.accept_language_source).toBe('engine');
    expect(view.accept_language).toBeNull();
  });
});
