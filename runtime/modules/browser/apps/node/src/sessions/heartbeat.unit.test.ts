// SPDX-License-Identifier: AGPL-3.0-only
// Battement du nœud (04b § 5 et § 6, tâche 1.2) : un battement toutes les 5 s (`HEARTBEAT_MS`) ; un nœud qui n'arrive plus
// à écrire son battement pendant 15 s s'isole (sessions locales détruites, BINV3) ; un nœud déclaré `down` qui bat à
// nouveau apprend qu'il a été perdu (`recovered`) et détruit ses sessions locales avant de reprendre.
import { createManualClock } from '@sym-browser/core';
import { describe, expect, test } from 'vitest';
import { HEARTBEAT_DEFAULTS, startHeartbeat } from './heartbeat.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(results: (() => Promise<{ recovered: boolean }>)[]) {
  const clock = createManualClock(0);
  const beats: number[] = [];
  const isolations: number[] = [];
  let i = 0;
  const loop = startHeartbeat({
    clock,
    beat: () => {
      beats.push(clock.now());
      const next = results[Math.min(i, results.length - 1)] ?? (async () => ({ recovered: false }));
      i += 1;
      return next();
    },
    isolate: async () => void isolations.push(clock.now()),
  });
  const advance = async (ms: number, step = 1_000) => {
    for (let t = 0; t < ms; t += step) {
      clock.advance(Math.min(step, ms - t));
      await flush();
    }
  };
  return { clock, beats, isolations, loop, advance };
}

const ok = async () => ({ recovered: false });
const fail = async (): Promise<{ recovered: boolean }> => {
  throw new Error('base injoignable');
};

describe('startHeartbeat', () => {
  test('valeurs de 04b : 5 s entre deux battements, isolement après 15 s sans battement écrit', () => {
    expect(HEARTBEAT_DEFAULTS).toEqual({ intervalMs: 5_000, lostAfterMs: 15_000 });
  });

  test('un battement au démarrage puis toutes les 5 s ; arrêt : plus aucun', async () => {
    const h = harness([ok]);
    await flush();
    await h.advance(20_000);
    expect(h.beats).toEqual([0, 5_000, 10_000, 15_000, 20_000]);
    h.loop.stop();
    await h.advance(20_000);
    expect(h.beats).toHaveLength(5);
    expect(h.isolations).toEqual([]);
  });

  test('battements en échec pendant plus de 15 s : isolement une seule fois, puis reprise normale', async () => {
    const h = harness([ok, fail, fail, fail, fail, fail, ok]);
    await flush();
    await h.advance(14_000);
    expect(h.isolations).toEqual([]);
    await h.advance(6_000);
    expect(h.isolations).toEqual([15_000]);
    await h.advance(20_000);
    expect(h.isolations).toEqual([15_000]);
    h.loop.stop();
  });

  test('nœud déclaré down qui bat à nouveau (`recovered`) : sessions locales détruites', async () => {
    const h = harness([ok, async () => ({ recovered: true }), ok]);
    await flush();
    await h.advance(5_000);
    expect(h.isolations).toEqual([5_000]);
    await h.advance(10_000);
    expect(h.isolations).toEqual([5_000]);
    h.loop.stop();
  });
});
