// SPDX-License-Identifier: AGPL-3.0-only
// Pool de Chromium du nœud (cdc/sym-browser 04b § 1 à § 4, tâche 1.1).
// - Chromium chauds : `WARM_BROWSERS` Chromium lancés d'avance, libres de tout client. Une session `shared` prend un Chromium
//   déjà réservé à son client (moins de `CONTEXTS_PER_BROWSER` sessions), sinon un chaud, qu'elle réserve à son client.
//   Un Chromium qui a servi un client ne sert jamais un autre client : à sa dernière session il est détruit (BINV1 entre
//   clients) et le préchauffage en relance un neuf.
// - Session `dedicated` : un Chromium à elle seule, lancé à la demande par `launchDedicated` (tâche 1.4 : profil temporaire,
//   CDP sur 127.0.0.1, `launchArgs` de la liste fermée), détruit à la fin.
// - Slots par type de session : la capacité (`capacity.ts`) est comptée en unités ; chaque session réserve le poids de son
//   type avant tout lancement, et le rend une fois son Chromium arrêté s'il doit l'être. Pas de file ici : la file d'attente
//   appartient à la passerelle (04b § 7, tâche 2.4) ; un nœud plein refuse (`CapacityExceededError`).
// - Recyclage quand le Chromium n'a plus de session : après N sessions servies (`runs`), après un âge (`age`), au-delà du
//   seuil mémoire du cgroup (`memory`). Un Chromium dû n'accepte plus de nouvelle session ; une session en cours va jusqu'à
//   sa fin. Déconnexion : sessions interrompues (`crash`), processus tué, slots rendus (`disconnected`).
// - Fermeture à délai dur : `close()`, puis kill du groupe de processus au-delà de `closeTimeoutMs` (`close_timeout`).
// - Chiens de garde : de lancement (tué et relancé une fois) et de session (au-delà de son délai : signal `timed_out`,
//   session libérée). Balayage des groupes de processus au démarrage puis toutes les `sweepIntervalMs`.
import type { LaunchArg } from '@sym/contracts/browser';
import type { Browser } from 'playwright-core';
import { PROVISIONAL_CAPACITY, SLOT_UNITS, sessionWeightUnits, type CapacityConstants, type SessionType } from './capacity.js';

export type { SessionType } from './capacity.js';

/** Raisons de recyclage (04b § 4, label `reason` de `symb_recycles_total`, 04d § 3.1). `dedicated` : réservé à la tâche 1.4. */
export const RECYCLE_REASONS = ['runs', 'age', 'memory', 'disconnected', 'close_timeout', 'shutdown', 'dedicated'] as const;
export type RecycleReason = (typeof RECYCLE_REASONS)[number];

/** Raison d'interruption d'une session, lue par son propriétaire sur `lease.signal.reason` (états de 04 § 5, tâche 1.2). */
export type LeaseEndReason = 'crash' | 'timed_out' | 'shutdown';

/** Un Chromium lancé, vu par le pool. Seuls `isConnected`, `onDisconnected`, `close` et `kill` sont utilisés ici. */
export type LaunchedBrowser = {
  readonly id: string;
  /** pid du processus principal (= groupe de processus) ; `undefined` hors processus réel. */
  readonly pid: number | undefined;
  /** WebSocket Playwright local (127.0.0.1, chemin imprévisible), pour le relais de la tâche 2.3. */
  readonly wsEndpoint: string;
  /** Point CDP local (`ws://127.0.0.1:{port}/devtools/browser/{id}`) des Chromium dedicated (tâche 1.4). */
  readonly cdpEndpoint?: string;
  /** Connexion interne du nœud : elle tient les contextes (une déconnexion du client ne les ferme pas). */
  readonly browser: Browser;
  isConnected(): boolean;
  onDisconnected(listener: () => void): void;
  /** Fermeture propre. */
  close(): Promise<void>;
  /** Arrêt forcé du groupe de processus. */
  kill(): Promise<void>;
};

/** Profil persistant d'une session dedicated (04c § 4.2, tâche 3.1) : client, profil, mode d'accès. */
export type LaunchProfile = { tenantId: string; profileId: string; mode: 'read' | 'write' };

/** `launchArgs` : noms de la liste fermée (04 § 3) ; `profile` : profil persistant. Sessions dedicated seulement. */
export type LaunchPurpose = { role: 'warm' | 'dedicated'; sessionId?: string; launchArgs?: readonly LaunchArg[]; profile?: LaunchProfile };
export type BrowserLauncher = (purpose: LaunchPurpose) => Promise<LaunchedBrowser>;

export type PoolEvent =
  | { kind: 'launch'; browserId: string; role: LaunchPurpose['role'] }
  | { kind: 'recycle'; browserId: string; reason: RecycleReason }
  /** Chromium détruit à la fin de sa réservation (dernière session de son client, fin d'une session dedicated) : pas un recyclage. */
  | { kind: 'release'; browserId: string }
  | { kind: 'kill'; browserId: string; reason: 'close_timeout' | 'disconnected' | 'launch_timeout' }
  | { kind: 'watchdog'; target: 'launch' }
  | { kind: 'watchdog'; target: 'session'; sessionId: string }
  | { kind: 'launch_failed'; role: LaunchPurpose['role'] };

export type PoolOptions = {
  /** Slots du nœud (`resolveCapacity`). */
  slotsTotal: number;
  launch: BrowserLauncher;
  /** Lanceur des sessions dedicated (tâche 1.4 : profil temporaire, CDP) ; défaut : `launch`. */
  launchDedicated?: BrowserLauncher;
  warmBrowsers?: number;
  /** Constantes de capacité (poids, contextes par Chromium) ; défaut PROVISOIRE en attendant la tâche 0.6. */
  constants?: CapacityConstants;
  /** `CONTEXTS_PER_BROWSER` posée : prioritaire sur la constante. */
  contextsPerBrowser?: number | null;
  recycleAfterSessions?: number;
  recycleAfterMs?: number;
  /** Vrai si la mémoire de travail atteint `RECYCLE_RSS_PERCENT` de la limite (`memoryHighProbe`). */
  memoryHigh?: () => boolean;
  closeTimeoutMs?: number;
  launchTimeoutMs?: number;
  /** Balayage des processus sans session (groupes du pool) ; 0 : jamais périodique. */
  sweep?: () => unknown;
  sweepIntervalMs?: number;
  now?: () => number;
  onEvent?: (event: PoolEvent) => void;
};

/** Valeurs de 04b § 4 (« à valider, tâche 0.6 » pour les trois premières). */
export const POOL_DEFAULTS = Object.freeze({
  warmBrowsers: 1,
  recycleAfterSessions: 50,
  recycleAfterMs: 3_600_000,
  closeTimeoutMs: 10_000,
  launchTimeoutMs: 60_000,
  sweepIntervalMs: 60_000,
});

export class CapacityExceededError extends Error {
  override name = 'CapacityExceededError';
  readonly type: SessionType;
  readonly slotsFree: number;
  constructor(type: SessionType, slotsFree: number) {
    super(`nœud plein : aucun slot libre pour une session ${type}`);
    this.type = type;
    this.slotsFree = slotsFree;
  }
}

export class PoolClosedError extends Error {
  override name = 'PoolClosedError';
}

export class LaunchTimeoutError extends Error {
  override name = 'LaunchTimeoutError';
}

export type AcquireRequest = {
  sessionId: string;
  type: SessionType;
  tenantId: string;
  /** Chien de garde de session : au-delà, la session est interrompue (`timed_out`) et libérée (`expiresAt`, tâche 1.2). */
  watchdogMs?: number;
  /** Arguments de la liste fermée (04 § 3) : sessions dedicated seulement (la bascule de type se fait avant le pool). */
  launchArgs?: readonly LaunchArg[];
  /** Profil persistant (tâche 3.1) : sessions dedicated seulement, profil du même client. */
  profile?: LaunchProfile;
};

export type PoolLease = {
  readonly sessionId: string;
  readonly type: SessionType;
  readonly tenantId: string;
  readonly browserId: string;
  readonly wsEndpoint: string;
  /** Point CDP local de la session dedicated ; `undefined` pour une session shared (CDP non servi, 04f § 1). */
  readonly cdpEndpoint: string | undefined;
  readonly browser: Browser;
  /** Interrompu quand le pool met fin à la session (raison : `LeaseEndReason`). */
  readonly signal: AbortSignal;
  /** Fin de session : rend le slot (après l'arrêt du Chromium s'il doit s'arrêter). Idempotent. */
  release(): Promise<void>;
};

type Entry = {
  readonly launched: LaunchedBrowser;
  readonly role: LaunchPurpose['role'];
  /** Client auquel le Chromium chaud est réservé ; `null` tant qu'il est libre. */
  tenantId: string | null;
  readonly leases: Set<LeaseState>;
  served: number;
  readonly launchedAt: number;
  retiring: Promise<void> | null;
};

type LeaseState = {
  readonly request: AcquireRequest;
  readonly units: number;
  readonly entry: Entry;
  readonly controller: AbortController;
  timer: NodeJS.Timeout | undefined;
  /** Slot rendu (libération, crash ou arrêt). */
  ended: boolean;
  releasing: Promise<void> | null;
};

export type PoolStats = {
  slotsTotal: number;
  slotsFree: number;
  /** Slots libres, fraction comprise (une session shared réserve une fraction de slot) : base du battement (2.4). */
  slotsFreeExact: number;
  sessions: Record<SessionType, number>;
  browsers: { warm: number; shared: number; dedicated: number };
  recycles: Record<RecycleReason, number>;
};

export class BrowserPool {
  readonly slotsTotal: number;
  readonly #options: PoolOptions;
  readonly #constants: CapacityConstants;
  readonly #contextsPerBrowser: number;
  readonly #now: () => number;
  readonly #entries = new Set<Entry>();
  readonly #recycles = Object.fromEntries(RECYCLE_REASONS.map((r) => [r, 0])) as Record<RecycleReason, number>;
  /** Travaux en vol (préchauffage, retraits) : `whenIdle` et `close` les attendent. */
  readonly #pending = new Set<Promise<unknown>>();
  #usedUnits = 0;
  #warmLaunching = 0;
  #sweepTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: PoolOptions) {
    if (!Number.isInteger(options.slotsTotal) || options.slotsTotal < 1) throw new RangeError('BrowserPool : au moins un slot');
    this.slotsTotal = options.slotsTotal;
    this.#options = options;
    this.#constants = options.constants ?? PROVISIONAL_CAPACITY;
    this.#contextsPerBrowser = options.contextsPerBrowser ?? this.#constants.contextsPerBrowser;
    this.#now = options.now ?? Date.now;
    // Poids validés dès la construction : une constante invalide arrête le nœud au démarrage, pas à la première session.
    sessionWeightUnits('shared', this.#constants);
    sessionWeightUnits('dedicated', this.#constants);
  }

  /** Préchauffage (attendu) et balayage initial, puis périodique. */
  async start(): Promise<void> {
    await this.#options.sweep?.();
    const interval = this.#options.sweepIntervalMs ?? POOL_DEFAULTS.sweepIntervalMs;
    if (this.#options.sweep !== undefined && interval > 0) {
      this.#sweepTimer = setInterval(() => this.#track(Promise.resolve(this.#options.sweep?.())), interval);
      this.#sweepTimer.unref();
    }
    this.#refill();
    await this.whenIdle();
  }

  /** Attend la fin des travaux en vol (préchauffage, retraits, kills). */
  async whenIdle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  /** Slots libres pour une session de ce type. */
  freeFor(type: SessionType): number {
    return Math.floor((this.slotsTotal * SLOT_UNITS - this.#usedUnits) / sessionWeightUnits(type, this.#constants));
  }

  /**
   * Chromium vivants du pool et leur type (`dedicated`, ou `shared` pour un Chromium chaud) : RSS par type de
   * `symb_browser_rss_bytes` (tâche 3.7). Seuls les processus réels (pid connu) sont rendus.
   */
  processes(): { pid: number; kind: SessionType }[] {
    return [...this.#entries].flatMap((e) => (e.launched.pid === undefined ? [] : [{ pid: e.launched.pid, kind: e.role === 'dedicated' ? ('dedicated' as const) : ('shared' as const) }]));
  }

  stats(): PoolStats {
    const sessions: Record<SessionType, number> = { shared: 0, dedicated: 0 };
    const browsers = { warm: 0, shared: 0, dedicated: 0 };
    for (const entry of this.#entries) {
      for (const lease of entry.leases) sessions[lease.request.type] += 1;
      if (entry.role === 'dedicated') browsers.dedicated += 1;
      else if (entry.tenantId === null) browsers.warm += 1;
      else browsers.shared += 1;
    }
    return { slotsTotal: this.slotsTotal, slotsFree: Math.floor((this.slotsTotal * SLOT_UNITS - this.#usedUnits) / SLOT_UNITS), slotsFreeExact: (this.slotsTotal * SLOT_UNITS - this.#usedUnits) / SLOT_UNITS, sessions, browsers, recycles: { ...this.#recycles } };
  }

  async acquire(request: AcquireRequest): Promise<PoolLease> {
    if (this.#closed) throw new PoolClosedError('pool de navigateurs fermé');
    if (request.type !== 'dedicated' && (request.launchArgs?.length ?? 0) > 0) throw new RangeError('launchArgs : réservés aux sessions dedicated');
    if (request.profile !== undefined && request.type !== 'dedicated') throw new RangeError('profil persistant : réservé aux sessions dedicated');
    if (request.profile !== undefined && request.profile.tenantId !== request.tenantId) throw new RangeError('profil persistant : profil d’un autre client');
    const units = sessionWeightUnits(request.type, this.#constants);
    if (this.slotsTotal * SLOT_UNITS - this.#usedUnits < units) throw new CapacityExceededError(request.type, this.freeFor(request.type));
    // Réservation synchrone avant tout `await` : deux demandes simultanées ne prennent jamais le même slot.
    this.#usedUnits += units;
    let entry: Entry;
    try {
      entry = request.type === 'dedicated' ? await this.#launchEntry('dedicated', request.sessionId, request.launchArgs, request.profile) : await this.#sharedEntryFor(request.tenantId);
      if (this.#closed) {
        if (entry.leases.size === 0) await this.#retire(entry, 'shutdown');
        throw new PoolClosedError('pool de navigateurs fermé');
      }
    } catch (error) {
      this.#usedUnits -= units;
      throw error;
    }
    if (entry.role === 'dedicated') entry.tenantId = request.tenantId;
    const state: LeaseState = { request, units, entry, controller: new AbortController(), timer: undefined, ended: false, releasing: null };
    entry.leases.add(state);
    entry.served += 1;
    if (request.watchdogMs !== undefined) {
      state.timer = setTimeout(() => {
        this.#options.onEvent?.({ kind: 'watchdog', target: 'session', sessionId: request.sessionId });
        state.controller.abort('timed_out' satisfies LeaseEndReason);
        this.#track(this.#release(state));
      }, request.watchdogMs);
      state.timer.unref();
    }
    return {
      sessionId: request.sessionId,
      type: request.type,
      tenantId: request.tenantId,
      browserId: entry.launched.id,
      wsEndpoint: entry.launched.wsEndpoint,
      cdpEndpoint: entry.role === 'dedicated' ? entry.launched.cdpEndpoint : undefined,
      browser: entry.launched.browser,
      signal: state.controller.signal,
      release: () => this.#release(state),
    };
  }

  /** Arrêt du nœud : sessions interrompues (`shutdown`), chaque Chromium recyclé raison `shutdown`, balayage final. */
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#sweepTimer);
    await this.whenIdle();
    for (const entry of this.#entries) {
      for (const lease of entry.leases) this.#endLease(lease, 'shutdown');
      entry.leases.clear();
    }
    await Promise.all([...this.#entries].map((entry) => this.#retire(entry, 'shutdown')));
    await this.whenIdle();
    await this.#options.sweep?.();
  }

  #track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  /** Raison de recyclage due. À l'attribution d'une nouvelle session, la mémoire ne compte pas (elle joue à la dernière session). */
  #dueReason(entry: Entry, atIdle: boolean): RecycleReason | undefined {
    if (!entry.launched.isConnected()) return 'disconnected';
    if (entry.served >= (this.#options.recycleAfterSessions ?? POOL_DEFAULTS.recycleAfterSessions)) return 'runs';
    if (this.#now() - entry.launchedAt >= (this.#options.recycleAfterMs ?? POOL_DEFAULTS.recycleAfterMs)) return 'age';
    if (atIdle && this.#options.memoryHigh?.() === true) return 'memory';
    return undefined;
  }

  async #sharedEntryFor(tenantId: string): Promise<Entry> {
    for (const entry of this.#entries) {
      if (entry.role !== 'warm' || entry.tenantId !== tenantId || entry.retiring !== null) continue;
      if (entry.leases.size < this.#contextsPerBrowser && this.#dueReason(entry, false) === undefined) return entry;
    }
    for (const entry of [...this.#entries]) {
      if (entry.role !== 'warm' || entry.tenantId !== null || entry.retiring !== null) continue;
      // La mémoire ne joue qu'à la dernière session (04b § 4) : sous pression durable, recycler le chaud à chaque
      // attribution relancerait un Chromium par session.
      const due = this.#dueReason(entry, false);
      if (due !== undefined) {
        this.#track(this.#retire(entry, due));
        continue;
      }
      entry.tenantId = tenantId;
      this.#refill();
      return entry;
    }
    const entry = await this.#launchEntry('warm');
    entry.tenantId = tenantId;
    this.#refill();
    return entry;
  }

  /** Préchauffage : relance des Chromium libres jusqu'à `WARM_BROWSERS` (un échec est signalé, le suivant réessaie). */
  #refill(): void {
    if (this.#closed) return;
    let free = this.#warmLaunching;
    for (const entry of this.#entries) if (entry.role === 'warm' && entry.tenantId === null && entry.retiring === null) free += 1;
    for (let missing = (this.#options.warmBrowsers ?? POOL_DEFAULTS.warmBrowsers) - free; missing > 0; missing -= 1) {
      this.#warmLaunching += 1;
      this.#track(
        this.#launchEntry('warm')
          .then(async (entry) => {
            if (this.#closed) await this.#retire(entry, 'shutdown');
          })
          .catch(() => this.#options.onEvent?.({ kind: 'launch_failed', role: 'warm' }))
          .finally(() => (this.#warmLaunching -= 1)),
      );
    }
  }

  /** Lancement sous chien de garde : au-delà du délai, le Chromium (s'il arrive) est tué, et un second essai est fait. */
  async #launchEntry(role: LaunchPurpose['role'], sessionId?: string, launchArgs?: readonly LaunchArg[], profile?: LaunchProfile): Promise<Entry> {
    const launcher = role === 'dedicated' ? (this.#options.launchDedicated ?? this.#options.launch) : this.#options.launch;
    const purpose: LaunchPurpose = sessionId === undefined ? { role } : { role, sessionId };
    if (launchArgs !== undefined && launchArgs.length > 0) purpose.launchArgs = [...launchArgs];
    if (profile !== undefined) purpose.profile = { ...profile };
    const timeoutMs = this.#options.launchTimeoutMs ?? POOL_DEFAULTS.launchTimeoutMs;
    let launched: LaunchedBrowser | undefined;
    for (let attempt = 0; attempt < 2 && launched === undefined; attempt += 1) {
      const pending = launcher(purpose);
      let timer: NodeJS.Timeout | undefined;
      let outcome: LaunchedBrowser | 'timeout';
      try {
        outcome = await Promise.race([pending, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs)))]);
      } finally {
        clearTimeout(timer);
      }
      if (outcome !== 'timeout') {
        launched = outcome;
        break;
      }
      this.#options.onEvent?.({ kind: 'watchdog', target: 'launch' });
      this.#track(
        pending.then(async (late) => {
          this.#options.onEvent?.({ kind: 'kill', browserId: late.id, reason: 'launch_timeout' });
          await late.kill();
        }),
      );
    }
    if (launched === undefined) throw new LaunchTimeoutError(`Chromium n’a pas répondu en ${timeoutMs} ms (deux essais)`);
    const entry: Entry = { launched, role, tenantId: null, leases: new Set(), served: 0, launchedAt: this.#now(), retiring: null };
    this.#entries.add(entry);
    launched.onDisconnected(() => this.#onDisconnected(entry));
    this.#options.onEvent?.({ kind: 'launch', browserId: launched.id, role });
    return entry;
  }

  #onDisconnected(entry: Entry): void {
    if (entry.retiring !== null || !this.#entries.has(entry)) return;
    for (const lease of entry.leases) this.#endLease(lease, 'crash');
    entry.leases.clear();
    this.#track(this.#retire(entry, 'disconnected'));
  }

  /** Fin imposée par le pool : signal au propriétaire, slot rendu tout de suite (le Chromium est déjà perdu ou arrêté). */
  #endLease(lease: LeaseState, reason: LeaseEndReason): void {
    if (lease.ended) return;
    lease.ended = true;
    clearTimeout(lease.timer);
    this.#usedUnits -= lease.units;
    lease.controller.abort(reason);
  }

  #release(lease: LeaseState): Promise<void> {
    lease.releasing ??= (async () => {
      if (lease.ended) return;
      clearTimeout(lease.timer);
      const { entry } = lease;
      entry.leases.delete(lease);
      if (entry.leases.size === 0 && entry.retiring === null && this.#entries.has(entry)) {
        // Dernière session du Chromium : jamais rendu à un autre client. Recyclage si une raison est due, sinon fin de réservation.
        const due = entry.role === 'dedicated' ? (entry.launched.isConnected() ? undefined : 'disconnected') : this.#dueReason(entry, true);
        await this.#retire(entry, due ?? 'release');
      }
      if (!lease.ended) {
        lease.ended = true;
        this.#usedUnits -= lease.units;
      }
    })();
    return lease.releasing;
  }

  /** Retrait d'un Chromium : `close()` à délai dur, puis kill du groupe ; une déconnexion tue directement. Idempotent. */
  #retire(entry: Entry, cause: RecycleReason | 'release'): Promise<void> {
    entry.retiring ??= (async () => {
      const { launched } = entry;
      if (cause === 'release') this.#options.onEvent?.({ kind: 'release', browserId: launched.id });
      else {
        this.#recycles[cause] += 1;
        this.#options.onEvent?.({ kind: 'recycle', browserId: launched.id, reason: cause });
      }
      try {
        if (cause === 'disconnected') {
          this.#options.onEvent?.({ kind: 'kill', browserId: launched.id, reason: 'disconnected' });
          await launched.kill();
          return;
        }
        let timer: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([
          launched.close().then(
            () => false,
            () => true,
          ),
          new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), this.#options.closeTimeoutMs ?? POOL_DEFAULTS.closeTimeoutMs))),
        ]);
        clearTimeout(timer);
        if (timedOut) {
          this.#recycles.close_timeout += 1;
          this.#options.onEvent?.({ kind: 'kill', browserId: launched.id, reason: 'close_timeout' });
          await launched.kill();
        }
      } finally {
        this.#entries.delete(entry);
        if (entry.role === 'warm') this.#refill();
      }
    })();
    return entry.retiring;
  }
}
