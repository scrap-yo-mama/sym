// SPDX-License-Identifier: AGPL-3.0-only
// Superviseur des sessions du nœud (cdc/sym-browser 04 § 5, 04b § 4 et § 6, 04c § 3.2 ; tâche 1.2). Il relie le pool de
// Chromium (tâche 1.1, `BrowserPool.acquire` → bail), les délais de session et la persistance des transitions :
// - démarrage : bail pris sur le pool, puis `pending → running` sur ce nœud (table de routage) ; lancement impossible :
//   `failed` raison `crash` ; session déjà terminée en base entre-temps : bail rendu, rien n'est écrit ;
// - délais : total (`expiresAt`, prolongeable) et d'inactivité (chaque message du client repousse) ; le chien de garde du
//   pool est armé sur la durée maximale du client (plafond des prolongations), plus une marge ;
// - fins : libération, budget, quota, délais, plantage (signal du pool), arrêt du nœud. Toute fin rend le bail (le pool
//   arrête et détruit le Chromium s'il le doit) AVANT d'écrire l'état final (04c § 3.2 : l'état public change à la
//   dernière étape ; BINV3). Une seule fin par session, quel que soit le nombre de déclencheurs concurrents.
// - nœud isolé (battement perdu, 04b § 6) : sessions locales détruites sans écriture (la passerelle les a déclarées
//   `failed` raison `node_lost`).
import { endStateFor, SessionTimers, systemClock, type Clock, type EndReason, type ExtendOutcome, type SessionStore, type TransitionOutcome } from '@sym-browser/core';
import type { BrowserPool, LeaseEndReason, PoolLease, SessionType } from '../pool/index.js';

export type SessionPool = Pick<BrowserPool, 'acquire'>;

/** Marge du chien de garde du pool au-delà de la fin au plus tard : la fin normale vient des délais du superviseur. */
const WATCHDOG_GRACE_MS = 5_000;

/** Interruption du bail par le pool (`lease.signal.reason`) → raison de fin (04 § 5). */
const POOL_END_REASONS: Record<LeaseEndReason, ClientEndReason> = { crash: 'crash', timed_out: 'timeout', shutdown: 'node_shutdown' };

/** Ce que le nœud reçoit de la passerelle pour démarrer une session (`POST /internal/sessions`, 04b § 12). Dates en ms. */
export type StartRequest = {
  sessionId: string;
  type: SessionType;
  tenantId: string;
  expiresAt: number;
  /** Création + durée maximale du client : aucune prolongation ne va au-delà. */
  maxExpiresAt: number;
  idleTimeoutSeconds: number;
};

export type StartOutcome = { ok: true } | { ok: false; code: 'open_failed' | 'already_started' | 'not_found' | 'invalid_transition' };
export type EndOutcome = TransitionOutcome | { ok: false; code: 'isolated' };
type ClientEndReason = Extract<EndReason, 'released' | 'budget_exceeded' | 'quota' | 'node_shutdown' | 'timeout' | 'idle' | 'crash'>;

type Lease = Pick<PoolLease, 'signal' | 'release'>;
type Active = { lease: Lease; timers: SessionTimers; ending: Promise<EndOutcome> | undefined };

export type SessionSupervisorOptions = {
  nodeId: string;
  pool: SessionPool;
  store: SessionStore;
  clock?: Clock;
  watchdogGraceMs?: number;
  /** Erreur hors du chemin de l'appelant (destruction incomplète, écriture refusée) : journal du nœud. */
  onError?: (error: unknown) => void;
};

export class SessionSupervisor {
  readonly #nodeId: string;
  readonly #pool: SessionPool;
  readonly #store: SessionStore;
  readonly #clock: Clock;
  readonly #watchdogGraceMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #sessions = new Map<string, Active>();
  readonly #starting = new Set<string>();
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(options: SessionSupervisorOptions) {
    this.#nodeId = options.nodeId;
    this.#pool = options.pool;
    this.#store = options.store;
    this.#clock = options.clock ?? systemClock;
    this.#watchdogGraceMs = options.watchdogGraceMs ?? WATCHDOG_GRACE_MS;
    this.#onError = options.onError ?? (() => undefined);
  }

  /** Sessions tenues par ce nœud (y compris celles dont la fin est en cours). */
  active(): string[] {
    return [...this.#sessions.keys()];
  }

  async start(request: StartRequest): Promise<StartOutcome> {
    const { sessionId } = request;
    if (this.#sessions.has(sessionId) || this.#starting.has(sessionId)) return { ok: false, code: 'already_started' };
    this.#starting.add(sessionId);
    try {
      let lease: Lease;
      try {
        lease = await this.#pool.acquire({
          sessionId,
          type: request.type,
          tenantId: request.tenantId,
          watchdogMs: Math.max(0, request.maxExpiresAt - this.#clock.now()) + this.#watchdogGraceMs,
        });
      } catch (error) {
        // Le pool a déjà rendu le slot réservé ; la session échoue (04 § 5 : `pending → failed`, lancement impossible).
        this.#onError(error);
        await this.#write({ sessionId, to: 'failed', reason: 'crash' });
        return { ok: false, code: 'open_failed' };
      }
      const outcome = await this.#write({ sessionId, to: 'running', reason: null, nodeId: this.#nodeId });
      if (!outcome?.ok) {
        await this.#release(lease);
        return { ok: false, code: outcome?.code ?? 'invalid_transition' };
      }
      const active: Active = {
        lease,
        timers: new SessionTimers({
          clock: this.#clock,
          expiresAt: request.expiresAt,
          idleTimeoutMs: request.idleTimeoutSeconds * 1000,
          onExpire: (reason) => this.#track(this.end(sessionId, reason)),
        }),
        ending: undefined,
      };
      this.#sessions.set(sessionId, active);
      const onAbort = (): void => {
        const reason = lease.signal.reason as LeaseEndReason;
        this.#track(this.end(sessionId, POOL_END_REASONS[reason] ?? 'crash'));
      };
      // Interruption arrivée pendant l'écriture de `running` : traitée tout de suite.
      if (lease.signal.aborted) onAbort();
      else lease.signal.addEventListener('abort', onAbort, { once: true });
      return { ok: true };
    } finally {
      this.#starting.delete(sessionId);
    }
  }

  /** Message Playwright ou CDP du client : le délai d'inactivité repart. */
  activity(sessionId: string): void {
    const active = this.#sessions.get(sessionId);
    if (active && !active.ending) active.timers.touch();
  }

  async extend(sessionId: string, seconds: number): Promise<ExtendOutcome> {
    const active = this.#sessions.get(sessionId);
    if (!active || active.ending) return { ok: false, code: 'not_found' };
    const outcome = await this.#store.extend({ sessionId, seconds });
    if (outcome.ok) active.timers.extendTo(outcome.expiresAt);
    return outcome;
  }

  /** Fin de session : bail rendu (destruction), puis état final. Idempotent : les déclencheurs suivants reçoivent la même fin. */
  end(sessionId: string, reason: ClientEndReason): Promise<EndOutcome> {
    const active = this.#sessions.get(sessionId);
    if (!active) return Promise.resolve({ ok: false, code: 'not_found' });
    active.ending ??= (async (): Promise<EndOutcome> => {
      active.timers.stop();
      await this.#release(active.lease);
      const to = endStateFor('running', reason);
      const outcome = to === undefined ? undefined : await this.#write({ sessionId, to, reason });
      this.#sessions.delete(sessionId);
      return outcome ?? { ok: false, code: 'not_found' };
    })();
    return active.ending;
  }

  /** Arrêt gracieux du nœud : toutes les sessions finissent `ended` raison `node_shutdown`. */
  async shutdown(): Promise<void> {
    await Promise.all(this.active().map((sessionId) => this.end(sessionId, 'node_shutdown')));
  }

  /** Nœud isolé ou déclaré perdu : sessions locales détruites, aucune écriture d'état. */
  async isolate(): Promise<void> {
    await Promise.all(
      [...this.#sessions].map(([sessionId, active]) => {
        active.ending ??= (async (): Promise<EndOutcome> => {
          active.timers.stop();
          await this.#release(active.lease);
          this.#sessions.delete(sessionId);
          return { ok: false, code: 'isolated' };
        })();
        return active.ending;
      }),
    );
  }

  /** Attend la fin des fins déclenchées par les délais ou par le pool (tests, arrêt). */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
  }

  #track(promise: Promise<unknown>): void {
    this.#inFlight.add(promise);
    void promise.catch((error: unknown) => this.#onError(error)).finally(() => this.#inFlight.delete(promise));
  }

  async #release(lease: Lease): Promise<void> {
    try {
      await lease.release();
    } catch (error) {
      this.#onError(error);
    }
  }

  async #write(input: Parameters<SessionStore['transition']>[0]): Promise<TransitionOutcome | undefined> {
    try {
      return await this.#store.transition(input);
    } catch (error) {
      this.#onError(error);
      return undefined;
    }
  }
}
