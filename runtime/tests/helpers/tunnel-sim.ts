// SPDX-License-Identifier: AGPL-3.0-only
// Extension simulée pour les tests de la passerelle tunnel (tâche 2.7) : client `ws` qui ouvre la WSS comme le service
// worker (Origin `chrome-extension://…`, jeton dans le premier message), répond aux commandes par un gestionnaire de
// test, en morceaux ≤ 1 Mio (même découpage que l'extension). Aucun navigateur, aucun site réel.
import { chunkResult, type CommandFrame, type TunnelResult } from '@runtime/core/tunnel';
import WebSocket from 'ws';

const SIM_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

export type SimHandler = (frame: CommandFrame) => Promise<TunnelResult | null> | TunnelResult | null;

export const okFetch = (body: string, status = 200, url = 'https://zz-test-shop.example/'): TunnelResult => ({
  ok: true,
  error: null,
  ms: 1,
  snapshot_id: null,
  body: { status, headers: { 'content-type': 'application/json' }, body, url },
});

export class SimExtension {
  readonly received: CommandFrame[] = [];
  readonly socket: WebSocket;
  readonly closed: Promise<number>;
  welcome: Promise<boolean>;
  #handler: SimHandler;

  constructor(baseUrl: string, token: string | null, opts: { origin?: string | null; handler?: SimHandler; path?: string } = {}) {
    this.#handler = opts.handler ?? (() => okFetch('{"items":[]}'));
    const url = `${baseUrl.replace(/^http/, 'ws')}${opts.path ?? '/api/extension/tunnel'}`;
    this.socket = new WebSocket(url, opts.origin === null ? {} : { origin: opts.origin ?? SIM_ORIGIN });
    this.closed = new Promise((resolve) => this.socket.on('close', (code) => resolve(code)));
    this.welcome = new Promise((resolve, reject) => {
      this.socket.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      this.socket.on('error', (error) => reject(error));
      this.socket.on('close', () => resolve(false));
      this.socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type === 'welcome') resolve(true);
        if (msg.type === 'cmd') void this.#onCommand(msg as CommandFrame);
      });
    });
    if (token !== null) this.socket.on('open', () => this.socket.send(JSON.stringify({ type: 'hello', token, version: '0.1.0' })));
  }

  setHandler(handler: SimHandler): void {
    this.#handler = handler;
  }

  async #onCommand(frame: CommandFrame): Promise<void> {
    this.received.push(frame);
    const result = await this.#handler(frame);
    if (result === null || this.socket.readyState !== WebSocket.OPEN) return;
    for (const f of chunkResult(frame.job_id, JSON.stringify(result))) this.socket.send(f);
  }

  send(raw: string): void {
    this.socket.send(raw);
  }

  close(): Promise<number> {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close(1000);
    return this.closed;
  }
}
