// SPDX-License-Identifier: AGPL-3.0-only
// Pool de Chromium du nœud (tâche 1.1) : assemblage depuis la configuration validée (04b § 11). Le démarrage du pool par le
// nœud, le battement (`slotsTotal`, `slotsFree`, `rssBytes`, `limitBytes`) et la table `nodes` viennent avec les tâches 1.2
// et 0.2 : `nodePoolOptions` et `BrowserPool.stats` en sont les points d'accroche.
import type { BrowserConfig } from '@sym-browser/core';
import { memoryHighProbe, PROVISIONAL_CAPACITY, resolveCapacity, type CapacityConstants, type MemoryProbe, type ResolvedCapacity } from './capacity.js';
import type { BrowserLauncher, PoolEvent, PoolOptions } from './pool.js';

export * from './capacity.js';
export * from './closed-proxy.js';
export * from './launch.js';
export * from './pool.js';
export * from './process-group.js';

export type NodePoolDeps = {
  launch: BrowserLauncher;
  launchDedicated?: BrowserLauncher;
  sweep?: () => unknown;
  /** Constantes mesurées par la tâche 0.6 ; défaut : PROVISIONAL_CAPACITY. */
  constants?: CapacityConstants;
  probe?: MemoryProbe;
  onEvent?: (event: PoolEvent) => void;
};

/** Options du pool depuis `config.node` : `MAX_SESSIONS`, `WARM_BROWSERS`, `CONTEXTS_PER_BROWSER`, `RECYCLE_*`. */
export function nodePoolOptions(node: BrowserConfig['node'], deps: NodePoolDeps): { options: PoolOptions; capacity: ResolvedCapacity } {
  const constants = deps.constants ?? PROVISIONAL_CAPACITY;
  const capacity = resolveCapacity(node, { ...deps.probe, constants });
  const options: PoolOptions = {
    slotsTotal: capacity.slotsTotal,
    launch: deps.launch,
    warmBrowsers: node.warmBrowsers,
    constants,
    contextsPerBrowser: node.contextsPerBrowser,
    recycleAfterSessions: node.recycleAfterSessions,
    recycleAfterMs: node.recycleAfterMs,
    memoryHigh: memoryHighProbe(node.recycleRssPercent, deps.probe),
  };
  if (deps.launchDedicated !== undefined) options.launchDedicated = deps.launchDedicated;
  if (deps.sweep !== undefined) options.sweep = deps.sweep;
  if (deps.onEvent !== undefined) options.onEvent = deps.onEvent;
  return { options, capacity };
}
