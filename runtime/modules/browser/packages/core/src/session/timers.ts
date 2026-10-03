// SPDX-License-Identifier: AGPL-3.0-only
// Délais d'une session `running` (04 § 3 et § 5, tâche 1.2) : délai total (`expiresAt`, raison `timeout`) et délai
// d'inactivité (`idleTimeoutSeconds` sans message Playwright ou CDP du client, raison `idle` ; il court aussi quand aucune
// connexion n'est ouverte). Une seule minuterie, armée sur la plus proche échéance ; un seul déclenchement.
import type { Clock, TimerHandle } from './clock.js';

export type ExpiryReason = 'timeout' | 'idle';

export type SessionTimersOptions = {
  clock: Clock;
  /** Fin au plus tard, en millisecondes. */
  expiresAt: number;
  idleTimeoutMs: number;
  onExpire: (reason: ExpiryReason) => void;
};

export class SessionTimers {
  readonly #clock: Clock;
  readonly #idleTimeoutMs: number;
  readonly #onExpire: (reason: ExpiryReason) => void;
  #expiresAt: number;
  #idleDeadline: number;
  #timer: TimerHandle | undefined;
  #done = false;

  constructor(options: SessionTimersOptions) {
    if (!(options.idleTimeoutMs > 0)) throw new RangeError(`idleTimeoutMs : durée positive attendue (reçu ${options.idleTimeoutMs})`);
    this.#clock = options.clock;
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#onExpire = options.onExpire;
    this.#expiresAt = options.expiresAt;
    this.#idleDeadline = this.#clock.now() + this.#idleTimeoutMs;
    this.#arm();
  }

  get expiresAt(): number {
    return this.#expiresAt;
  }

  get idleDeadline(): number {
    return this.#idleDeadline;
  }

  /** Message du client : le délai d'inactivité repart de maintenant. */
  touch(): void {
    if (this.#done) return;
    this.#idleDeadline = this.#clock.now() + this.#idleTimeoutMs;
    // La minuterie armée sur l'ancienne échéance se réarme d'elle-même à son réveil : pas de réarmement à chaque message.
  }

  /** Prolongation : nouvelle fin au plus tard (déjà plafonnée par `extendedExpiry`). */
  extendTo(expiresAt: number): void {
    if (this.#done) return;
    this.#expiresAt = expiresAt;
    this.#arm();
  }

  stop(): void {
    this.#done = true;
    if (this.#timer) this.#clock.clearTimer(this.#timer);
    this.#timer = undefined;
  }

  #arm(): void {
    if (this.#timer) this.#clock.clearTimer(this.#timer);
    const due = Math.min(this.#expiresAt, this.#idleDeadline);
    this.#timer = this.#clock.setTimer(() => this.#wake(), due - this.#clock.now());
  }

  #wake(): void {
    this.#timer = undefined;
    if (this.#done) return;
    const now = this.#clock.now();
    // Délai total prioritaire à égalité : la fin au plus tard est une borne dure.
    const reason: ExpiryReason | undefined = now >= this.#expiresAt ? 'timeout' : now >= this.#idleDeadline ? 'idle' : undefined;
    if (reason === undefined) {
      this.#arm();
      return;
    }
    this.#done = true;
    this.#onExpire(reason);
  }
}
