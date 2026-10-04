// SPDX-License-Identifier: AGPL-3.0-only
// U3.4 : tunnel stable. Message `resume{run_id, last_command_seq}` (extension → passerelle, après une reconnexion), délais de
// reconnexion croissants plafonnés à 30 s dont le premier tient la cible « reconnecté en moins de 10 s » (05 § 5, 7.1).
import { describe, expect, test } from 'vitest';
import { parseExtensionFrame, TUNNEL_PING_MS, TUNNEL_RECONNECT_BACKOFF_MS, TUNNEL_RECONNECT_TARGET_MS, TUNNEL_RESUME_MAX_RUNS, reconnectDelayMs } from './index.js';

const RUN = '0e1d2c3b-4a59-4687-9123-abcdefabcdef';

describe('resume', () => {
  test('forme stricte : run_id (uuid) et last_command_seq (entier ≥ 0), aucun autre champ', () => {
    expect(parseExtensionFrame(JSON.stringify({ type: 'resume', run_id: RUN, last_command_seq: 7 }))).toEqual({ type: 'resume', run_id: RUN, last_command_seq: 7 });
    expect(parseExtensionFrame(JSON.stringify({ type: 'resume', run_id: RUN, last_command_seq: 0 }))).toMatchObject({ last_command_seq: 0 });
    for (const bad of [
      { type: 'resume', run_id: 'pas-un-uuid', last_command_seq: 1 },
      { type: 'resume', run_id: RUN, last_command_seq: -1 },
      { type: 'resume', run_id: RUN, last_command_seq: 1.5 },
      { type: 'resume', run_id: RUN, last_command_seq: 10_000_000 },
      { type: 'resume', run_id: RUN },
      { type: 'resume', last_command_seq: 1 },
      { type: 'resume', run_id: RUN, last_command_seq: 1, extra: true },
    ]) {
      expect(parseExtensionFrame(JSON.stringify(bad))).toBeNull();
    }
  });
});

describe('reconnexion', () => {
  test('délais croissants 1, 2, 4, 8, 16 s puis plafond de 30 s', () => {
    expect(TUNNEL_RECONNECT_BACKOFF_MS).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000]);
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  });
  test('le premier délai tient la cible de 10 s, avec de la marge pour la poignée de main', () => {
    expect(TUNNEL_RECONNECT_TARGET_MS).toBe(10_000);
    expect(reconnectDelayMs(0)).toBeLessThanOrEqual(TUNNEL_RECONNECT_TARGET_MS / 2);
  });
  test('battement de 20 s et bornes de la reprise', () => {
    expect(TUNNEL_PING_MS).toBe(20_000);
    expect(TUNNEL_RESUME_MAX_RUNS).toBeGreaterThan(0);
  });
});
