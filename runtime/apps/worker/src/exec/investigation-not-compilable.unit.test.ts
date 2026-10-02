// SPDX-License-Identifier: AGPL-3.0-only
// assert_investigation_not_compilable_reason (tâche 2.13, 04 §3.1, 19 §4) : une enquête dont seule une trace E6 non
// compilable en E5 est conforme, sans `instructed_mode`, finit par `investigation_failed` de cause `not_compilable` :
// `erreur` raison `not_compilable` (transition 2), ou le statut précédent (21) pour une ré-enquête. Les autres échecs
// gardent leur événement (refus, robots.txt injoignable, budget).
import { applyStatusEvent, initialStatusState } from '@runtime/core';
import { describe, expect, test } from 'vitest';
import { investigationFailureEvent } from './investigation-executor.js';

const ctx = { clock: { now: () => new Date('2026-10-02T10:00:00Z') } };

describe('assert_investigation_not_compilable_reason', () => {
  test('dernier essai not_compilable → investigation_failed (not_compilable) : erreur (2), ou statut précédent (21)', () => {
    const event = investigationFailureEvent({ failure_class: 'extraction', retryable: false, detail: 'not_compilable' });
    expect(event).toEqual({ type: 'investigation_failed', cause: 'not_compilable' });
    const first = applyStatusEvent({ ...initialStatusState(), status: 'enquete' }, event, ctx);
    expect(first.ok && first.transitions.map((t) => [t.transition, t.to, t.reason])).toEqual([[2, 'erreur', 'not_compilable']]);
    const again = applyStatusEvent({ ...initialStatusState(), status: 'enquete', previousStatus: 'sain' }, event, ctx);
    expect(again.ok && again.transitions.map((t) => [t.transition, t.to, t.reason])).toEqual([[21, 'sain', 'not_compilable']]);
  });
  test('les autres fins gardent leur événement', () => {
    expect(investigationFailureEvent({ failure_class: 'extraction', retryable: false, detail: 'no_conformant_strategy' })).toEqual({ type: 'investigation_failed', cause: 'budget_exhausted' });
    expect(investigationFailureEvent({ failure_class: 'robots_unreachable', retryable: true, detail: 'x' })).toEqual({ type: 'investigation_failed', cause: 'robots_unreachable' });
    expect(investigationFailureEvent({ failure_class: 'forbidden', retryable: false, detail: 'x', status: 403 })).toEqual({ type: 'run_failed', failureClass: 'forbidden', httpStatus: 403 });
    expect(investigationFailureEvent({ failure_class: 'auth_required', retryable: false, detail: 'x' })).toEqual({ type: 'run_failed', failureClass: 'auth_required' });
  });
});
