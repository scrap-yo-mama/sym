// SPDX-License-Identifier: AGPL-3.0-only
// Codes de raison de la reprise par étape (tâche 2.13, 19 §4, 19b §3) : aucune transition nouvelle, raisons portées par
// les transitions existantes (2, 12, 13, 14, 21). INV3 : le nombre de transitions ne change pas.
import { describe, expect, test } from 'vitest';
import { applyStatusEvent, initialStatusState, TRANSITIONS, TRANSITION_COUNT, transitionDef, type ApiStatusState, type Status, type StatusEventInput } from './index.js';

const ctx = { clock: { now: () => new Date('2026-10-02T10:00:00Z') } };
const st = (status: Status, patch: Partial<ApiStatusState> = {}): ApiStatusState => ({ ...initialStatusState(), status, ...patch });
const path = (state: ApiStatusState, event: StatusEventInput) => {
  const step = applyStatusEvent(state, event, ctx);
  if (!step.ok) throw new Error(step.rejected);
  return step.transitions.map((t) => [t.transition, t.to, t.reason] as const);
};

describe('raisons de la reprise par étape sur les transitions existantes', () => {
  test('repair_not_validated : 12 (données livrées, vN+1 archivée non courante)', () => {
    expect(path(st('reparation'), { type: 'repair_succeeded', validated: false })).toEqual([[12, 'warning', 'repair_not_validated']]);
    expect(path(st('reparation'), { type: 'repair_succeeded' })).toEqual([[12, 'warning', 'repaired']]);
  });
  test('step_cascade et not_compilable : 13, stratégie précédente gardée', () => {
    expect(path(st('reparation'), { type: 'repair_failed', cause: 'step_cascade' })).toEqual([[13, 'erreur', 'step_cascade']]);
    expect(path(st('reparation'), { type: 'repair_failed', cause: 'not_compilable' })).toEqual([[13, 'erreur', 'not_compilable']]);
  });
  test('write_step_broken et session_step_broken : 10 puis 14 depuis sain, 14 depuis reparation', () => {
    expect(path(st('sain'), { type: 'run_stopped', reason: 'write_step_broken' })).toEqual([
      [10, 'reparation', 'write_step_broken'],
      [14, 'action_requise', 'write_step_broken'],
    ]);
    expect(path(st('warning'), { type: 'run_stopped', reason: 'session_step_broken' })).toEqual([
      [11, 'reparation', 'session_step_broken'],
      [14, 'action_requise', 'session_step_broken'],
    ]);
    expect(path(st('reparation'), { type: 'run_stopped', reason: 'session_step_broken' })).toEqual([[14, 'action_requise', 'session_step_broken']]);
  });
  test('assert_investigation_not_compilable_reason : enquête → erreur (2), ré-enquête → statut précédent (21), raison not_compilable', () => {
    expect(path(st('enquete'), { type: 'investigation_failed', cause: 'not_compilable' })).toEqual([[2, 'erreur', 'not_compilable']]);
    expect(path(st('enquete', { previousStatus: 'warning' }), { type: 'investigation_failed', cause: 'not_compilable' })).toEqual([[21, 'warning', 'not_compilable']]);
  });
  test('aucune transition nouvelle ; chaque raison est déclarée par sa transition', () => {
    expect(TRANSITIONS).toHaveLength(TRANSITION_COUNT);
    expect(TRANSITION_COUNT).toBe(22);
    expect(transitionDef(2).reasons).toContain('not_compilable');
    expect(transitionDef(21).reasons).toContain('not_compilable');
    expect(transitionDef(12).reasons).toContain('repair_not_validated');
    expect(transitionDef(13).reasons).toEqual(expect.arrayContaining(['step_cascade', 'not_compilable']));
    expect(transitionDef(14).reasons).toEqual(expect.arrayContaining(['write_step_broken', 'session_step_broken']));
    expect(transitionDef(10).reasons).toEqual(expect.arrayContaining(['write_step_broken', 'session_step_broken']));
  });
});
