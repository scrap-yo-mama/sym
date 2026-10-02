// SPDX-License-Identifier: AGPL-3.0-only
// Vue en direct d'une session, côté nœud (cdc/sym-browser 04d § 1.2 et § 1.3, tâche 3.2), sur le contexte Playwright de la
// session tenu par le nœud (shared : contexte du nœud, tâche 1.3 ; dedicated : contexte par défaut vu par la connexion du
// nœud, tâche 3.3), indépendamment du client et du transport : le visionneur arrive par un `LiveChannel` (relais WSS du
// nœud, `live-socket.ts`).
// - Screencast CDP (`Page.startScreencast` : jpeg, qualité 60, 1280x800, chaque image) : un seul par page, diffusé à tous
//   ses visionneurs (5 au plus par session), démarré au premier, arrêté au départ du dernier.
// - Chaque trame est acquittée (`Page.screencastFrameAck`) dès sa mise en file, ce qui garde le flux de Chromium vivant ;
//   par visionneur, au plus `maxFramesInFlight` trames envoyées et non consommées ; au-delà, la trame en attente est
//   remplacée par la plus récente. La dernière trame est renvoyée au visionneur qui arrive.
// - Messages vers le visionneur : `frame`, `meta` (URL, titre, onglets, onglet suivi, mode), `notice`, `pong`, `closed`.
//   Le visionneur suit l'onglet actif (le plus récent) à son arrivée et en choisit un autre par `{t: 'tab', id}`.
// - Lecture seule par défaut : seuls `tab` et `ping` sont acceptés, toute entrée est écartée au nœud (aucune commande
//   `Input.*`) et le visionneur voit « SYM 👻 : lecture seule ». Interactif seulement si la session a `liveView.interactive`
//   ET si le visionneur a un jeton `rw` (vérifié par la passerelle) : souris, molette, clavier et texte convertis en
//   `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`, coordonnées bornées au viewport.
// - `live.input` compte les entrées par fenêtre (1 min) sans en enregistrer le contenu.
import type { BrowserContext, CDPSession, Page } from 'playwright-core';

export type LiveMode = 'ro' | 'rw';

export const LIVE_DEFAULTS = Object.freeze({
  maxViewers: 5,
  maxFramesInFlight: 2,
  screencast: Object.freeze({ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }),
  inputWindowMs: 60_000,
});

export const READ_ONLY_NOTICE = 'SYM 👻 : lecture seule';

type LiveTab = { id: string; url: string; title: string };
type LiveFrameMessage = { t: 'frame'; data: string; ts: number; w: number; h: number; tab: string };
export type LiveServerMessage =
  | LiveFrameMessage
  | { t: 'meta'; url: string; title: string; tabs: LiveTab[]; tab: string | null; mode: LiveMode; interactive: boolean }
  | { t: 'notice'; text: string }
  | { t: 'pong' }
  | { t: 'closed'; reason: string };

/** Canal vers un visionneur : `send` se résout quand le message est consommé (écrit sur le transport). */
export interface LiveChannel {
  send(message: LiveServerMessage): Promise<void>;
  close(reason: string): void;
}

export type LiveEvent = { type: 'live.input'; sessionId: string; count: number; windowStart: string };

export class LiveViewFullError extends Error {
  override name = 'LiveViewFullError';
}
class LiveViewClosedError extends Error {
  override name = 'LiveViewClosedError';
}

export type LiveViewOptions = {
  sessionId: string;
  context: BrowserContext;
  /** Option de session `liveView.interactive`. */
  interactive: boolean;
  maxViewers?: number;
  maxFramesInFlight?: number;
  inputWindowMs?: number;
  now?: () => Date;
  onEvent?: (event: LiveEvent) => void;
};

type Frame = { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number; timestamp?: number } };
type Cast = { cdp: CDPSession; viewers: Set<Viewer>; last: LiveFrameMessage | undefined; size: { width: number; height: number } };

const MOUSE_TYPES: Record<string, 'mousePressed' | 'mouseReleased' | 'mouseMoved'> = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' };
const BUTTONS = new Set(['left', 'middle', 'right', 'none']);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const shortText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

type LiveViewerStats = { sent: number; replaced: number; maxInFlight: number; dropped: number; inputs: number };

export type LiveViewer = {
  receive(message: unknown): Promise<void>;
  detach(): Promise<void>;
  stats(): LiveViewerStats;
};

class Viewer implements LiveViewer {
  page: Page | undefined;
  readonly mode: LiveMode;
  readonly #view: LiveView;
  readonly #channel: LiveChannel;
  readonly #max: number;
  #inFlight = 0;
  #pending: LiveFrameMessage | undefined;
  #noticeSent = false;
  #detached = false;
  readonly #stats: LiveViewerStats = { sent: 0, replaced: 0, maxInFlight: 0, dropped: 0, inputs: 0 };

  constructor(view: LiveView, channel: LiveChannel, mode: LiveMode, maxInFlight: number) {
    this.#view = view;
    this.#channel = channel;
    this.mode = mode;
    this.#max = maxInFlight;
  }

  stats(): LiveViewerStats {
    return { ...this.#stats };
  }

  send(message: LiveServerMessage): Promise<void> {
    if (this.#detached) return Promise.resolve();
    return this.#channel.send(message).catch(() => undefined);
  }

  enqueue(frame: LiveFrameMessage): void {
    if (this.#detached) return;
    if (this.#inFlight < this.#max) return this.#sendFrame(frame);
    if (this.#pending !== undefined) this.#stats.replaced += 1;
    this.#pending = frame;
  }

  #sendFrame(frame: LiveFrameMessage): void {
    this.#inFlight += 1;
    this.#stats.sent += 1;
    this.#stats.maxInFlight = Math.max(this.#stats.maxInFlight, this.#inFlight);
    void this.send(frame).finally(() => {
      this.#inFlight -= 1;
      const next = this.#pending;
      this.#pending = undefined;
      if (next !== undefined && !this.#detached) this.#sendFrame(next);
    });
  }

  async receive(raw: unknown): Promise<void> {
    if (this.#detached || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    const message = raw as Record<string, unknown>;
    if (message['t'] === 'ping') return this.send({ t: 'pong' });
    if (message['t'] === 'tab') {
      if (typeof message['id'] === 'string') await this.#view.switchTab(this, message['id']);
      return;
    }
    if (!['mouse', 'wheel', 'key', 'text'].includes(message['t'] as string)) return;
    if (this.mode !== 'rw') {
      this.#stats.dropped += 1;
      if (!this.#noticeSent) {
        this.#noticeSent = true;
        await this.send({ t: 'notice', text: READ_ONLY_NOTICE });
      }
      return;
    }
    if (await this.#view.dispatch(this, message)) this.#stats.inputs += 1;
  }

  async detach(): Promise<void> {
    if (this.#detached) return;
    this.#detached = true;
    this.#pending = undefined;
    await this.#view.remove(this);
  }

  closeChannel(reason: string): void {
    this.#detached = true;
    this.#channel.close(reason);
  }
}

export class LiveView {
  readonly sessionId: string;
  readonly interactive: boolean;
  readonly #options: LiveViewOptions;
  readonly #context: BrowserContext;
  readonly #viewers = new Set<Viewer>();
  readonly #casts = new Map<Page, Cast>();
  readonly #tabIds = new Map<Page, string>();
  readonly #listeners: (() => void)[] = [];
  #nextTab = 1;
  #frames = 0;
  #acks = 0;
  #inputs = 0;
  #windowStart: Date;
  #closed = false;
  readonly #timer: NodeJS.Timeout;

  constructor(options: LiveViewOptions) {
    this.#options = options;
    this.sessionId = options.sessionId;
    this.interactive = options.interactive;
    this.#context = options.context;
    this.#windowStart = this.#now();
    for (const page of this.#context.pages()) this.#track(page);
    const onPage = (page: Page): void => {
      this.#track(page);
      void this.#broadcastMeta();
    };
    this.#context.on('page', onPage);
    this.#listeners.push(() => this.#context.off('page', onPage));
    this.#timer = setInterval(() => this.#flushInputs(false), options.inputWindowMs ?? LIVE_DEFAULTS.inputWindowMs);
    this.#timer.unref();
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  #track(page: Page): void {
    if (this.#tabIds.has(page)) return;
    this.#tabIds.set(page, `tab-${this.#nextTab++}`);
    const onClose = (): void => void this.#onPageClosed(page);
    const onNavigated = (frame: { parentFrame(): unknown }): void => {
      if (frame.parentFrame() === null) void this.#broadcastMeta();
    };
    page.on('close', onClose);
    page.on('framenavigated', onNavigated);
    this.#listeners.push(() => {
      page.off('close', onClose);
      page.off('framenavigated', onNavigated);
    });
  }

  #livePages(): Page[] {
    return [...this.#tabIds.keys()].filter((p) => !p.isClosed());
  }

  #activePage(): Page | undefined {
    return this.#livePages().at(-1);
  }

  async #meta(viewer: Viewer): Promise<LiveServerMessage> {
    const tabs: LiveTab[] = [];
    for (const page of this.#livePages()) tabs.push({ id: this.#tabIds.get(page)!, url: page.url(), title: await page.title().catch(() => '') });
    const current = viewer.page === undefined ? undefined : tabs.find((t) => t.id === this.#tabIds.get(viewer.page!));
    return { t: 'meta', url: current?.url ?? '', title: current?.title ?? '', tabs, tab: current?.id ?? null, mode: viewer.mode, interactive: this.interactive };
  }

  async #broadcastMeta(): Promise<void> {
    for (const viewer of this.#viewers) await viewer.send(await this.#meta(viewer));
  }

  stats(): { viewers: number; frames: number; acks: number } {
    return { viewers: this.#viewers.size, frames: this.#frames, acks: this.#acks };
  }

  async attach(channel: LiveChannel, mode: LiveMode): Promise<LiveViewer> {
    if (this.#closed) throw new LiveViewClosedError('vue en direct fermée : session terminée');
    if (this.#viewers.size >= (this.#options.maxViewers ?? LIVE_DEFAULTS.maxViewers)) throw new LiveViewFullError('vue en direct : nombre maximal de visionneurs atteint');
    const viewer = new Viewer(this, channel, mode === 'rw' && this.interactive ? 'rw' : 'ro', this.#options.maxFramesInFlight ?? LIVE_DEFAULTS.maxFramesInFlight);
    this.#viewers.add(viewer);
    viewer.page = this.#activePage();
    await viewer.send(await this.#meta(viewer));
    if (viewer.page !== undefined) await this.#watch(viewer, viewer.page);
    return viewer;
  }

  async #watch(viewer: Viewer, page: Page): Promise<void> {
    let cast = this.#casts.get(page);
    if (cast === undefined) {
      const cdp = await this.#context.newCDPSession(page);
      const created: Cast = { cdp, viewers: new Set(), last: undefined, size: page.viewportSize() ?? { width: 1280, height: 720 } };
      cast = created;
      this.#casts.set(page, created);
      cdp.on('Page.screencastFrame', (frame: Frame) => this.#onFrame(page, created, frame));
      await cdp.send('Page.startScreencast', { ...LIVE_DEFAULTS.screencast });
    }
    cast.viewers.add(viewer);
    if (cast.last !== undefined) viewer.enqueue(cast.last);
  }

  async #unwatch(viewer: Viewer): Promise<void> {
    const page = viewer.page;
    const cast = page === undefined ? undefined : this.#casts.get(page);
    if (page === undefined || cast === undefined) return;
    cast.viewers.delete(viewer);
    if (cast.viewers.size > 0) return;
    this.#casts.delete(page);
    await cast.cdp.send('Page.stopScreencast').catch(() => undefined);
    await cast.cdp.detach().catch(() => undefined);
  }

  #onFrame(page: Page, cast: Cast, frame: Frame): void {
    this.#frames += 1;
    const width = frame.metadata.deviceWidth ?? cast.size.width;
    const height = frame.metadata.deviceHeight ?? cast.size.height;
    cast.size = { width: Math.round(width), height: Math.round(height) };
    const message: LiveFrameMessage = { t: 'frame', data: frame.data, ts: frame.metadata.timestamp ?? this.#now().getTime() / 1000, w: cast.size.width, h: cast.size.height, tab: this.#tabIds.get(page) ?? '' };
    cast.last = message;
    for (const viewer of cast.viewers) viewer.enqueue(message);
    this.#acks += 1;
    void cast.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
  }

  async switchTab(viewer: Viewer, id: string): Promise<void> {
    const page = this.#livePages().find((p) => this.#tabIds.get(p) === id);
    if (page === undefined || page === viewer.page) return;
    await this.#unwatch(viewer);
    viewer.page = page;
    await viewer.send(await this.#meta(viewer));
    await this.#watch(viewer, page);
  }

  async #onPageClosed(page: Page): Promise<void> {
    const cast = this.#casts.get(page);
    this.#casts.delete(page);
    await cast?.cdp.detach().catch(() => undefined);
    for (const viewer of this.#viewers) {
      if (viewer.page !== page) continue;
      viewer.page = this.#activePage();
      if (viewer.page !== undefined) await this.#watch(viewer, viewer.page);
    }
    await this.#broadcastMeta();
  }

  /** Entrée d'un visionneur `rw` : commande `Input.*` sur la page qu'il suit ; `false` si le message est invalide. */
  async dispatch(viewer: Viewer, message: Record<string, unknown>): Promise<boolean> {
    const page = viewer.page;
    const cast = page === undefined ? undefined : this.#casts.get(page);
    if (page === undefined || cast === undefined) return false;
    const size = page.viewportSize() ?? cast.size;
    const x = (v: number): number => Math.min(Math.max(0, Math.round(v)), Math.max(0, size.width - 1));
    const y = (v: number): number => Math.min(Math.max(0, Math.round(v)), Math.max(0, size.height - 1));
    const commands: [string, Record<string, unknown>][] = [];
    switch (message['t']) {
      case 'mouse': {
        if (!finite(message['x']) || !finite(message['y'])) return false;
        const button = typeof message['button'] === 'string' && BUTTONS.has(message['button']) ? message['button'] : 'left';
        const point = { x: x(message['x']), y: y(message['y']) };
        if (message['type'] === 'click') {
          commands.push(['Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 }], ['Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 }]);
        } else {
          const type = MOUSE_TYPES[message['type'] as string];
          if (type === undefined) return false;
          commands.push(['Input.dispatchMouseEvent', type === 'mouseMoved' ? { type, ...point } : { type, ...point, button, clickCount: 1 }]);
        }
        break;
      }
      case 'wheel':
        if (!finite(message['x']) || !finite(message['y']) || !finite(message['dx']) || !finite(message['dy'])) return false;
        commands.push(['Input.dispatchMouseEvent', { type: 'mouseWheel', x: x(message['x']), y: y(message['y']), deltaX: message['dx'], deltaY: message['dy'] }]);
        break;
      case 'key': {
        if ((message['type'] !== 'down' && message['type'] !== 'up') || !shortText(message['key'], 32)) return false;
        if (message['code'] !== undefined && !shortText(message['code'], 32)) return false;
        commands.push(['Input.dispatchKeyEvent', { type: message['type'] === 'down' ? 'keyDown' : 'keyUp', key: message['key'], ...(message['code'] === undefined ? {} : { code: message['code'] }) }]);
        break;
      }
      case 'text':
        if (!shortText(message['text'], 1000)) return false;
        commands.push(['Input.insertText', { text: message['text'] }]);
        break;
      default:
        return false;
    }
    for (const [method, params] of commands) await cast.cdp.send(method as 'Input.dispatchMouseEvent', params as never);
    this.#recordInput();
    return true;
  }

  #recordInput(): void {
    if (this.#now().getTime() - this.#windowStart.getTime() >= (this.#options.inputWindowMs ?? LIVE_DEFAULTS.inputWindowMs)) this.#flushInputs(false);
    this.#inputs += 1;
  }

  #flushInputs(final: boolean): void {
    if (this.#inputs > 0) this.#options.onEvent?.({ type: 'live.input', sessionId: this.sessionId, count: this.#inputs, windowStart: this.#windowStart.toISOString() });
    this.#inputs = 0;
    if (!final) this.#windowStart = this.#now();
  }

  async remove(viewer: Viewer): Promise<void> {
    this.#viewers.delete(viewer);
    await this.#unwatch(viewer);
  }

  /** Fin de la session : `{t: 'closed', reason}` à chaque visionneur, canaux fermés, screencasts arrêtés. Idempotent. */
  async close(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    for (const viewer of [...this.#viewers]) {
      await viewer.send({ t: 'closed', reason });
      viewer.closeChannel(reason);
    }
    this.#viewers.clear();
    for (const [, cast] of this.#casts) {
      await cast.cdp.send('Page.stopScreencast').catch(() => undefined);
      await cast.cdp.detach().catch(() => undefined);
    }
    this.#casts.clear();
    for (const off of this.#listeners) off();
    this.#flushInputs(true);
  }
}
