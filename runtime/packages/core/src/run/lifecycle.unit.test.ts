// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import { RUN_STATES } from '../model/enums.js';
import {
  ACTIVE_RUN_STATES,
  canTransitionRun,
  isSkippedRunState,
  isTerminalRunState,
  maxRunRequeues,
  SKIPPED_RUN_STATES,
  TERMINAL_RUN_STATES,
} from './lifecycle.js';

test('états actifs et terminaux partitionnent RUN_STATES', () => {
  expect([...ACTIVE_RUN_STATES, ...TERMINAL_RUN_STATES].sort()).toEqual([...RUN_STATES].sort());
  for (const s of TERMINAL_RUN_STATES) {
    expect(isTerminalRunState(s)).toBe(true);
    for (const to of RUN_STATES) expect(canTransitionRun(s, to)).toBe(false);
  }
  for (const s of SKIPPED_RUN_STATES) expect(isSkippedRunState(s)).toBe(true);
  expect(isSkippedRunState('failed')).toBe(false);
});

test('transitions : prise, remise en file, annulation ; jamais de retour d’un état terminal', () => {
  expect(canTransitionRun('queued', 'running')).toBe(true);
  expect(canTransitionRun('running', 'queued')).toBe(true);
  expect(canTransitionRun('waiting_tunnel', 'queued')).toBe(true);
  expect(canTransitionRun('queued', 'cancelled')).toBe(true);
  expect(canTransitionRun('queued', 'succeeded')).toBe(false);
  expect(canTransitionRun('succeeded', 'running')).toBe(false);
});

test('reprise après perte du worker : 1 en lecture, 0 pour une API qui écrit (T2 R4)', () => {
  expect(maxRunRequeues({ allow_write_actions: false })).toBe(1);
  expect(maxRunRequeues({ allow_write_actions: true })).toBe(0);
});
