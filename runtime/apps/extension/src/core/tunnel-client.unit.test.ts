// SPDX-License-Identifier: AGPL-3.0-only
// Client WSS du service worker (tâche 2.7, 07 § 4 et § 6) avec une WebSocket simulée : jeton dans le premier message,
// jamais dans l'URL (assert_ws_token_not_in_url, côté extension) ; ping toutes les 20 s ; 4401 → appairage oublié ;
// 4409 → pas de reconnexion automatique ; service worker arrêté puis réveillé par l'alarme de 30 s → reconnexion
// (assert_sw_alarm_reconnect, volet extension ; le rejeu des jobs est vérifié côté passerelle) ; réponses découpées.
import { describe, expect, test } from 'vitest';
import { parseExtensionFrame, TUNNEL_MAX_PAYLOAD, TUNNEL_PING_MS, type TunnelResult } from '@runtime/core/tunnel';
import { TunnelClient, tunnelUrl, type WebSocketLike } from './tunnel-client.ts';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  sent: string[] = [];
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

function harness(opts: { result?: TunnelResult } = {}) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  const session = new Map<string, unknown>();
  let forgotten = 0;
  let paired = true;
  const client = new TunnelClient({
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    pairing: async () => (paired ? { origin: 'https://runtime.zz-test.example', token: 'sy_ext_zz_test_secret_token' } : null),
    version: '0.1.0',
    execute: async () => opts.result ?? { ok: true, error: null, ms: 1, snapshot_id: null, body: { status: 200, headers: {}, body: 'ok', url: 'https://zz-test-shop.example/' } },
    onUnauthorized: async () => {
      forgotten += 1;
      paired = false;
    },
    session: { get: async (k) => session.get(k), set: async (k, v) => void session.set(k, v) },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => undefined,
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    clearInterval: () => undefined,
  });
  return { client, sockets, timers, intervals, forgotten: () => forgotten };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const welcome = { type: 'welcome', email: 'zz_test@example.test', ping_ms: TUNNEL_PING_MS, max_payload: TUNNEL_MAX_PAYLOAD };
const cmd = { type: 'cmd', job_id: '4f3c8a0e-1b2c-4d5e-8f90-123456789abc', run_id: '0e1d2c3b-4a59-4687-9123-abcdefabcdef', cmd: 'page_fetch', domain: 'zz-test-shop.example', args: {}, timeout_ms: 30000, allow_write_actions: false };

describe('client WSS du tunnel', () => {
  test('assert_ws_token_not_in_url : URL wss sans paramètre, jeton dans le premier message ; ping toutes les 20 s', async () => {
    const h = harness();
    await h.client.ensureConnected();
    const s = h.sockets[0]!;
    expect(s.url).toBe('wss://runtime.zz-test.example/api/extension/tunnel');
    expect(s.url).not.toContain('sy_ext_');
    s.open();
    expect(JSON.parse(s.sent[0]!)).toEqual({ type: 'hello', token: 'sy_ext_zz_test_secret_token', version: '0.1.0' });
    s.receive(welcome);
    await flush();
    expect(h.client.state).toBe('open');
    expect(h.intervals[0]?.ms).toBe(20_000);
    h.intervals[0]!.fn();
    expect(JSON.parse(s.sent.at(-1)!)).toEqual({ type: 'ping' });
    expect(tunnelUrl('http://127.0.0.1:3000')).toBe('ws://127.0.0.1:3000/api/extension/tunnel');
  });

  test('commande → réponse découpée (morceaux ≤ 1 Mio, seq/last), réassemblable', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const h = harness({ result: { ok: true, error: null, ms: 1, snapshot_id: null, body: { status: 200, headers: {}, body: big, url: 'https://zz-test-shop.example/' } } });
    await h.client.ensureConnected();
    const s = h.sockets[0]!;
    s.open();
    s.receive(welcome);
    s.receive(cmd);
    await new Promise((r) => setTimeout(r, 20));
    const frames = s.sent.slice(1).map((f) => parseExtensionFrame(f)).filter((f) => f?.type === 'result');
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(frames.map((f) => (f as { seq: number }).seq)).toEqual(frames.map((_, i) => i));
    expect((frames.at(-1) as { last: boolean }).last).toBe(true);
    for (const f of s.sent) expect(new TextEncoder().encode(f).byteLength).toBeLessThanOrEqual(TUNNEL_MAX_PAYLOAD);
  });

  test('4401 (jeton révoqué) : appairage oublié, aucune reconnexion', async () => {
    const h = harness();
    await h.client.ensureConnected();
    h.sockets[0]!.open();
    h.sockets[0]!.drop(4401);
    await flush();
    expect(h.forgotten()).toBe(1);
    expect(h.client.state).toBe('unauthorized');
    expect(h.timers).toHaveLength(0);
    await h.client.ensureConnected();
    expect(h.sockets).toHaveLength(1);
  });

  test('4409 (connexion plus récente ailleurs) : pas de reconnexion automatique, même à l’alarme ; reprise au démarrage', async () => {
    const h = harness();
    await h.client.ensureConnected();
    h.sockets[0]!.open();
    h.sockets[0]!.drop(4409);
    await flush();
    expect(h.client.state).toBe('superseded');
    await h.client.ensureConnected(); // alarme de 30 s
    expect(h.sockets).toHaveLength(1);
    await h.client.ensureConnected(true); // démarrage de Chrome
    expect(h.sockets).toHaveLength(2);
  });

  test('assert_sw_alarm_reconnect : coupure → backoff ; service worker arrêté puis réveillé par l’alarme → reconnexion', async () => {
    const h = harness();
    await h.client.ensureConnected();
    h.sockets[0]!.open();
    h.sockets[0]!.receive(welcome);
    h.sockets[0]!.drop(1006);
    await flush();
    expect(h.timers[0]?.ms).toBe(1000);
    // Service worker arrêté : le minuteur de backoff est perdu. Un nouveau service worker naît avec l'alarme de 30 s.
    const fresh = harness();
    await fresh.client.ensureConnected(); // gestionnaire de l'alarme
    expect(fresh.sockets).toHaveLength(1);
    fresh.sockets[0]!.open();
    fresh.sockets[0]!.receive(welcome);
    await flush();
    expect(fresh.client.state).toBe('open');
  });
});
