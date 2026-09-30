// SPDX-License-Identifier: AGPL-3.0-only
// INV9 côté auth (tâche 0.3b) : Better Auth embarque @better-auth/telemetry. Lecture du code 1.7.5 : un envoi n'a
// lieu que si la télémétrie est activée (option, ou variable BETTER_AUTH_TELEMETRY qui l'emporte sur l'option) ET
// qu'une destination est fournie par BETTER_AUTH_TELEMETRY_ENDPOINT (vide par défaut) ; elle est aussi coupée sous
// NODE_ENV=test. Le test pose ces variables, installe un intercepteur global (fetch, undici, http, sockets) qui refuse
// toute destination non locale, et vérifie 0 requête sortante au démarrage, à l'assistant, à la connexion et à la
// lecture de session ; puis un témoin prouve que l'intercepteur voit bien un envoi quand la télémétrie est forcée.
// Extension à tout le produit (OTel, diagnostics) : tâches 1.10 et 4.3 (assert_no_telemetry).
import diagnostics from 'node:diagnostics_channel';
import net from 'node:net';
import { createTelemetry } from 'better-auth';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer } from '../../../tests/helpers/server.js';
import { TELEMETRY_VARIABLES } from './config.js';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);
const outbound: string[] = [];
const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;
const listeners: [string, (message: unknown) => void][] = [];

function record(host: string | undefined | null, what: string): boolean {
  const h = (host ?? '').toLowerCase();
  if (LOCAL.has(h) || h.startsWith('/')) return false; // socket Unix ou boucle locale
  outbound.push(`${what} ${h}`);
  return true;
}

function install(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (record(url.hostname, 'fetch')) throw new Error(`INV9 : requête sortante bloquée vers ${url.hostname}`);
    return originalFetch(input, init);
  }) as typeof fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const first = args[0] as { host?: string; path?: string } | number | string;
    const host = typeof first === 'object' ? (first.path ? '/' : first.host ?? 'localhost') : typeof args[1] === 'string' ? args[1] : 'localhost';
    if (record(host, 'socket')) throw new Error(`INV9 : connexion sortante bloquée vers ${host}`);
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  const onUndici = (m: unknown) => record((m as { request?: { origin?: string } }).request?.origin?.replace(/^https?:\/\//, '').split(':')[0], 'undici');
  const onHttp = (m: unknown) => record((m as { request?: { host?: string } }).request?.host, 'http');
  for (const [name, fn] of [['undici:request:create', onUndici], ['http.client.request.start', onHttp]] as const) {
    diagnostics.subscribe(name, fn);
    listeners.push([name, fn]);
  }
}

function uninstall(): void {
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
  for (const [name, fn] of listeners) diagnostics.unsubscribe(name, fn);
}

const setTelemetryEnv = () => {
  process.env['BETTER_AUTH_TELEMETRY'] = '1';
  process.env['BETTER_AUTH_TELEMETRY_ENDPOINT'] = 'https://telemetry.zz-test.invalid/v1/track';
};

let srv: TestServer;
beforeAll(() => {
  install();
});
afterAll(async () => {
  uninstall();
  for (const name of TELEMETRY_VARIABLES) delete process.env[name];
  await srv?.close();
});

describe('assert_no_telemetry (INV9, part auth 0.3b)', () => {
  test('0 requête sortante : démarrage, assistant, connexion, session, clé', async () => {
    setTelemetryEnv();
    srv = await startTestServer('telemetry');
    // Variables de télémétrie retirées de l'environnement par la configuration du serveur.
    expect(TELEMETRY_VARIABLES.filter((n) => process.env[n] !== undefined)).toEqual([]);
    const owner = await runSetup(srv);
    const cookie = await signIn(srv, owner);
    expect((await srv.app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } })).statusCode).toBe(200);
    expect((await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    const bad = await srv.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: PUBLIC_URL }, payload: { email: owner.email, password: 'zz_test_wrong' } });
    expect(bad.statusCode).toBe(401);
    // Hors garde de NODE_ENV=test : la télémétrie de la bibliothèque, avec NOTRE configuration, n'émet rien.
    const telemetry = await createTelemetry(srv.started.ctx.auth.options, { skipTestCheck: true });
    await telemetry.publish({ type: 'zz_test', payload: {} });
    expect(srv.started.ctx.auth.options.telemetry).toEqual({ enabled: false, debug: false });
    expect(outbound).toEqual([]);
  });

  test('témoin : télémétrie forcée hors configuration → l’intercepteur voit et bloque l’envoi', async () => {
    setTelemetryEnv();
    try {
      const telemetry = await createTelemetry({ baseURL: PUBLIC_URL, telemetry: { enabled: true } }, { skipTestCheck: true });
      await telemetry.publish({ type: 'zz_test', payload: {} });
      await new Promise((r) => setTimeout(r, 50));
      expect(outbound.some((o) => o.includes('telemetry.zz-test.invalid'))).toBe(true);
    } finally {
      for (const name of TELEMETRY_VARIABLES) delete process.env[name];
      outbound.length = 0;
    }
  });
});
