// SPDX-License-Identifier: AGPL-3.0-only
// Délais d'une session (04 § 3 et § 5, tâche 1.2) : délai total (`expiresAt`, raison `timeout`) et délai d'inactivité
// (`idleTimeoutSeconds` sans message du client, raison `idle`), prolongation. Horloge manuelle pour la logique, horloge
// réelle pour idle_timeout_precision (A4 : ± 1 s).
import { describe, expect, test } from 'vitest';
import { createManualClock, SessionTimers, systemClock, type ExpiryReason } from './index.js';

function arm(options: { idleMs: number; expiresInMs: number }) {
  const clock = createManualClock(1_000_000);
  const fired: { reason: ExpiryReason; at: number }[] = [];
  const timers = new SessionTimers({
    clock,
    expiresAt: clock.now() + options.expiresInMs,
    idleTimeoutMs: options.idleMs,
    onExpire: (reason) => fired.push({ reason, at: clock.now() }),
  });
  return { clock, fired, timers, t0: clock.now() };
}

describe('SessionTimers (horloge manuelle)', () => {
  test('sans message : idle exactement à idleTimeoutMs', () => {
    const { clock, fired, t0 } = arm({ idleMs: 60_000, expiresInMs: 300_000 });
    clock.advance(59_999);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([{ reason: 'idle', at: t0 + 60_000 }]);
  });

  test('chaque message repousse le délai d’inactivité ; un seul déclenchement', () => {
    const { clock, fired, timers, t0 } = arm({ idleMs: 60_000, expiresInMs: 300_000 });
    clock.advance(50_000);
    timers.touch();
    clock.advance(50_000);
    timers.touch();
    clock.advance(59_999);
    expect(fired).toEqual([]);
    clock.advance(10_000);
    expect(fired).toEqual([{ reason: 'idle', at: t0 + 160_000 }]);
    clock.advance(1_000_000);
    expect(fired).toHaveLength(1);
  });

  test('délai total atteint avant l’inactivité : timeout', () => {
    const { clock, fired, timers, t0 } = arm({ idleMs: 60_000, expiresInMs: 100_000 });
    for (let i = 0; i < 20; i += 1) {
      clock.advance(10_000);
      timers.touch();
    }
    expect(fired).toEqual([{ reason: 'timeout', at: t0 + 100_000 }]);
  });

  test('prolongation : le délai total recule ; arrêt : plus rien ne se déclenche', () => {
    const { clock, fired, timers, t0 } = arm({ idleMs: 1_000_000, expiresInMs: 100_000 });
    clock.advance(90_000);
    timers.extendTo(t0 + 200_000);
    clock.advance(20_000);
    expect(fired).toEqual([]);
    clock.advance(90_000);
    expect(fired).toEqual([{ reason: 'timeout', at: t0 + 200_000 }]);

    const other = arm({ idleMs: 10_000, expiresInMs: 100_000 });
    other.timers.stop();
    other.clock.advance(1_000_000);
    expect(other.fired).toEqual([]);
  });

  test('délai déjà dépassé à l’armement : déclenché au prochain tour, pas en synchrone', () => {
    const clock = createManualClock(0);
    const fired: ExpiryReason[] = [];
    new SessionTimers({ clock, expiresAt: -1, idleTimeoutMs: 60_000, onExpire: (r) => fired.push(r) });
    expect(fired).toEqual([]);
    clock.advance(0);
    expect(fired).toEqual(['timeout']);
  });
});

describe('idle_timeout_precision (A4)', () => {
  test('horloge réelle : idle 2 s après le dernier message, à ± 1 s', async () => {
    const started = performance.now();
    let lastMessage = started;
    const firedAt = await new Promise<{ reason: ExpiryReason; at: number }>((resolve) => {
      const timers = new SessionTimers({
        clock: systemClock,
        expiresAt: systemClock.now() + 60_000,
        idleTimeoutMs: 2_000,
        onExpire: (reason) => resolve({ reason, at: performance.now() }),
      });
      // Trois messages à 400 ms d'écart : le délai court depuis le dernier.
      for (const delay of [400, 800, 1200]) {
        setTimeout(() => {
          lastMessage = performance.now();
          timers.touch();
        }, delay);
      }
    });
    expect(firedAt.reason).toBe('idle');
    const elapsed = firedAt.at - lastMessage;
    expect(Math.abs(elapsed - 2_000)).toBeLessThanOrEqual(1_000);
  });
});
