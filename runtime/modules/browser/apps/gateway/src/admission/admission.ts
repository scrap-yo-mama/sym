// SPDX-License-Identifier: AGPL-3.0-only
// Admission côté passerelle (cdc/sym-browser 04b § 7, tâche 2.4) : met chaque demande en file en base (@sym-browser/db,
// décisions sérialisées entre passerelles), attend son placement sur un nœud et sert la file : à chaque libération connue
// de cette passerelle, et périodiquement tant qu'une demande attend ici (une fin de session écrite par un nœud, ou une
// place faite par une autre passerelle, est vue au passage suivant). Mesure les attentes pour `Retry-After`.
import { admitQueued, assignedNodes, enqueueSession, QUEUE_DEFAULTS, type Admitted, type EnqueueOutcome, type EnqueueRequest, type QueueLimits } from '@sym-browser/db';
import type pg from 'pg';
import { QueueWaits } from './retry-after.js';

export type Placement = { nodeId: string; nodeUrl: string };

export type AdmissionOptions = {
  db: pg.Pool;
  limits?: Partial<QueueLimits>;
  /** Période de service de la file tant qu'une demande attend ici (défaut 250 ms). */
  pollMs?: number;
  onError?: (error: unknown) => void;
  now?: () => number;
};

type Waiter = { enqueuedAt: number; resolve: (placement: Placement | null) => void };

export class Admission {
  readonly limits: QueueLimits;
  readonly waits = new QueueWaits();
  readonly #db: pg.Pool;
  readonly #pollMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #now: () => number;
  readonly #waiters = new Map<string, Waiter>();
  /** Placements arrivés avant que leur demandeur n'attende (même passage que la mise en file d'une autre demande). */
  readonly #early = new Map<string, Placement>();
  #timer: NodeJS.Timeout | undefined;
  #pumping: Promise<void> | null = null;
  #again = false;
  #closed = false;

  constructor(options: AdmissionOptions) {
    this.limits = { ...QUEUE_DEFAULTS, ...options.limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} : entier positif ou nul attendu (reçu ${value})`);
    }
    this.#db = options.db;
    this.#pollMs = options.pollMs ?? 250;
    this.#onError = options.onError ?? (() => undefined);
    this.#now = options.now ?? Date.now;
  }

  /** Retry-After des refus de file ou de sessions simultanées (s). */
  retryAfterSeconds(): number {
    return this.waits.retryAfterSeconds();
  }

  async enqueue(request: EnqueueRequest): Promise<EnqueueOutcome> {
    const outcome = await enqueueSession(this.#db, request, this.limits);
    if (outcome.ok && !outcome.admitted) this.#deliver(outcome.others);
    return outcome;
  }

  /**
   * Attend le placement d'une session en file : le nœud, ou `null` si elle a quitté la file sans nœud (fin imposée).
   * `signal` interrompt l'attente (délai de file) : la promesse rend alors `null` aussi.
   */
  wait(sessionId: string, signal?: AbortSignal): Promise<Placement | null> {
    const early = this.#early.get(sessionId);
    if (early) {
      this.#early.delete(sessionId);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      const done = (placement: Placement | null) => {
        this.#waiters.delete(sessionId);
        signal?.removeEventListener('abort', onAbort);
        this.#schedule();
        resolve(placement);
      };
      const onAbort = () => done(null);
      if (signal?.aborted) return resolve(null);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.set(sessionId, { enqueuedAt: this.#now(), resolve: done });
      this.#schedule();
    });
  }

  /** Un passage de service de la file (après une libération) ; les passages concurrents se regroupent. */
  pump(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#pumping) {
      this.#again = true;
      return this.#pumping;
    }
    this.#pumping = (async () => {
      do {
        this.#again = false;
        try {
          this.#deliver(await admitQueued(this.#db));
          // Placements faits par une autre passerelle, ou sessions sorties de la file sans nœud.
          const pending = [...this.#waiters.keys()];
          for (const [sessionId, placement] of await assignedNodes(this.#db, pending)) this.#settle(sessionId, placement);
        } catch (error) {
          this.#onError(error);
        }
      } while (this.#again && !this.#closed);
    })().finally(() => {
      this.#pumping = null;
    });
    return this.#pumping;
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    for (const waiter of [...this.#waiters.values()]) waiter.resolve(null);
    await this.#pumping;
  }

  #deliver(admitted: readonly Admitted[]): void {
    for (const a of admitted) {
      const placement = { nodeId: a.nodeId, nodeUrl: a.nodeUrl };
      if (this.#waiters.has(a.sessionId)) this.#settle(a.sessionId, placement);
      else this.#early.set(a.sessionId, placement);
    }
    // Les placements jamais réclamés (demande d'une autre passerelle) ne s'accumulent pas.
    if (this.#early.size > 1000) for (const key of [...this.#early.keys()].slice(0, this.#early.size - 1000)) this.#early.delete(key);
  }

  #settle(sessionId: string, placement: Placement | null): void {
    const waiter = this.#waiters.get(sessionId);
    if (!waiter) return;
    if (placement) this.waits.record(this.#now() - waiter.enqueuedAt);
    waiter.resolve(placement);
  }

  #schedule(): void {
    if (this.#closed || this.#waiters.size === 0) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      return;
    }
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.pump(), this.#pollMs);
    this.#timer.unref();
  }
}
