// SPDX-License-Identifier: AGPL-3.0-only
// Les 16 métriques de SYM Browser (cdc/sym-browser 04d § 3.1, tâche 3.7) : nom, type, étiquettes et valeurs permises,
// source (nœud, passerelle). Chaque rôle déclare les siennes ; le mode `all` les déclare toutes. Les poignées d'une
// métrique d'un autre rôle restent utilisables (aucun effet sur l'exposition).
import { END_REASONS, EGRESS_BLOCK_REASONS, RECORDING_TYPES, SESSION_STATES, SESSION_TYPES } from '@sym/contracts/browser';
import { MetricsRegistry, registerProcessMetrics, type Counter, type Gauge, type Histogram, type LabelSpec } from './registry.js';

export type MetricSource = 'node' | 'gateway';

/** Raisons de recyclage de 04b § 4 (identiques à `RECYCLE_REASONS` du pool, vérifié par le test du nœud). */
export const METRIC_RECYCLE_REASONS = ['runs', 'age', 'memory', 'disconnected', 'close_timeout', 'shutdown', 'dedicated'] as const;

/** Résultat d'une création (`symb_sessions_created_total`) : démarrée (201), acceptée en arrière-plan (202), ou refus typé. */
export const CREATE_RESULTS = ['started', 'accepted', 'quota_exceeded', 'capacity_exceeded', 'no_node', 'launch_failed', 'session_id_taken'] as const;
export type CreateResult = (typeof CREATE_RESULTS)[number];

export const WS_PROTOCOLS = ['playwright', 'cdp', 'live'] as const;

const SECONDS_START = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
const SECONDS_QUEUE = [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60];
const SECONDS_DURATION = [1, 10, 30, 60, 300, 900, 1800, 3600, 7200];

type Definition = {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  help: string;
  labels: LabelSpec;
  sources: readonly MetricSource[];
  buckets?: readonly number[];
};

const def = (name: string, type: Definition['type'], labels: LabelSpec, sources: readonly MetricSource[], help: string, buckets?: readonly number[]): Definition => ({
  name,
  type,
  help,
  labels,
  sources,
  ...(buckets === undefined ? {} : { buckets }),
});

export const METRIC_DEFINITIONS: readonly Definition[] = Object.freeze([
  def('symb_sessions', 'gauge', { state: SESSION_STATES, type: SESSION_TYPES }, ['node', 'gateway'], 'Sessions by state and type (node: its running sessions; gateway: all sessions in the database).'),
  def('symb_sessions_created_total', 'counter', { type: SESSION_TYPES, result: CREATE_RESULTS }, ['gateway'], 'Session creation requests by type and result.'),
  def('symb_slots_total', 'gauge', { node: 'node' }, ['node'], 'Browser slots of the node.'),
  def('symb_slots_free', 'gauge', { node: 'node' }, ['node'], 'Free browser slots of the node.'),
  def('symb_queue_length', 'gauge', {}, ['gateway'], 'Sessions waiting in the queue.'),
  def('symb_queue_wait_seconds', 'histogram', {}, ['gateway'], 'Time spent in the queue before a node was assigned.', SECONDS_QUEUE),
  def('symb_session_start_seconds', 'histogram', { type: SESSION_TYPES }, ['node'], 'Time from start request to running session.', SECONDS_START),
  def('symb_session_duration_seconds', 'histogram', { type: SESSION_TYPES, reason: END_REASONS }, ['node'], 'Browser time of finished sessions by end reason.', SECONDS_DURATION),
  def('symb_browser_rss_bytes', 'gauge', { node: 'node', kind: SESSION_TYPES }, ['node'], 'Resident memory of the Chromium process trees by browser kind.'),
  def('symb_recycles_total', 'counter', { reason: METRIC_RECYCLE_REASONS }, ['node'], 'Chromium recycles by reason.'),
  def('symb_egress_bytes_total', 'counter', { direction: ['in', 'out'] }, ['node'], 'Bytes through the session egress proxies.'),
  def('symb_egress_blocked_total', 'counter', { reason: EGRESS_BLOCK_REASONS }, ['node'], 'Connections refused by the session egress proxies.'),
  def('symb_ws_connections', 'gauge', { protocol: WS_PROTOCOLS }, ['gateway'], 'Open relayed WebSocket connections by protocol.'),
  def('symb_recordings_total', 'counter', { type: RECORDING_TYPES }, ['node'], 'Recordings produced by type.'),
  def('symb_usage_drift_seconds', 'gauge', {}, ['gateway'], 'Billed seconds minus node-measured seconds at the last reconciliation.'),
  def('symb_node_up', 'gauge', { node: 'node' }, ['gateway'], 'Node heartbeat seen in the last 15 seconds (1) or not (0).'),
]);

type SessionLabels = 'state' | 'type';

export type BrowserMetrics = {
  sessions: Gauge<SessionLabels>;
  sessionsCreated: Counter<'type' | 'result'>;
  slotsTotal: Gauge<'node'>;
  slotsFree: Gauge<'node'>;
  queueLength: Gauge;
  queueWaitSeconds: Histogram;
  sessionStartSeconds: Histogram<'type'>;
  sessionDurationSeconds: Histogram<'type' | 'reason'>;
  browserRssBytes: Gauge<'node' | 'kind'>;
  recycles: Counter<'reason'>;
  egressBytes: Counter<'direction'>;
  egressBlocked: Counter<'reason'>;
  wsConnections: Gauge<'protocol'>;
  recordings: Counter<'type'>;
  usageDriftSeconds: Gauge;
  nodeUp: Gauge<'node'>;
};

const HANDLES: Record<keyof BrowserMetrics, string> = {
  sessions: 'symb_sessions',
  sessionsCreated: 'symb_sessions_created_total',
  slotsTotal: 'symb_slots_total',
  slotsFree: 'symb_slots_free',
  queueLength: 'symb_queue_length',
  queueWaitSeconds: 'symb_queue_wait_seconds',
  sessionStartSeconds: 'symb_session_start_seconds',
  sessionDurationSeconds: 'symb_session_duration_seconds',
  browserRssBytes: 'symb_browser_rss_bytes',
  recycles: 'symb_recycles_total',
  egressBytes: 'symb_egress_bytes_total',
  egressBlocked: 'symb_egress_blocked_total',
  wsConnections: 'symb_ws_connections',
  recordings: 'symb_recordings_total',
  usageDriftSeconds: 'symb_usage_drift_seconds',
  nodeUp: 'symb_node_up',
};

/**
 * Déclare les métriques du rôle (et celles du processus) dans `registry`. Les autres sont créées hors registre : leurs
 * poignées fonctionnent mais ne sont pas exposées.
 */
export function createBrowserMetrics(registry: MetricsRegistry, role: MetricSource | 'all', _options: { nodeId?: string } = {}): BrowserMetrics {
  const detached = new MetricsRegistry();
  const handles: Record<string, unknown> = {};
  for (const [handle, name] of Object.entries(HANDLES)) {
    const d = METRIC_DEFINITIONS.find((m) => m.name === name)!;
    const target = role === 'all' || d.sources.includes(role) ? registry : detached;
    handles[handle] =
      d.type === 'counter' ? target.counter(d.name, d.help, d.labels) : d.type === 'gauge' ? target.gauge(d.name, d.help, d.labels) : target.histogram(d.name, d.help, d.labels, d.buckets!);
  }
  if (!registry.names().includes('process_resident_memory_bytes')) registerProcessMetrics(registry);
  return handles as BrowserMetrics;
}
