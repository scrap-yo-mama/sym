// SPDX-License-Identifier: AGPL-3.0-only
// Pool de Chromium du worker (tâche 1.6 ; 14 §11) : un Chromium par slot (`BROWSER_CONCURRENCY` slots), lancé à la
// demande, recyclé après N runs, après 1 h ou au-delà d'un seuil mémoire, fermé à délai dur (puis tué), chien de garde
// par run. Le contexte de chaque run est neuf et jamais partagé (`run-context.ts`) ; le pool ne prête que le navigateur.
import { chromium, type Browser } from 'playwright-core';
import { assertNotRoot, chromiumLaunchOptions } from './launch.js';

export type LaunchedBrowser = {
  readonly browser: Browser;
  /** Fermeture propre. */
  close(): Promise<void>;
  /** Arrêt forcé du processus Chromium. */
  kill(): Promise<void>;
};

export type BrowserLauncher = () => Promise<LaunchedBrowser>;

/** Valeurs de recyclage (à valider au pilote, tâche 4.4). */
const BROWSER_RECYCLE_DEFAULTS = Object.freeze({
  afterRuns: 50,
  maxAgeMs: 3_600_000,
  closeTimeoutMs: 10_000,
  runWatchdogMs: 15 * 60_000,
});

export type BrowserPoolEvent = {
  readonly kind: 'launch' | 'recycle' | 'kill' | 'watchdog';
  readonly slot: number;
  readonly reason?: 'runs' | 'age' | 'memory' | 'disconnected' | 'close_timeout' | 'shutdown';
};

export type BrowserPoolOptions = {
  readonly size: number;
  readonly launch: BrowserLauncher;
  readonly recycleAfterRuns?: number;
  readonly maxAgeMs?: number;
  /** Vrai si la mémoire dépasse le seuil de recyclage (cgroup). */
  readonly memoryHigh?: () => boolean;
  readonly closeTimeoutMs?: number;
  readonly runWatchdogMs?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: BrowserPoolEvent) => void;
};

type Slot = { index: number; busy: boolean; launched: LaunchedBrowser | undefined; runs: number; launchedAt: number };

export class BrowserPoolClosedError extends Error {
  override name = 'BrowserPoolClosedError';
}

export class BrowserPool {
  readonly size: number;
  readonly #options: BrowserPoolOptions;
  readonly #slots: Slot[];
  /** Runs en attente d’un slot (FIFO). Un waiter interrompu par son signal se retire lui-même de la file. */
  readonly #waiters: (() => void)[] = [];
  readonly #now: () => number;
  #closed = false;

  constructor(options: BrowserPoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) throw new RangeError('BrowserPool : au moins un slot');
    this.size = options.size;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#slots = Array.from({ length: options.size }, (_, index) => ({ index, busy: false, launched: undefined, runs: 0, launchedAt: 0 }));
  }

  /** Runs navigateur en cours (`worker_heartbeats.browser_contexts`). */
  active(): number {
    return this.#slots.filter((s) => s.busy).length;
  }

  /** Chromium vivants. */
  launched(): number {
    return this.#slots.filter((s) => s.launched !== undefined).length;
  }

  #dueReason(slot: Slot): BrowserPoolEvent['reason'] | undefined {
    if (slot.launched === undefined) return undefined;
    if (!slot.launched.browser.isConnected()) return 'disconnected';
    if (slot.runs >= (this.#options.recycleAfterRuns ?? BROWSER_RECYCLE_DEFAULTS.afterRuns)) return 'runs';
    if (this.#now() - slot.launchedAt >= (this.#options.maxAgeMs ?? BROWSER_RECYCLE_DEFAULTS.maxAgeMs)) return 'age';
    if (this.#options.memoryHigh?.() === true) return 'memory';
    return undefined;
  }

  /** Fermeture à délai dur : `close()`, puis `kill()` si le délai est dépassé. */
  async #retire(slot: Slot, reason: NonNullable<BrowserPoolEvent['reason']>): Promise<void> {
    const launched = slot.launched;
    slot.launched = undefined;
    slot.runs = 0;
    if (launched === undefined) return;
    this.#options.onEvent?.({ kind: 'recycle', slot: slot.index, reason });
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      launched.close().then(
        () => false,
        () => true,
      ),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), this.#options.closeTimeoutMs ?? BROWSER_RECYCLE_DEFAULTS.closeTimeoutMs))),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      this.#options.onEvent?.({ kind: 'kill', slot: slot.index, reason: 'close_timeout' });
      await launched.kill().catch(() => undefined);
    }
  }

  async #acquire(signal: AbortSignal): Promise<Slot> {
    for (;;) {
      signal.throwIfAborted();
      if (this.#closed) throw new BrowserPoolClosedError('pool de navigateurs fermé');
      const free = this.#slots.find((s) => !s.busy);
      if (free !== undefined) {
        free.busy = true;
        return free;
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        // Interrompu (annulation, bail perdu) : retiré de la file, sinon le prochain #release le consommerait sans
        // réveiller personne et un autre run resterait bloqué malgré un slot libre.
        const onAbort = () => {
          const index = this.#waiters.indexOf(wake);
          if (index !== -1) this.#waiters.splice(index, 1);
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this.#waiters.push(wake);
      });
    }
  }

  #release(slot: Slot): void {
    slot.busy = false;
    this.#waiters.shift()?.();
  }

  /**
   * Prête un Chromium le temps de `fn` (attente d'un slot libre, interrompue par `signal`). Chien de garde : au-delà de
   * `runWatchdogMs`, le Chromium du slot est tué, ce qui fait échouer `fn`.
   */
  async run<T>(signal: AbortSignal, fn: (browser: Browser) => Promise<T>): Promise<T> {
    const slot = await this.#acquire(signal);
    try {
      const due = this.#dueReason(slot);
      if (due !== undefined) await this.#retire(slot, due);
      if (slot.launched === undefined) {
        slot.launched = await this.#options.launch();
        slot.launchedAt = this.#now();
        this.#options.onEvent?.({ kind: 'launch', slot: slot.index });
      }
      const launched = slot.launched;
      const watchdog = setTimeout(() => {
        this.#options.onEvent?.({ kind: 'watchdog', slot: slot.index });
        if (slot.launched === launched) slot.launched = undefined;
        void launched.kill().catch(() => undefined);
      }, this.#options.runWatchdogMs ?? BROWSER_RECYCLE_DEFAULTS.runWatchdogMs);
      try {
        return await fn(launched.browser);
      } finally {
        clearTimeout(watchdog);
        slot.runs += 1;
        const after = this.#dueReason(slot);
        if (after !== undefined) await this.#retire(slot, after);
      }
    } finally {
      this.#release(slot);
    }
  }

  /** Ferme tous les Chromium (arrêt du worker). Les runs en cours échouent. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter();
    await Promise.all(this.#slots.map((slot) => this.#retire(slot, 'shutdown')));
  }
}

/** Lanceur de production : `launchServer` (processus tuable) puis `connect`, options figées (`launch.ts`). */
export function playwrightLauncher(launchProxyUrl: string, env: Readonly<Record<string, string | undefined>> = process.env): BrowserLauncher {
  return async () => {
    assertNotRoot();
    const options = chromiumLaunchOptions(launchProxyUrl, env);
    const server = await chromium.launchServer({ ...options, args: [...options.args], proxy: { ...options.proxy } });
    try {
      const browser = await chromium.connect(server.wsEndpoint());
      return {
        browser,
        close: async () => {
          await browser.close().catch(() => undefined);
          await server.close();
        },
        kill: () => server.kill(),
      };
    } catch (error) {
      await server.kill().catch(() => undefined);
      throw error;
    }
  };
}
