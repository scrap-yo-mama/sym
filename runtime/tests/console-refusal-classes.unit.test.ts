// SPDX-License-Identifier: AGPL-3.0-only
// assert_trial_plan_pruned_on_refusal (3.17, X3, X4) : la console retire du plan d'essais les couples proxy ou tunnel dès qu'un
// essai rend une classe de refus, sans attendre le statut `bloquee`. Elle ne dépend pas de `@runtime/core` (son build reste
// indépendant du serveur) : sa liste de classes de refus est une copie de lecture, comparée ici aux classes bloquantes du cœur.
import { describe, expect, test } from 'vitest';
import { REFUSAL_RESULTS } from '../apps/web/src/lib/refusal.ts';
import { BLOCKING_CLASSES } from '../packages/core/src/status/types.ts';

describe('assert_trial_plan_pruned_on_refusal : classes de refus de la console', () => {
  test('chaque classe bloquante du cœur (403, défi, robots.txt) est un refus pour la console, plus le défi en tunnel', () => {
    for (const cls of BLOCKING_CLASSES) expect(REFUSAL_RESULTS, cls).toContain(cls);
    expect(REFUSAL_RESULTS).toContain('challenge_in_tunnel');
  });
});
