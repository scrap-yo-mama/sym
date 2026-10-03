// SPDX-License-Identifier: AGPL-3.0-only
// Réconciliation périodique (04d § 4.4, tâche 2.6) : cadence, écart signalé, pas d'exécutions empilées, arrêt.
import { createManualClock } from '@sym-browser/core';
import type { UsageReconciliation } from '@sym-browser/db';
import { expect, test } from 'vitest';
import { hasDrift, startUsageReconciler } from './reconciler.js';

const report = (driftSeconds: number): UsageReconciliation => ({
  ranAt: new Date(0),
  closures: 1,
  inserted: 0,
  replaced: driftSeconds > 0 ? 1 : 0,
  reconstructed: 0,
  driftSeconds,
  driftBytes: 0,
  remainingDriftSeconds: 0,
  remainingDriftBytes: 0,
});
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('toutes les heures ; écart non nul signalé ; exécution lente non doublée ; arrêt définitif', async () => {
  const clock = createManualClock(0);
  const drifts = [3, 0];
  let calls = 0;
  let release: (() => void) | undefined;
  const reports: number[] = [];
  const warned: number[] = [];
  const reconciler = startUsageReconciler({
    clock,
    run: async () => {
      calls += 1;
      if (calls === 3) await new Promise<void>((resolve) => (release = resolve));
      return report(drifts.shift() ?? 0);
    },
    onReport: (r) => reports.push(r.driftSeconds),
    onDrift: (r) => warned.push(r.driftSeconds),
  });
  clock.advance(3_599_999);
  expect(calls).toBe(0);
  clock.advance(1);
  await flush();
  clock.advance(3_600_000);
  await flush();
  expect(reports).toEqual([3, 0]);
  expect(warned).toEqual([3]);
  clock.advance(3_600_000); // 3e exécution, bloquée
  clock.advance(3_600_000); // ne s'empile pas
  expect(calls).toBe(3);
  release?.();
  await flush();
  reconciler.stop();
  clock.advance(10 * 3_600_000);
  expect(calls).toBe(3);
  expect(hasDrift({ ...report(0), remainingDriftBytes: 1 })).toBe(true);
});
