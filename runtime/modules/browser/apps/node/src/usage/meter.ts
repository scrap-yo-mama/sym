// SPDX-License-Identifier: AGPL-3.0-only
// Compteur d'usage du nœud (cdc/sym-browser 04d § 4.1, tâche 2.6, BINV5). Le nœud est la seule source des mesures :
// - durée : de l'instant où la session passe `running` à sa destruction, sur l'horloge MONOTONE du nœud (un recalage de
//   l'horloge murale ne change aucune durée), en millisecondes entières ;
// - octets : `bytesIn` et `bytesOut` de l'egress de la session (04c § 1.5). Une nouvelle politique ouvre une époque aux
//   compteurs remis à zéro ; le compteur garde le dernier relevé de chaque époque et en fait la somme.
import { performance } from 'node:perf_hooks';
import type { UsageClosure } from '@sym-browser/core';
import type { EgressState } from '@sym/contracts/browser';
import type { SessionEgress } from '../egress/index.js';

type Measure = {
  startMono: number;
  startedAt: number;
  /** Somme des époques closes. */
  closedIn: number;
  closedOut: number;
  /** Époque courante et son dernier relevé (compteurs croissants dans une époque). */
  epoch: number;
  epochIn: number;
  epochOut: number;
};

export type UsageMeterOptions = {
  nodeId: string;
  /** Horloge monotone en ms (défaut `performance.now`). */
  monotonic?: () => number;
  /** Horloge murale en ms depuis l'époque Unix (défaut `Date.now`) : date de début seulement. */
  now?: () => number;
};

export class UsageMeter {
  readonly #nodeId: string;
  readonly #monotonic: () => number;
  readonly #now: () => number;
  readonly #measures = new Map<string, Measure>();

  constructor(options: UsageMeterOptions) {
    this.#nodeId = options.nodeId;
    this.#monotonic = options.monotonic ?? (() => performance.now());
    this.#now = options.now ?? Date.now;
  }

  /** Passage `running` : la mesure démarre. Une session déjà mesurée garde sa mesure. */
  start(sessionId: string): void {
    if (this.#measures.has(sessionId)) return;
    this.#measures.set(sessionId, { startMono: this.#monotonic(), startedAt: this.#now(), closedIn: 0, closedOut: 0, epoch: 0, epochIn: 0, epochOut: 0 });
  }

  /** Relevé des compteurs de l'egress de la session (périodique, avant une nouvelle époque, à la fermeture). */
  observe(sessionId: string, state: EgressState): void {
    const m = this.#measures.get(sessionId);
    if (!m) return;
    if (state.epoch > m.epoch) {
      m.closedIn += m.epochIn;
      m.closedOut += m.epochOut;
      m.epoch = state.epoch;
      m.epochIn = state.bytesIn;
      m.epochOut = state.bytesOut;
    } else if (state.epoch === m.epoch) {
      m.epochIn = Math.max(m.epochIn, state.bytesIn);
      m.epochOut = Math.max(m.epochOut, state.bytesOut);
    }
    // Relevé tardif d'une époque déjà close : son dernier relevé a été pris avant la remise à zéro (meterEgress).
  }

  /** Mesures en cours (instantanés poussés à la base, base de la reconstruction d'un nœud perdu). */
  live(): UsageClosure[] {
    return [...this.#measures.keys()].map((sessionId) => this.#closure(sessionId)).filter((c): c is UsageClosure => c !== undefined);
  }

  /** Destruction terminée : mesure arrêtée et rendue ; `undefined` si la session n'était pas mesurée (ou déjà close). */
  stop(sessionId: string): UsageClosure | undefined {
    const closure = this.#closure(sessionId);
    this.#measures.delete(sessionId);
    return closure;
  }

  #closure(sessionId: string): UsageClosure | undefined {
    const m = this.#measures.get(sessionId);
    if (!m) return undefined;
    return {
      sessionId,
      nodeId: this.#nodeId,
      startedAt: Math.round(m.startedAt),
      browserMs: Math.max(0, Math.round(this.#monotonic() - m.startMono)),
      bytesIn: m.closedIn + m.epochIn,
      bytesOut: m.closedOut + m.epochOut,
    };
  }
}

/**
 * Egress de session dont chaque fin d'époque est relevée : `replace` rend les compteurs de l'époque qui se ferme AVANT leur
 * remise à zéro, `close` rend les compteurs finals. Les relevés périodiques passent par `SessionEgressDeps.onCounters`.
 */
export function meterEgress(egress: SessionEgress, onState: (state: EgressState) => void): SessionEgress {
  return {
    url: egress.url,
    port: egress.port,
    state: () => egress.state(),
    replace(policy) {
      onState(egress.state());
      return egress.replace(policy);
    },
    connections: () => egress.connections(),
    abortAll: () => egress.abortAll(),
    shut: () => egress.shut(),
    async close() {
      await egress.close();
      onState(egress.state());
    },
  };
}
