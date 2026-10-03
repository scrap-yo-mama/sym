// SPDX-License-Identifier: AGPL-3.0-only
// Métriques du nœud (cdc/sym-browser 04d § 3.1, tâche 3.7), branchées sur ses composants sans les modifier :
// - pool (tâche 1.1) : slots totaux et libres, sessions `running` par type, RSS de l'arbre de processus de chaque
//   Chromium sommé par type, lus à chaque collecte ; recyclages par raison depuis ses événements ;
// - superviseur (tâche 1.2) : temps de démarrage et durée des sessions (`onLifecycle`) ;
// - egress (tâche 1.5) : octets par écarts de compteurs de chaque session (`onCounters`, époques comprises), refus par
//   motif (`egress.blocked`, répétitions agrégées dans `count`) ;
// - enregistrements (tâche 3.3) : `recordingProduced(type)`.
// Étiquettes bornées : le nœud (`NODE_ID`), jamais un identifiant de session ni de client.
import { readFileSync } from 'node:fs';
import type { BrowserMetrics, MetricsRegistry } from '@sym-browser/core';
import type { EgressState, RecordingType } from '@sym/contracts/browser';
import type { EgressEvent } from '../egress/events.js';
import type { BrowserPool, PoolEvent } from '../pool/pool.js';
import { readProcessTable } from '../pool/process-group.js';
import type { SessionLifecycleEvent } from '../sessions/supervisor.js';

/** Taille de page du noyau (Linux x86_64 et arm64 courants) ; `/proc/{pid}/statm` compte en pages. */
const PAGE_SIZE = 4096;

export type ProcessTreeRssOptions = {
  table?: () => readonly { pid: number; pgid: number; state: string }[];
  statm?: (pid: number) => string | undefined;
  pageSize?: number;
};

/** RSS (octets) du groupe de processus d'un Chromium : somme des pages résidentes de ses membres vivants. */
export function processTreeRss(pgid: number, options: ProcessTreeRssOptions = {}): number {
  const table = (options.table ?? readProcessTable)();
  const statm =
    options.statm ??
    ((pid: number) => {
      try {
        return readFileSync(`/proc/${pid}/statm`, 'utf8');
      } catch {
        return undefined;
      }
    });
  const pageSize = options.pageSize ?? PAGE_SIZE;
  let pages = 0;
  for (const p of table) {
    if (p.pgid !== pgid || p.state === 'Z') continue;
    const resident = Number(statm(p.pid)?.trim().split(/\s+/)[1]);
    if (Number.isFinite(resident)) pages += resident;
  }
  return pages * pageSize;
}

export type NodeMetricsOptions = {
  registry: MetricsRegistry;
  metrics: BrowserMetrics;
  nodeId: string;
  pool: Pick<BrowserPool, 'stats' | 'processes'>;
  /** RSS d'un Chromium par son pid (groupe de processus) ; défaut `processTreeRss`. */
  rssOf?: (pid: number) => number;
  /** Faux en mode `all` : la passerelle publie déjà `symb_sessions` depuis la base. */
  reportSessions?: boolean;
};

export type EgressMeter = { onEvent: (event: EgressEvent) => void; onCounters: (state: EgressState) => void };

export function bindNodeMetrics(options: NodeMetricsOptions) {
  const { metrics, nodeId, pool } = options;
  const rssOf = options.rssOf ?? ((pid: number) => processTreeRss(pid));
  const node = { node: nodeId };

  options.registry.onCollect(() => {
    const stats = pool.stats();
    metrics.slotsTotal.set(node, stats.slotsTotal);
    metrics.slotsFree.set(node, stats.slotsFree);
    if (options.reportSessions !== false) {
      for (const type of ['shared', 'dedicated'] as const) metrics.sessions.set({ state: 'running', type }, stats.sessions[type]);
    }
    const rss = { shared: 0, dedicated: 0 };
    for (const p of pool.processes()) rss[p.kind] += rssOf(p.pid);
    for (const kind of ['shared', 'dedicated'] as const) metrics.browserRssBytes.set({ ...node, kind }, rss[kind]);
  });

  return {
    onPoolEvent(event: PoolEvent): void {
      if (event.kind === 'recycle') metrics.recycles.inc({ reason: event.reason });
    },

    onSessionEvent(event: SessionLifecycleEvent): void {
      if (event.kind === 'started') metrics.sessionStartSeconds.observe({ type: event.type }, event.startMs / 1000);
      else metrics.sessionDurationSeconds.observe({ type: event.type, reason: event.reason }, event.durationMs / 1000);
    },

    /** Compteur d'une session : à brancher sur `onEvent` et `onCounters` de son egress. */
    egressMeter(): EgressMeter {
      let last = { epoch: -1, bytesIn: 0, bytesOut: 0 };
      return {
        onEvent(event) {
          if (event.type === 'egress.blocked') metrics.egressBlocked.inc({ reason: event.data.reason }, event.data.count ?? 1);
        },
        onCounters(state) {
          // Nouvelle époque (remplacement de la politique) : les compteurs de l'egress repartent de zéro.
          const base = state.epoch === last.epoch ? last : { bytesIn: 0, bytesOut: 0 };
          metrics.egressBytes.inc({ direction: 'in' }, Math.max(0, state.bytesIn - base.bytesIn));
          metrics.egressBytes.inc({ direction: 'out' }, Math.max(0, state.bytesOut - base.bytesOut));
          last = { epoch: state.epoch, bytesIn: state.bytesIn, bytesOut: state.bytesOut };
        },
      };
    },

    recordingProduced(type: RecordingType): void {
      metrics.recordings.inc({ type });
    },
  };
}
