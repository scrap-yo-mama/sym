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
  return { client, sockets, timers, intervals, session, forgotten: () => forgotten };
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

// ---------------------------------------------------------------------------------------------------------------------
// U3.4 : tunnel stable (05 § 5, assert_tunnel_reconnects, côté extension ; la passerelle et le run sont vérifiés ailleurs)
// ---------------------------------------------------------------------------------------------------------------------

/** Horloge pilotée : chaque attente de reconnexion est enregistrée avec son échéance, la reconnexion s'exécute à la demande. */
function timedHarness() {
  const h = harness();
  return h;
}
const RUN_A = '0e1d2c3b-4a59-4687-9123-abcdefabcdef';
const RUN_B = '1f1d2c3b-4a59-4687-9123-abcdefabcdef';
const cmdFor = (run: string, job: string) => ({ ...cmd, run_id: run, job_id: job });
const JOB_1 = '4f3c8a0e-1b2c-4d5e-8f90-123456789a01';
const JOB_2 = '4f3c8a0e-1b2c-4d5e-8f90-123456789a02';
const JOB_3 = '4f3c8a0e-1b2c-4d5e-8f90-123456789a03';

describe('U3.4 : reconnexion', () => {
  test('attentes 1, 2, 4, 8, 16, 30 s puis plafonnées ; un welcome remet le compteur à zéro', async () => {
    const h = timedHarness();
    await h.client.ensureConnected();
    for (let i = 0; i < 7; i += 1) {
      h.sockets.at(-1)!.drop(1006); // la connexion échoue avant tout welcome
      await flush();
      h.timers.at(-1)!.fn();
      await flush();
    }
    expect(h.timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    // Connexion rétablie : le compteur repart de 1 s.
    h.sockets.at(-1)!.open();
    h.sockets.at(-1)!.receive(welcome);
    await flush();
    h.sockets.at(-1)!.drop(1006);
    await flush();
    expect(h.timers.at(-1)!.ms).toBe(1000);
  });

  test('coupure par la passerelle (redéploiement) : reconnexion planifiée en moins de 10 s, état « reconnecting » avec l’échéance', async () => {
    const h = timedHarness();
    await h.client.ensureConnected();
    h.sockets[0]!.open();
    h.sockets[0]!.receive(welcome);
    await flush();
    expect(h.client.status()).toMatchObject({ state: 'open', attempt: 0, retryAt: null });
    h.sockets[0]!.drop(1012); // « service restart »
    await flush();
    expect(h.client.state).toBe('reconnecting');
    expect(h.timers.at(-1)!.ms).toBeLessThan(10_000);
    const status = h.client.status();
    expect(status).toMatchObject({ state: 'reconnecting', attempt: 1 });
    expect(status.retryAt).not.toBeNull();
    expect(status.retryAt! - Date.now()).toBeLessThanOrEqual(1000);
    h.timers.at(-1)!.fn();
    await flush();
    h.sockets[1]!.open();
    h.sockets[1]!.receive(welcome);
    await flush();
    expect(h.client.status()).toMatchObject({ state: 'open', attempt: 0, retryAt: null });
  });

  test('l’état reconnecting ne bloque pas l’alarme de 30 s : elle relance la connexion', async () => {
    const h = timedHarness();
    await h.client.ensureConnected();
    h.sockets[0]!.open();
    h.sockets[0]!.receive(welcome);
    h.sockets[0]!.drop(1006);
    await flush();
    await h.client.ensureConnected(); // alarme
    expect(h.sockets).toHaveLength(2);
  });
});

describe('U3.4 : resume', () => {
  test('première connexion : aucun resume ; après une reconnexion : un resume par run servi, avec le nombre de commandes reçues', async () => {
    const h = timedHarness();
    await h.client.ensureConnected();
    const s1 = h.sockets[0]!;
    s1.open();
    s1.receive(welcome);
    await flush();
    expect(s1.sent.map((f) => parseExtensionFrame(f)?.type)).toEqual(['hello']);
    s1.receive(cmdFor(RUN_A, JOB_1));
    s1.receive(cmdFor(RUN_A, JOB_2));
    s1.receive(cmdFor(RUN_B, JOB_3));
    await new Promise((r) => setTimeout(r, 20));
    s1.drop(1006);
    await flush();
    h.timers.at(-1)!.fn();
    await flush();
    const s2 = h.sockets[1]!;
    s2.open();
    s2.receive(welcome);
    await new Promise((r) => setTimeout(r, 20));
    const resumes = s2.sent.map((f) => parseExtensionFrame(f)).filter((f) => f?.type === 'resume');
    expect(resumes).toEqual([
      { type: 'resume', run_id: RUN_A, last_command_seq: 2 },
      { type: 'resume', run_id: RUN_B, last_command_seq: 1 },
    ]);
    // Le hello reste le premier message de la connexion (jeton hors URL), le resume vient après le welcome.
    expect(parseExtensionFrame(s2.sent[0]!)?.type).toBe('hello');
  });

  test('un service worker relancé (état en mémoire perdu) retrouve les runs servis dans le stockage de session', async () => {
    const h = timedHarness();
    await h.client.ensureConnected();
    h.sockets[0]!.open();
    h.sockets[0]!.receive(welcome);
    h.sockets[0]!.receive(cmdFor(RUN_A, JOB_1));
    await new Promise((r) => setTimeout(r, 20));
    // Nouveau client, même stockage de session : l'alarme le reconnecte, il annonce le run.
    const sockets: FakeSocket[] = [];
    const reborn = new TunnelClient({
      createSocket: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!),
      pairing: async () => ({ origin: 'https://runtime.zz-test.example', token: 'sy_ext_zz_test_secret_token' }),
      version: '0.1.0',
      execute: async () => ({ ok: true, error: null, ms: 1, snapshot_id: null, body: null }),
      onUnauthorized: async () => undefined,
      session: { get: async (k) => (h.session as Map<string, unknown>).get(k), set: async (k, v) => void (h.session as Map<string, unknown>).set(k, v) },
      setTimeout: () => undefined,
      setInterval: () => undefined,
    });
    await reborn.ensureConnected();
    sockets[0]!.open();
    sockets[0]!.receive(welcome);
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets[0]!.sent.map((f) => parseExtensionFrame(f)).filter((f) => f?.type === 'resume')).toEqual([{ type: 'resume', run_id: RUN_A, last_command_seq: 1 }]);
  });

  test('runs trop anciens (plus de 10 minutes) ou au-delà de la borne : jamais annoncés', async () => {
    let now = 1_000_000;
    const sockets: FakeSocket[] = [];
    const store = new Map<string, unknown>();
    const timers: { fn: () => void; ms: number }[] = [];
    const client = new TunnelClient({
      createSocket: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!),
      pairing: async () => ({ origin: 'https://runtime.zz-test.example', token: 'sy_ext_zz_test_secret_token' }),
      version: '0.1.0',
      execute: async () => ({ ok: true, error: null, ms: 1, snapshot_id: null, body: null }),
      onUnauthorized: async () => undefined,
      session: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) },
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      setInterval: () => undefined,
      now: () => now,
    });
    await client.ensureConnected();
    sockets[0]!.open();
    sockets[0]!.receive(welcome);
    await flush();
    sockets[0]!.receive(cmdFor(RUN_A, JOB_1));
    await new Promise((r) => setTimeout(r, 10));
    now += 11 * 60 * 1000;
    sockets[0]!.receive(cmdFor(RUN_B, JOB_2));
    await new Promise((r) => setTimeout(r, 10));
    sockets[0]!.drop(1006);
    await flush();
    timers.at(-1)!.fn();
    await flush();
    sockets[1]!.open();
    sockets[1]!.receive(welcome);
    await new Promise((r) => setTimeout(r, 10));
    const ids = sockets[1]!.sent.map((f) => parseExtensionFrame(f)).filter((f) => f?.type === 'resume').map((f) => (f as { run_id: string }).run_id);
    expect(ids).toEqual([RUN_B]);
  });
});
