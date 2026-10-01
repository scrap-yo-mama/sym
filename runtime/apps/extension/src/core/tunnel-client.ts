// SPDX-License-Identifier: AGPL-3.0-only
// Client WSS du tunnel dans le service worker (07 § 4 et § 6, tâche 2.7). Connexion SORTANTE vers l'instance appairée
// (aucun port à ouvrir), jeton dans le PREMIER message (jamais dans l'URL), ping applicatif toutes les 20 s (une
// WebSocket active maintient le service worker en vie, Chrome 116+), reconnexion avec backoff, et alarme de 30 s qui
// relance la connexion après un arrêt du service worker. Réponses découpées en morceaux ≤ 1 Mio, envoyées avec
// contre-pression sur `bufferedAmount`. Fermetures applicatives : 4401 (jeton révoqué ou expiré) → appairage oublié,
// pas de reconnexion ; 4409 (connexion plus récente du même utilisateur ailleurs) → pas de reconnexion automatique
// (sinon deux appareils se chasseraient), jusqu'au prochain démarrage de Chrome ou à une reconnexion demandée.
import {
  chunkResult,
  parseServerFrame,
  TUNNEL_MAX_PAYLOAD,
  TUNNEL_PATH,
  TUNNEL_PING_MS,
  WS_CLOSE,
  type CommandFrame,
  type TunnelResult,
} from '@runtime/core/tunnel';

/** Sous-ensemble de l'API WebSocket du navigateur utilisé ici. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type TunnelClientDeps = {
  createSocket(url: string): WebSocketLike;
  /** Appairage courant (URL de l'instance, jeton) ; `null` : non appairé, aucune connexion. */
  pairing(): Promise<{ origin: string; token: string } | null>;
  version: string;
  execute(frame: CommandFrame): Promise<TunnelResult>;
  /** Jeton refusé (4401) : l'appairage local est oublié. */
  onUnauthorized(): Promise<void>;
  /** État persistant le temps de la session du navigateur (`chrome.storage.session`). */
  session: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
};

const OPEN = 1;
const SUPERSEDED_KEY = 'tunnel_superseded';
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
/** Au-delà de ces octets en attente d'envoi, l'envoi du morceau suivant attend (contre-pression). */
const BUFFER_HIGH = TUNNEL_MAX_PAYLOAD;

export type TunnelState = 'idle' | 'connecting' | 'open' | 'superseded' | 'unauthorized';

/** URL WSS de l'instance : `https://` → `wss://` (ws:// seulement pour l'instance locale de développement). */
export function tunnelUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = TUNNEL_PATH;
  url.search = '';
  url.hash = '';
  return url.href;
}

export class TunnelClient {
  readonly #deps: TunnelClientDeps;
  #socket: WebSocketLike | null = null;
  #state: TunnelState = 'idle';
  #attempt = 0;
  #retry: unknown = null;
  #ping: unknown = null;
  #connecting: Promise<void> | null = null;
  /** Commandes reçues et réponses envoyées (observabilité locale). */
  received = 0;
  answered = 0;

  constructor(deps: TunnelClientDeps) {
    this.#deps = deps;
  }

  get state(): TunnelState {
    return this.#state;
  }

  #set(fn: () => void, ms: number): unknown {
    return (this.#deps.setTimeout ?? ((f: () => void, t: number) => setTimeout(f, t)))(fn, ms);
  }

  #clear(handle: unknown): void {
    if (handle !== null) (this.#deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }

  #stopPing(): void {
    if (this.#ping !== null) (this.#deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(this.#ping);
    this.#ping = null;
  }

  /**
   * Connexion si elle n'est pas ouverte (démarrage, alarme de 30 s, appairage). Sans effet après un 4409 tant que
   * `force` n'est pas demandé (démarrage de Chrome, reconnexion voulue par l'utilisateur).
   */
  async ensureConnected(force = false): Promise<void> {
    if (force) await this.#deps.session.set(SUPERSEDED_KEY, false);
    else if ((await this.#deps.session.get(SUPERSEDED_KEY)) === true) {
      this.#state = 'superseded';
      return;
    }
    if (this.#socket !== null && (this.#state === 'open' || this.#state === 'connecting')) return;
    this.#connecting ??= this.#connect().finally(() => (this.#connecting = null));
    await this.#connecting;
  }

  async #connect(): Promise<void> {
    const pairing = await this.#deps.pairing();
    if (pairing === null) {
      this.#state = 'idle';
      return;
    }
    this.#clear(this.#retry);
    this.#retry = null;
    this.#state = 'connecting';
    const socket = this.#deps.createSocket(tunnelUrl(pairing.origin));
    this.#socket = socket;
    socket.onopen = () => {
      // Jeton hors URL : premier message (07 § 6).
      socket.send(JSON.stringify({ type: 'hello', token: pairing.token, version: this.#deps.version }));
    };
    socket.onmessage = (ev) => void this.#onMessage(socket, ev.data);
    socket.onerror = () => undefined;
    socket.onclose = (ev) => void this.#onClose(socket, ev.code);
  }

  async #onMessage(socket: WebSocketLike, data: unknown): Promise<void> {
    if (typeof data !== 'string') return;
    const frame = parseServerFrame(data);
    if (frame === null) {
      this.#deps.log?.('tunnel_frame_ignored');
      return;
    }
    switch (frame.type) {
      case 'welcome':
        this.#state = 'open';
        this.#attempt = 0;
        this.#stopPing();
        this.#ping = (this.#deps.setInterval ?? ((f: () => void, t: number) => setInterval(f, t)))(() => {
          if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'ping' }));
        }, Math.min(frame.ping_ms, TUNNEL_PING_MS));
        this.#deps.log?.('tunnel_open', { email: frame.email });
        return;
      case 'pong':
        return;
      case 'cmd': {
        this.received += 1;
        const result = await this.#deps.execute(frame);
        await this.#reply(socket, frame.job_id, result);
        return;
      }
    }
  }

  /** Réponse découpée (≤ 1 Mio par message), envoyée morceau par morceau sous contre-pression. */
  async #reply(socket: WebSocketLike, jobId: string, result: TunnelResult): Promise<void> {
    for (const frame of chunkResult(jobId, JSON.stringify(result))) {
      while (socket.readyState === OPEN && socket.bufferedAmount > BUFFER_HIGH) await new Promise((r) => this.#set(() => r(undefined), 50));
      // Connexion perdue : la passerelle rejoue (lecture) ou met en échec le job, jamais perdu (07 § 4).
      if (socket.readyState !== OPEN) return;
      socket.send(frame);
    }
    this.answered += 1;
  }

  async #onClose(socket: WebSocketLike, code: number): Promise<void> {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#stopPing();
    if (code === WS_CLOSE.unauthorized) {
      this.#state = 'unauthorized';
      await this.#deps.onUnauthorized();
      return;
    }
    if (code === WS_CLOSE.replaced) {
      this.#state = 'superseded';
      await this.#deps.session.set(SUPERSEDED_KEY, true);
      return;
    }
    if (this.#state === 'idle') return; // fermeture voulue (déconnexion)
    this.#state = 'idle';
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)]!;
    this.#attempt += 1;
    this.#retry = this.#set(() => void this.ensureConnected(), delay);
  }

  /** Fermeture voulue (déconnexion de l'instance) : aucune reconnexion. */
  disconnect(): void {
    this.#clear(this.#retry);
    this.#retry = null;
    this.#stopPing();
    const socket = this.#socket;
    this.#socket = null;
    this.#state = 'idle';
    socket?.close(1000, 'signed out');
  }
}
