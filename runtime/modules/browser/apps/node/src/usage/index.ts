// SPDX-License-Identifier: AGPL-3.0-only
// Comptage du nœud (cdc/sym-browser 04d § 4.1, tâche 2.6, BINV5) : compteur monotone, relevé des époques d'egress,
// journal `usage.wal`, instantanés périodiques. La clôture en base passe par le superviseur de sessions.
export { meterEgress, UsageMeter, type UsageMeterOptions } from './meter.js';
export { startUsageSnapshots, USAGE_SNAPSHOT_INTERVAL_MS, type UsageSnapshotsOptions } from './snapshots.js';
export { replayUsageWal, UsageWal, type ReplayReport } from './wal.js';
