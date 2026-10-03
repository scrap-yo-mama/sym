// SPDX-License-Identifier: AGPL-3.0-only
// Arrêt gracieux et drainage du nœud (cdc/sym-browser 04b § 9 et § 5, 04 § 5 ; tâche 2.7). Appelé par le crochet de drainage
// de l'hôte de service sur SIGTERM (ou par une demande de drainage), une seule fois :
//   1. le superviseur refuse toute nouvelle session (`draining`), puis l'état `draining` est écrit en base : la passerelle
//      écarte le nœud du choix ; `/readyz` répond déjà 503 (hôte de service) ; le battement continue (sinon `node_lost`) ;
//   2. les sessions en cours se terminent seules (raison d'origine) jusqu'à la grâce `SHUTDOWN_GRACE_SECONDS` ;
//   3. à l'échéance, chaque session restante passe `ended` raison `node_shutdown`, destruction complète d'abord (BINV3 :
//      contexte, Chromium, répertoires, objets sauvegardés), puis le pool est fermé (Chromium chauds, balayage des groupes) ;
//   4. le battement s'arrête et `down` est écrit en dernier ; l'hôte de service ferme ensuite l'écoute et sort en code 0.
// Une écriture d'état refusée (base injoignable) est rapportée à `onError` sans arrêter le drainage : les sessions sont
// détruites quoi qu'il arrive.
import { systemClock, type Clock } from '@sym-browser/core';
import type { SessionSupervisor } from '../sessions/supervisor.js';

/** État du nœud écrit par le drainage (`nodes.state`, 04b § 5). */
export type DrainNodeState = 'draining' | 'down';

export type NodeDrainOptions = {
  supervisor: Pick<SessionSupervisor, 'drain' | 'whenEmpty' | 'active' | 'shutdown'>;
  /** `SHUTDOWN_GRACE_SECONDS` en millisecondes (défaut 270 s, maximum 300 s). */
  graceMs: number;
  /** Écriture de `nodes.state` (`setNodeState` de @sym-browser/db). */
  setState: (state: DrainNodeState) => Promise<void>;
  /** Fermeture du pool : Chromium chauds arrêtés, balayage final des groupes et des répertoires. */
  closePool: () => Promise<void>;
  stopHeartbeat?: () => void;
  clock?: Clock;
  onError?: (error: unknown) => void;
};

export type DrainReport = {
  /** Sessions encore tenues à l'échéance de la grâce, terminées raison `node_shutdown` (sauf fin déjà en cours). */
  endedOnShutdown: string[];
  /** Durée du drainage (K11), du début à l'écriture de `down`. */
  elapsedMs: number;
};

export class NodeDrain {
  readonly #options: NodeDrainOptions;
  readonly #clock: Clock;
  #run: Promise<DrainReport> | undefined;

  constructor(options: NodeDrainOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
  }

  get draining(): boolean {
    return this.#run !== undefined;
  }

  /** Drainage complet, idempotent : un second SIGTERM rend le même drainage. */
  drain(): Promise<DrainReport> {
    if (this.#run === undefined) {
      // Étape 1 synchrone : aucune session ne peut démarrer entre le signal et l'écriture de `draining` ; la grâce court
      // dès le signal, écriture comprise.
      this.#options.supervisor.drain();
      const deadline = new AbortController();
      const timer = this.#clock.setTimer(() => deadline.abort(), this.#options.graceMs);
      this.#run = this.#drain(this.#clock.now(), deadline.signal).finally(() => this.#clock.clearTimer(timer));
    }
    return this.#run;
  }

  async #drain(startedAt: number, deadline: AbortSignal): Promise<DrainReport> {
    const { supervisor } = this.#options;
    await this.#setState('draining');

    // Étape 2 : attente de la fin des sessions, bornée par la grâce.
    await supervisor.whenEmpty(deadline);

    // Étape 3 : sessions restantes terminées `node_shutdown` (destruction complète avant l'état final), puis pool fermé.
    const endedOnShutdown = supervisor.active();
    try {
      await supervisor.shutdown();
    } catch (error) {
      this.#report(error);
    }
    try {
      await this.#options.closePool();
    } catch (error) {
      this.#report(error);
    }

    // Étape 4 : plus de battement (il remettrait la ligne à jour), puis `down`.
    this.#options.stopHeartbeat?.();
    await this.#setState('down');
    return { endedOnShutdown, elapsedMs: this.#clock.now() - startedAt };
  }

  async #setState(state: DrainNodeState): Promise<void> {
    try {
      await this.#options.setState(state);
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error: unknown): void {
    this.#options.onError?.(error);
  }
}
