// SPDX-License-Identifier: AGPL-3.0-only
// Client WSS du tunnel dans le service worker (07 § 4 et § 6, tâche 2.7). Connexion SORTANTE vers l'instance appairée
// (aucun port à ouvrir), jeton dans le PREMIER message (jamais dans l'URL), ping applicatif toutes les 20 s (une
// WebSocket active maintient le service worker en vie, Chrome 116+), reconnexion avec backoff, et alarme de 30 s qui
// relance la connexion après un arrêt du service worker. Réponses découpées en morceaux ≤ 1 Mio, envoyées avec
// contre-pression sur `bufferedAmount`. Fermetures applicatives : 4401 (jeton révoqué ou expiré) → appairage oublié,
// pas de reconnexion ; 4409 (connexion plus récente du même utilisateur ailleurs) → pas de reconnexion automatique
// (sinon deux appareils se chasseraient), jusqu'au prochain démarrage de Chrome ou à une reconnexion demandée.
// U3.4 : reconnexion à attente croissante (1, 2, 4, 8, 16, 30 s ; la première tient « moins de 10 s »), état visible
// (`status()` : tentatives et échéance, pour le compte à rebours du panneau), et `resume` des runs servis après un welcome.
import {
  chunkResult,
  parseServerFrame,
  reconnectDelayMs,
  TUNNEL_MAX_PAYLOAD,
  TUNNEL_PATH,
  TUNNEL_PING_MS,
  TUNNEL_RESUME_MAX_RUNS,
  TUNNEL_RESUME_WINDOW_MS,
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
  /** Horloge (ms depuis l'époque) : échéance de la prochaine reconnexion, ancienneté des runs servis. */
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
};

const OPEN = 1;
const SUPERSEDED_KEY = 'tunnel_superseded';
/** Runs servis par cette extension (stockage de session) : `{ run_id: { seq, at } }`, annoncés par `resume` après une reconnexion (U3.4). */
const RUNS_KEY = 'tunnel_runs';
type ServedRuns = Record<string, { seq: number; at: number }>;
/** Au-delà de ces octets en attente d'envoi, l'envoi du morceau suivant attend (contre-pression). */
const BUFFER_HIGH = TUNNEL_MAX_PAYLOAD;

/** `reconnecting` : coupure subie, nouvelle tentative planifiée (`status().retryAt`) ; `idle` : aucune connexion voulue. */
export type TunnelState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'superseded' | 'unauthorized';

/** État du tunnel pour le panneau et « Ma stack » : tentatives depuis la dernière connexion et échéance de la prochaine (compte à rebours). */
export type TunnelStatus = { readonly state: TunnelState; readonly attempt: number; readonly retryAt: number | null };

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
  #retryAt: number | null = null;
  #notes: Promise<void> = Promise.resolve();
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

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  /** État visible : connecté, en reconnexion (avec l'échéance), hors ligne… (U3.4, 05 § 5 « Visibilité »). */
  status(): TunnelStatus {
    return { state: this.#state, attempt: this.#attempt, retryAt: this.#retryAt };
  }

  /** Runs servis depuis moins de `TUNNEL_RESUME_WINDOW_MS`, lus dans le stockage de session. */
  async #servedRuns(): Promise<ServedRuns> {
    const raw = await this.#deps.session.get(RUNS_KEY);
    const out: ServedRuns = {};
    if (typeof raw !== 'object' || raw === null) return out;
    const floor = this.#now() - TUNNEL_RESUME_WINDOW_MS;
    for (const [runId, v] of Object.entries(raw as Record<string, unknown>)) {
      const e = v as { seq?: unknown; at?: unknown };
      if (typeof e.seq === 'number' && typeof e.at === 'number' && e.at >= floor) out[runId] = { seq: e.seq, at: e.at };
    }
    return out;
  }

  /**
   * Une commande de plus reçue pour ce run : borné aux `TUNNEL_RESUME_MAX_RUNS` runs les plus récents. Lecture-écriture du
   * stockage SÉRIALISÉE : les commandes d'une connexion arrivent en parallèle (jusqu'à 8), sans quoi une mise à jour écraserait l'autre.
   */
  #noteCommand(runId: string): Promise<void> {
    const next = this.#notes.then(async () => {
      const runs = await this.#servedRuns();
      runs[runId] = { seq: (runs[runId]?.seq ?? 0) + 1, at: this.#now() };
      const newest = Object.entries(runs).sort((a, b) => b[1].at - a[1].at).slice(0, TUNNEL_RESUME_MAX_RUNS);
      await this.#deps.session.set(RUNS_KEY, Object.fromEntries(newest));
    });
    this.#notes = next.catch(() => undefined);
    return next;
  }

  /** Après un `welcome` : un `resume` par run servi récemment (rien à la toute première connexion, aucun run servi). */
  async #sendResumes(socket: WebSocketLike): Promise<void> {
    const runs = await this.#servedRuns();
    for (const [runId, e] of Object.entries(runs).sort((a, b) => a[1].at - b[1].at)) {
      if (socket.readyState !== OPEN) return;
      socket.send(JSON.stringify({ type: 'resume', run_id: runId, last_command_seq: e.seq }));
    }
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
    this.#retryAt = null;
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
        this.#retryAt = null;
        this.#stopPing();
        this.#ping = (this.#deps.setInterval ?? ((f: () => void, t: number) => setInterval(f, t)))(() => {
          if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'ping' }));
        }, Math.min(frame.ping_ms, TUNNEL_PING_MS));
        this.#deps.log?.('tunnel_open', { email: frame.email });
        // Reconnexion : la passerelle sait quels runs cette extension servait (rattrapage de leurs commandes en attente).
        await this.#sendResumes(socket);
        return;
      case 'pong':
        return;
      case 'cmd': {
        this.received += 1;
        await this.#noteCommand(frame.run_id).catch(() => undefined);
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
      this.#retryAt = null;
      await this.#deps.session.set(RUNS_KEY, {}).catch(() => undefined);
      await this.#deps.onUnauthorized();
      return;
    }
    if (code === WS_CLOSE.replaced) {
      this.#state = 'superseded';
      this.#retryAt = null;
      await this.#deps.session.set(SUPERSEDED_KEY, true);
      return;
    }
    if (this.#state === 'idle') return; // fermeture voulue (déconnexion)
    // Coupure subie (redéploiement, veille, réseau) : nouvelle tentative après un délai croissant (1, 2, 4, 8, 16, 30 s).
    this.#state = 'reconnecting';
    const delay = reconnectDelayMs(this.#attempt);
    this.#attempt += 1;
    this.#retryAt = this.#now() + delay;
    this.#retry = this.#set(() => void this.ensureConnected(), delay);
  }

  /** Fermeture voulue (déconnexion de l'instance) : aucune reconnexion. */
  disconnect(): void {
    this.#clear(this.#retry);
    this.#retry = null;
    this.#retryAt = null;
    this.#stopPing();
    const socket = this.#socket;
    this.#socket = null;
    this.#state = 'idle';
    socket?.close(1000, 'signed out');
  }
}
