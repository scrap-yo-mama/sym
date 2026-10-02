// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 3.2 (04d § 1.2 et § 1.3) : vue en direct côté nœud, CDP et canal simulés. Un screencast par page partagé par les
// visionneurs (5 au plus), démarré au premier, arrêté au dernier ; trames acquittées dès leur mise en file ; au plus
// `maxFramesInFlight` trames en vol par visionneur, la plus ancienne en attente remplacée ; lecture seule par défaut (0
// événement d'entrée transmis), interactif sur option de session ET jeton `rw`, coordonnées bornées au viewport.
import type { BrowserContext } from 'playwright-core';
import { describe, expect, test } from 'vitest';
import { LIVE_DEFAULTS, LiveView, LiveViewFullError, READ_ONLY_NOTICE, type LiveChannel, type LiveEvent, type LiveServerMessage } from './index.js';

class FakeCdp {
  readonly sent: [string, Record<string, unknown> | undefined][] = [];
  readonly #listeners = new Map<string, ((p: never) => void)[]>();
  detached = false;
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push([method, params]);
    return Promise.resolve({});
  }
  on(event: string, listener: (p: never) => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }
  off(): void {}
  detach(): Promise<void> {
    this.detached = true;
    return Promise.resolve();
  }
  frame(n: number, size = { w: 1280, h: 720 }): void {
    for (const l of this.#listeners.get('Page.screencastFrame') ?? [])
      l({ data: Buffer.from(`jpeg-${n}`).toString('base64'), sessionId: n, metadata: { deviceWidth: size.w, deviceHeight: size.h, timestamp: n } } as never);
  }
  inputs(): string[] {
    return this.sent.filter(([m]) => m.startsWith('Input.')).map(([m]) => m);
  }
}

class FakePage {
  closed = false;
  readonly cdp = new FakeCdp();
  readonly #listeners = new Map<string, (() => void)[]>();
  constructor(
    readonly address: string,
    readonly heading: string,
  ) {}
  url(): string {
    return this.address;
  }
  title(): Promise<string> {
    return Promise.resolve(this.heading);
  }
  viewportSize(): { width: number; height: number } {
    return { width: 1280, height: 720 };
  }
  isClosed(): boolean {
    return this.closed;
  }
  on(event: string, listener: () => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }
  off(): void {}
  close(): void {
    this.closed = true;
    for (const l of this.#listeners.get('close') ?? []) l();
  }
}

function fakeContext(...pages: FakePage[]) {
  const all = [...pages];
  const listeners: ((p: FakePage) => void)[] = [];
  const context = {
    pages: () => all.filter((p) => !p.closed),
    on: (event: string, l: (p: FakePage) => void) => event === 'page' && listeners.push(l),
    off: () => undefined,
    newCDPSession: (page: FakePage) => Promise.resolve(page.cdp),
  } as unknown as BrowserContext;
  return { context, add: (page: FakePage) => (all.push(page), listeners.forEach((l) => l(page))) };
}

/** Canal simulé : messages reçus ; `slow` : chaque envoi attend `release()`. */
function channel(slow = false) {
  const messages: LiveServerMessage[] = [];
  const waiting: (() => void)[] = [];
  let closed: string | undefined;
  let inFlight = 0;
  let maxInFlight = 0;
  const ch: LiveChannel = {
    send: (message) => {
      messages.push(message);
      if (!slow || message.t !== 'frame') return Promise.resolve();
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<void>((resolve) =>
        waiting.push(() => {
          inFlight -= 1;
          resolve();
        }),
      );
    },
    close: (reason) => void (closed = reason),
  };
  return {
    ch,
    messages,
    frames: () => messages.filter((m): m is Extract<LiveServerMessage, { t: 'frame' }> => m.t === 'frame').map((m) => Buffer.from(m.data, 'base64').toString()),
    release: async () => {
      while (waiting.length > 0) {
        waiting.shift()!();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    closed: () => closed,
    maxInFlight: () => maxInFlight,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('vue en direct côté nœud (04d § 1.2)', () => {
  test('screencast démarré au premier visionneur (réglages par défaut), un seul par page, arrêté au départ du dernier', async () => {
    const page = new FakePage('https://zz.invalid/a', 'A');
    const { context } = fakeContext(page);
    const view = new LiveView({ sessionId: 's1', context, interactive: false });
    expect(LIVE_DEFAULTS).toMatchObject({ maxViewers: 5, maxFramesInFlight: 2 });
    const a = await view.attach(channel().ch, 'ro');
    const b = await view.attach(channel().ch, 'ro');
    expect(page.cdp.sent.filter(([m]) => m === 'Page.startScreencast')).toEqual([['Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }]]);
    await a.detach();
    expect(page.cdp.sent.some(([m]) => m === 'Page.stopScreencast')).toBe(false);
    await b.detach();
    expect(page.cdp.sent.some(([m]) => m === 'Page.stopScreencast')).toBe(true);
    expect(page.cdp.detached).toBe(true);
  });

  test('meta à l’arrivée (URL, titre, onglets, mode) ; trames diffusées à tous, chacune acquittée ; dernière trame au nouveau visionneur', async () => {
    const page = new FakePage('https://zz.invalid/a', 'Titre A');
    const { context } = fakeContext(page);
    const view = new LiveView({ sessionId: 's1', context, interactive: false });
    const first = channel();
    await view.attach(first.ch, 'ro');
    expect(first.messages[0]).toEqual({ t: 'meta', url: 'https://zz.invalid/a', title: 'Titre A', tabs: [{ id: 'tab-1', url: 'https://zz.invalid/a', title: 'Titre A' }], tab: 'tab-1', mode: 'ro', interactive: false });
    page.cdp.frame(1);
    page.cdp.frame(2);
    await settle();
    expect(first.frames()).toEqual(['jpeg-1', 'jpeg-2']);
    expect(first.messages.find((m) => m.t === 'frame')).toMatchObject({ t: 'frame', ts: 1, w: 1280, h: 720, tab: 'tab-1' });
    expect(page.cdp.sent.filter(([m]) => m === 'Page.screencastFrameAck').map(([, p]) => p)).toEqual([{ sessionId: 1 }, { sessionId: 2 }]);
    const late = channel();
    await view.attach(late.ch, 'ro');
    await settle();
    expect(late.frames()).toEqual(['jpeg-2']);
  });

  test('live_view_slow_viewer (D4) : au plus maxFramesInFlight trames en vol, la plus ancienne en attente remplacée, chaque trame acquittée', async () => {
    const page = new FakePage('https://zz.invalid/a', 'A');
    const { context } = fakeContext(page);
    const view = new LiveView({ sessionId: 's1', context, interactive: false });
    const slow = channel(true);
    const viewer = await view.attach(slow.ch, 'ro');
    for (let n = 1; n <= 20; n += 1) page.cdp.frame(n);
    await settle();
    expect(slow.frames()).toEqual(['jpeg-1', 'jpeg-2']);
    expect(page.cdp.sent.filter(([m]) => m === 'Page.screencastFrameAck')).toHaveLength(20);
    await slow.release();
    await settle();
    // Après le désengorgement, seule la plus récente des trames en attente part.
    expect(slow.frames()).toEqual(['jpeg-1', 'jpeg-2', 'jpeg-20']);
    expect(slow.maxInFlight()).toBe(2);
    expect(viewer.stats()).toMatchObject({ sent: 3, replaced: 17, maxInFlight: 2 });
  });

  test('5 visionneurs au plus par session', async () => {
    const { context } = fakeContext(new FakePage('https://zz.invalid/a', 'A'));
    const view = new LiveView({ sessionId: 's1', context, interactive: false });
    for (let i = 0; i < 5; i += 1) await view.attach(channel().ch, 'ro');
    await expect(view.attach(channel().ch, 'ro')).rejects.toThrow(LiveViewFullError);
  });

  test('onglets : le visionneur suit l’onglet actif (le plus récent) et en choisit un autre par {t: tab}', async () => {
    const a = new FakePage('https://zz.invalid/a', 'A');
    const b = new FakePage('https://zz.invalid/b', 'B');
    const ctx = fakeContext(a);
    const view = new LiveView({ sessionId: 's1', context: ctx.context, interactive: false });
    const ch = channel();
    const viewer = await view.attach(ch.ch, 'ro');
    ctx.add(b);
    await settle();
    expect(ch.messages.at(-1)).toMatchObject({ t: 'meta', tabs: [{ id: 'tab-1' }, { id: 'tab-2' }], tab: 'tab-1' });
    await viewer.receive({ t: 'tab', id: 'tab-2' });
    expect(b.cdp.sent.some(([m]) => m === 'Page.startScreencast')).toBe(true);
    expect(a.cdp.sent.some(([m]) => m === 'Page.stopScreencast')).toBe(true);
    b.cdp.frame(7);
    await settle();
    expect(ch.messages.at(-1)).toMatchObject({ t: 'frame', tab: 'tab-2' });
  });

  test('fin de session : {t: closed} puis canal fermé, screencast arrêté', async () => {
    const page = new FakePage('https://zz.invalid/a', 'A');
    const { context } = fakeContext(page);
    const view = new LiveView({ sessionId: 's1', context, interactive: false });
    const ch = channel();
    await view.attach(ch.ch, 'ro');
    await view.close('session_ended');
    expect(ch.messages.at(-1)).toEqual({ t: 'closed', reason: 'session_ended' });
    expect(ch.closed()).toBe('session_ended');
    expect(page.cdp.sent.some(([m]) => m === 'Page.stopScreencast')).toBe(true);
    await expect(view.attach(channel().ch, 'ro')).rejects.toThrow();
  });
});

describe('assert_access_authenticated (BINV7, vue en direct) : lecture seule et interactif (04d § 1.3)', () => {
  const inputs = [
    { t: 'mouse', type: 'click', x: 10, y: 10 },
    { t: 'mouse', type: 'down', x: 10, y: 10 },
    { t: 'mouse', type: 'up', x: 10, y: 10 },
    { t: 'mouse', type: 'move', x: 10, y: 10 },
    { t: 'wheel', x: 10, y: 10, dx: 0, dy: 100 },
    { t: 'key', type: 'down', key: 'a' },
    { t: 'key', type: 'up', key: 'a' },
    { t: 'text', text: 'bonjour' },
  ];

  test('D2 : jeton ro, 50 messages souris et clavier → 0 événement d’entrée transmis ; tab et ping acceptés ; avis « lecture seule » une fois', async () => {
    const page = new FakePage('https://zz.invalid/a', 'A');
    const { context } = fakeContext(page);
    const events: LiveEvent[] = [];
    const view = new LiveView({ sessionId: 's1', context, interactive: true, onEvent: (e) => events.push(e) });
    const ch = channel();
    const viewer = await view.attach(ch.ch, 'ro');
    for (let i = 0; i < 50; i += 1) await viewer.receive(inputs[i % inputs.length]);
    await viewer.receive({ t: 'ping' });
    await viewer.receive({ t: 'tab', id: 'tab-1' });
    expect(page.cdp.inputs()).toEqual([]);
    expect(ch.messages.filter((m) => m.t === 'notice')).toEqual([{ t: 'notice', text: READ_ONLY_NOTICE }]);
    expect(READ_ONLY_NOTICE).toBe('SYM 👻 : lecture seule');
    expect(ch.messages).toContainEqual({ t: 'pong' });
    expect(viewer.stats()).toMatchObject({ dropped: 50, inputs: 0 });
    await view.close('released');
    expect(events).toEqual([]);
  });

  test('jeton rw sur une session NON interactive : lecture seule (option de session requise)', async () => {
    const page = new FakePage('https://zz.invalid/a', 'A');
    const { context } = fakeContext(page);
    const view = new LiveView({ sessionId: 's1', context, interactive: false });
    const ch = channel();
    const viewer = await view.attach(ch.ch, 'rw');
    expect(ch.messages[0]).toMatchObject({ t: 'meta', mode: 'ro' });
    for (const input of inputs) await viewer.receive(input);
    expect(page.cdp.inputs()).toEqual([]);
  });

  test('D3 : jeton rw et session interactive → Input.* sur la page suivie, coordonnées bornées au viewport ; live.input compte sans contenu', async () => {
    const page = new FakePage('https://zz.invalid/a', 'A');
    const { context } = fakeContext(page);
    const events: LiveEvent[] = [];
    const view = new LiveView({ sessionId: 's1', context, interactive: true, onEvent: (e) => events.push(e) });
    const viewer = await view.attach(channel().ch, 'rw');
    await viewer.receive({ t: 'mouse', type: 'click', x: 5000, y: -3, button: 'left' });
    const sent = page.cdp.sent.filter(([m]) => m.startsWith('Input.'));
    expect(sent).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 1279, y: 0, button: 'left', clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1279, y: 0, button: 'left', clickCount: 1 }],
    ]);
    await viewer.receive({ t: 'key', type: 'down', key: 'Enter', code: 'Enter' });
    await viewer.receive({ t: 'text', text: 'été' });
    await viewer.receive({ t: 'wheel', x: 10, y: 10, dx: 0, dy: 120 });
    expect(page.cdp.sent.filter(([m]) => m.startsWith('Input.')).slice(2)).toEqual([
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' }],
      ['Input.insertText', { text: 'été' }],
      ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 10, y: 10, deltaX: 0, deltaY: 120 }],
    ]);
    // Messages malformés : écartés.
    for (const bad of [{ t: 'mouse', type: 'click', x: 'a', y: 1 }, { t: 'text', text: 'x'.repeat(5000) }, { t: 'key', type: 'down' }, { t: 'eval', code: '1' }, 'brut', null]) await viewer.receive(bad);
    expect(page.cdp.inputs()).toHaveLength(5);
    await view.close('released');
    expect(events).toEqual([{ type: 'live.input', sessionId: 's1', count: 4, windowStart: expect.any(String) as string }]);
    expect(JSON.stringify(events)).not.toContain('été');
  });
});
