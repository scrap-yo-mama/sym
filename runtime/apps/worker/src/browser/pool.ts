// SPDX-License-Identifier: AGPL-3.0-only
// Pool de Chromium du worker (tâche 1.6 ; 14 §11) : un Chromium par slot (`BROWSER_CONCURRENCY` slots), lancé à la
// demande, recyclé après N runs, après 1 h ou au-delà d'un seuil mémoire, fermé à délai dur (puis tué), chien de garde
// par run. Le contexte de chaque run est neuf et jamais partagé (`run-context.ts`) ; le pool ne prête que le navigateur.
// Le Chromium DÉDIÉ d'un essai agentique (E5 à étapes `agent`, E6 : tâche 2.4, `agent-browser.ts`) est lancé DANS un
// slot (`hold`) : le Chromium partagé du slot est fermé d'abord, un seul dédié à la fois, et les rejeux de compilation
// de l'essai empruntent le slot déjà tenu. Un slot, un Chromium : `BROWSER_CONCURRENCY` borne aussi les essais agentiques.
import type { LaunchedBrowser } from '@sym/contracts/browser';
import type { Browser } from 'playwright-core';

// Contrat du Chromium prêté : `@sym/contracts/browser` (tâche 4.1). Le lanceur de production est `launchShared` du fournisseur
// de navigateur (provider-local.ts pour `local`).
export type { LaunchedBrowser };

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
  /** `dedicated` : Chromium partagé du slot fermé pour laisser la place au Chromium dédié d'un essai agentique. */
  readonly reason?: 'runs' | 'age' | 'memory' | 'disconnected' | 'close_timeout' | 'shutdown' | 'dedicated';
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

/** Navigateur dédié lancé dans un slot : seule sa fermeture importe au pool. */
type DedicatedBrowser = { close(): Promise<void> };

/**
 * Slot tenu pour toute la durée d'un essai agentique (`BrowserPool.hold`). Un seul Chromium vivant dans le slot : le
 * dédié, ou celui du pool, jamais les deux.
 */
export type SlotLease = {
  /** Lance le Chromium dédié de l'essai dans le slot tenu (Chromium partagé du slot fermé d'abord). Un seul à la fois. */
  dedicated<B extends DedicatedBrowser>(launch: () => Promise<B>): Promise<B>;
  /** Prête le Chromium partagé du slot tenu (rejeux de compilation), sans redemander de slot ; refusé si un dédié est ouvert. */
  run<T>(fn: (browser: Browser) => Promise<T>): Promise<T>;
};

class SlotBusyError extends Error {
  override name = 'SlotBusyError';
}

export class BrowserPool {
  readonly size: number;
  readonly #options: BrowserPoolOptions;
  readonly #slots: Slot[];
  /** Runs en attente d’un slot (FIFO). Un waiter interrompu par son signal se retire lui-même de la file. */
  readonly #waiters: (() => void)[] = [];
  /** Fermetures des Chromium dédiés ouverts (`hold`), appelées à l'arrêt du pool. */
  readonly #dedicated = new Set<() => Promise<void>>();
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

  /** Chromium du slot (tenu) prêté le temps de `fn`, recyclé avant et après si dû, chien de garde par run. */
  async #use<T>(slot: Slot, fn: (browser: Browser) => Promise<T>): Promise<T> {
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
  }

  /**
   * Prête un Chromium le temps de `fn` (attente d'un slot libre, interrompue par `signal`). Chien de garde : au-delà de
   * `runWatchdogMs`, le Chromium du slot est tué, ce qui fait échouer `fn`.
   */
  async run<T>(signal: AbortSignal, fn: (browser: Browser) => Promise<T>): Promise<T> {
    const slot = await this.#acquire(signal);
    try {
      return await this.#use(slot, fn);
    } finally {
      this.#release(slot);
    }
  }

  /**
   * Tient un slot le temps de `fn` (essai agentique : Chromium dédié, puis rejeux de compilation sur le Chromium du
   * slot). Attente interrompue par `signal`. Le dédié encore ouvert à la fin de `fn` est fermé avant de rendre le slot ;
   * chien de garde : au-delà de `runWatchdogMs`, le dédié est fermé (l'essai échoue).
   */
  async hold<T>(signal: AbortSignal, fn: (lease: SlotLease) => Promise<T>): Promise<T> {
    const slot = await this.#acquire(signal);
    /** Fermeture (unique) du dédié ouvert dans ce slot ; `undefined` si aucun. */
    let closeOpen: (() => Promise<void>) | undefined;
    let launching = false;
    const lease: SlotLease = {
      dedicated: async <B extends DedicatedBrowser>(launch: () => Promise<B>): Promise<B> => {
        if (closeOpen !== undefined || launching) throw new SlotBusyError('slot : un Chromium dédié est déjà ouvert');
        if (this.#closed) throw new BrowserPoolClosedError('pool de navigateurs fermé');
        launching = true;
        try {
          // Un slot, un Chromium : le Chromium partagé du slot laisse la place au dédié.
          if (slot.launched !== undefined) await this.#retire(slot, 'dedicated');
          const browser = await launch();
          let closing: Promise<void> | undefined;
          const closeOnce = (): Promise<void> =>
            (closing ??= (async () => {
              clearTimeout(watchdog);
              if (closeOpen === closeOnce) closeOpen = undefined;
              this.#dedicated.delete(closeOnce);
              await browser.close().catch(() => undefined);
            })());
          closeOpen = closeOnce;
          this.#dedicated.add(closeOnce);
          const watchdog = setTimeout(() => {
            this.#options.onEvent?.({ kind: 'watchdog', slot: slot.index });
            void closeOnce();
          }, this.#options.runWatchdogMs ?? BROWSER_RECYCLE_DEFAULTS.runWatchdogMs);
          return { ...browser, close: closeOnce };
        } finally {
          launching = false;
        }
      },
      run: async <U>(use: (browser: Browser) => Promise<U>): Promise<U> => {
        if (closeOpen !== undefined || launching) throw new SlotBusyError('slot : Chromium dédié encore ouvert');
        if (this.#closed) throw new BrowserPoolClosedError('pool de navigateurs fermé');
        return this.#use(slot, use);
      },
    };
    try {
      return await fn(lease);
    } finally {
      await closeOpen?.();
      this.#release(slot);
    }
  }

  /** Ferme tous les Chromium, dédiés compris (arrêt du worker). Les runs en cours échouent. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter();
    await Promise.all([...this.#dedicated].map((close) => close()));
    await Promise.all(this.#slots.map((slot) => this.#retire(slot, 'shutdown')));
  }
}
