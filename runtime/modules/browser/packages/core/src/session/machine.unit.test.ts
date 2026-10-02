// SPDX-License-Identifier: AGPL-3.0-only
// Machine à états des sessions (cdc/sym-browser 04 § 5, tâche 1.2), logique pure et magasin en mémoire.
// state_machine_model (A5) : des transitions tirées au hasard (fast-check) ne produisent jamais de transition hors de la
// table de 04 § 5 ; un état terminal est absorbant ; chaque transition acceptée laisse un seul événement `state`.
import { END_REASONS, SESSION_STATES, type EndReason, type SessionState } from '@sym/contracts/browser';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  checkTransition,
  createMemorySessionStore,
  endStateFor,
  extendedExpiry,
  isTerminal,
  SESSION_TRANSITIONS,
  sourcesFor,
} from './index.js';

/** Table de 04 § 5, recopiée à la main (plus 04b § 6 : une session `pending` d'un nœud perdu passe `failed`). */
const SPEC: [SessionState, SessionState, EndReason | null][] = [
  ['pending', 'running', null],
  ['pending', 'failed', 'crash'],
  ['pending', 'failed', 'quota'],
  ['pending', 'failed', 'node_lost'],
  ['running', 'ended', 'released'],
  ['running', 'ended', 'budget_exceeded'],
  ['running', 'ended', 'node_shutdown'],
  ['running', 'ended', 'quota'],
  ['running', 'timed_out', 'timeout'],
  ['running', 'timed_out', 'idle'],
  ['running', 'failed', 'crash'],
  ['running', 'failed', 'node_lost'],
];
const key = (from: string, to: string, reason: string | null): string => `${from}→${to}:${reason ?? '-'}`;
const ALLOWED = new Set(SPEC.map(([f, t, r]) => key(f, t, r)));

const stateArb = fc.constantFrom(...SESSION_STATES);
const reasonArb = fc.option(fc.constantFrom(...END_REASONS), { nil: null });
const attemptArb = fc.record({ to: stateArb, reason: reasonArb });

describe('table de transitions (04 § 5)', () => {
  test('exactement la table de la spec', () => {
    expect(SESSION_TRANSITIONS.map((t) => key(t.from, t.to, t.reason)).sort()).toEqual([...ALLOWED].sort());
  });

  test('checkTransition accepte la table, refuse tout le reste (produit cartésien complet)', () => {
    for (const from of SESSION_STATES) {
      for (const to of SESSION_STATES) {
        for (const reason of [null, ...END_REASONS]) {
          const result = checkTransition(from, to, reason);
          expect(result.ok, key(from, to, reason)).toBe(ALLOWED.has(key(from, to, reason)));
        }
      }
    }
  });

  test('états terminaux : ended, timed_out, failed ; aucune sortie', () => {
    expect(SESSION_STATES.filter(isTerminal)).toEqual(['ended', 'timed_out', 'failed']);
    for (const t of SESSION_TRANSITIONS) expect(isTerminal(t.from)).toBe(false);
  });

  test('raison de fin → état final depuis running ; sources possibles d’une transition', () => {
    expect(endStateFor('running', 'released')).toBe('ended');
    expect(endStateFor('running', 'quota')).toBe('ended');
    expect(endStateFor('pending', 'quota')).toBe('failed');
    expect(endStateFor('running', 'idle')).toBe('timed_out');
    expect(endStateFor('running', 'node_lost')).toBe('failed');
    expect(endStateFor('pending', 'released')).toBeUndefined();
    expect(sourcesFor('failed', 'crash')).toEqual(['pending', 'running']);
    expect(sourcesFor('running', null)).toEqual(['pending']);
    expect(sourcesFor('ended', 'idle')).toEqual([]);
  });
});

describe('state_machine_model (A5, fast-check)', () => {
  test('séquences aléatoires sur le magasin en mémoire : aucune transition hors de la table, terminal absorbant', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(attemptArb, { maxLength: 30 }), async (attempts) => {
        const store = createMemorySessionStore();
        store.create({ sessionId: 's1', createdAt: 0, expiresAt: 300_000 });
        let model: SessionState = 'pending';
        for (const { to, reason } of attempts) {
          const outcome = await store.transition({ sessionId: 's1', to, reason, nodeId: 'n1' });
          const legal = ALLOWED.has(key(model, to, reason));
          expect(outcome.ok).toBe(legal);
          if (outcome.ok) {
            expect(outcome.previous).toBe(model);
            model = to;
          } else {
            expect(outcome).toEqual({ ok: false, code: 'invalid_transition', current: model });
          }
        }
        const session = store.get('s1');
        expect(session?.state).toBe(model);
        // Chaque événement `state` correspond à une transition de la table, dans l'ordre.
        let previous: SessionState = 'pending';
        for (const event of store.events('s1')) {
          expect(ALLOWED.has(key(previous, event.state, event.endReason ?? null))).toBe(true);
          previous = event.state;
        }
        expect(previous).toBe(model);
        // État terminal : raison et date de fin présentes ; sinon absentes (mêmes règles que les CHECK de la base).
        expect(session?.endReason !== undefined).toBe(isTerminal(model));
        expect(session?.endedAt !== undefined).toBe(isTerminal(model));
        expect(session?.startedAt !== undefined).toBe(model === 'running' || (isTerminal(model) && store.events('s1').some((e) => e.state === 'running')));
      }),
      { numRuns: 500 },
    );
  });

  test('session inconnue : not_found', async () => {
    const store = createMemorySessionStore();
    expect(await store.transition({ sessionId: 'x', to: 'running', reason: null })).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('prolongation (04 § 3, POST /extend)', () => {
  test('ajoute du temps, plafonnée par la durée max du client', () => {
    expect(extendedExpiry({ createdAt: 0, expiresAt: 300_000, seconds: 120, maxDurationSeconds: 3600 })).toBe(420_000);
    expect(extendedExpiry({ createdAt: 0, expiresAt: 3_500_000, seconds: 600, maxDurationSeconds: 3600 })).toBe(3_600_000);
  });

  test('property : jamais au-delà du plafond, jamais en arrière', () => {
    fc.assert(
      fc.property(fc.nat(10_000), fc.integer({ min: 1, max: 86_400 }), fc.integer({ min: 1, max: 86_400 }), (expiresS, seconds, maxS) => {
        const expiresAt = Math.min(expiresS, maxS) * 1000;
        const next = extendedExpiry({ createdAt: 0, expiresAt, seconds, maxDurationSeconds: maxS });
        expect(next).toBeLessThanOrEqual(maxS * 1000);
        expect(next).toBeGreaterThanOrEqual(expiresAt);
      }),
    );
  });

  test('secondes non entières ou ≤ 0 refusées', () => {
    for (const seconds of [0, -1, 1.5, Number.NaN]) expect(() => extendedExpiry({ createdAt: 0, expiresAt: 1, seconds, maxDurationSeconds: 10 })).toThrow(/seconds/);
  });

  test('magasin en mémoire : prolongation d’une session terminée refusée', async () => {
    const store = createMemorySessionStore();
    store.create({ sessionId: 's1', createdAt: 0, expiresAt: 300_000 });
    expect(await store.extend({ sessionId: 's1', seconds: 60 })).toEqual({ ok: true, expiresAt: 360_000 });
    await store.transition({ sessionId: 's1', to: 'running', reason: null });
    await store.transition({ sessionId: 's1', to: 'ended', reason: 'released' });
    expect(await store.extend({ sessionId: 's1', seconds: 60 })).toEqual({ ok: false, code: 'invalid_state', current: 'ended' });
  });
});
