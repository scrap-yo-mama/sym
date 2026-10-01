// SPDX-License-Identifier: AGPL-3.0-only
// Une seule énumération `FailureClass` (04b § 1, 04 §7), source de vérité : model/enums.ts. La machine à états l'importe ;
// les codes de raison de transition qui ne sont pas des classes (04 §6 : proxy non configuré, tunnel hors ligne,
// défi en tunnel) vivent à part, dans `ACTION_REASONS`.
import { describe, expect, expectTypeOf, test } from 'vitest';
import type * as core from '../index.js';
import { FAILURE_CLASSES, isFailureClass, type FailureClass } from '../model/enums.js';
import {
  ACTION_REASONS,
  BACKOFF_CLASSES,
  BLOCKING_CLASSES,
  INVESTIGATION_ACTION_CLASSES,
  INVESTIGATION_ACTION_REASONS,
  REPAIR_ACTION_CLASSES,
  REPAIR_ACTION_REASONS,
  transitionDef,
  type ActionReason,
  type StatusEventInput,
} from './index.js';

describe('FailureClass unique', () => {
  test('la machine à états utilise l’énumération du modèle', () => {
    expectTypeOf<Extract<StatusEventInput, { type: 'run_failed' }>['failureClass']>().toEqualTypeOf<FailureClass>();
    expectTypeOf<Extract<StatusEventInput, { type: 'backoff_elapsed' }>['failureClass']>().toEqualTypeOf<FailureClass>();
    expectTypeOf<Extract<StatusEventInput, { type: 'run_stopped' }>['reason']>().toEqualTypeOf<ActionReason>();
  });

  test('la racine du paquet n’exporte plus d’énumération divergente', () => {
    // @ts-expect-error StatusFailureClass a disparu : une seule FailureClass, celle du modèle.
    type Divergent = core.StatusFailureClass;
    expectTypeOf<Divergent>().toBeAny();
  });

  test('les classes citées par la machine sont des failure_class du modèle', () => {
    for (const c of [...BLOCKING_CLASSES, ...INVESTIGATION_ACTION_CLASSES, ...REPAIR_ACTION_CLASSES, ...BACKOFF_CLASSES]) {
      expect(isFailureClass(c), c).toBe(true);
    }
  });

  test('liste fermée de 04b § 1 (hors llm_*)', () => {
    expect([...FAILURE_CLASSES].sort()).toEqual(
      [
        'transient', 'network', 'rate_limited', 'forbidden', 'blocked_by_protection', 'robots_disallowed', 'robots_unreachable',
        'payment_required', 'auth_required', 'account_limit', 'not_found', 'extraction', 'code_error', 'run_budget_exceeded',
        'budget_exceeded',
      ].sort(),
    );
  });

  test('les codes de raison (04 §6) ne sont pas des failure_class', () => {
    expect([...ACTION_REASONS].sort()).toEqual(['challenge_in_tunnel', 'proxy_not_configured', 'tunnel_offline']);
    for (const r of ACTION_REASONS) expect(isFailureClass(r), r).toBe(false);
  });

  test('raisons des transitions 3 et 14 = classes + codes de raison', () => {
    expect([...transitionDef(3).reasons].sort()).toEqual([...INVESTIGATION_ACTION_CLASSES, ...INVESTIGATION_ACTION_REASONS].sort());
    expect([...transitionDef(14).reasons].sort()).toEqual([...REPAIR_ACTION_CLASSES, ...REPAIR_ACTION_REASONS].sort());
  });
});
