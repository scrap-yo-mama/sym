// SPDX-License-Identifier: AGPL-3.0-only
// B2 (F3) : signal → rafraîchissement, onChanged avec anti-rebond, domaine non connecté, concurrence, retentatives bornées,
// canari (aucune valeur de cookie dans les journaux). assert_extension_refresh_idempotent (avec controller.unit.test.ts).
import { describe, expect, test } from 'vitest';
import { DEBOUNCE_MS, RETRY_DELAYS_MS, SessionRefresher, type RefreshDeps } from './session-refresh.ts';

const SHOP = 'zz-test-shop.example';
const OTHER = 'zz-test-other.example';
const CANARY = 'zz_test_canary_cookie_value_b2';

function setup(over: Partial<RefreshDeps> = {}) {
  const pushes: string[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const deps: RefreshDeps = {
    refreshRequests: async () => [],
    refreshableDomains: async () => [SHOP],
    push: async (d) => {
      pushes.push(d);
      return true;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    log: (m) => logs.push(m),
    ...over,
  };
  const fire = () => timers.filter((t) => !t.cleared).forEach((t) => ((t.cleared = true), t.fn()));
  return { refresher: new SessionRefresher(deps), pushes, logs, sleeps, timers, fire };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('signal de l’instance', () => {
  test('réveil : refresh-requests puis poussée des domaines demandés, connectés et autorisés', async () => {
    const s = setup({ refreshRequests: async () => [SHOP, OTHER] });
    expect(await s.refresher.pollRequests()).toBe(1);
    expect(s.pushes).toEqual([SHOP]); // OTHER : non connecté ou sans permission d'hôte → rien
  });

  test('instance injoignable : rien n’est poussé, pas d’exception', async () => {
    const s = setup({ refreshRequests: async () => Promise.reject(new TypeError('Failed to fetch')) });
    expect(await s.refresher.pollRequests()).toBe(0);
    expect(s.pushes).toEqual([]);
  });
});

describe('cookies.onChanged', () => {
  test('une rafale sur un domaine connecté : une seule poussée après l’anti-rebond', async () => {
    const s = setup();
    for (let i = 0; i < 5; i += 1) await s.refresher.onCookieChanged({ removed: false, cookie: { domain: `.${SHOP}` }, cause: 'explicit' });
    expect(s.pushes).toEqual([]);
    expect(s.timers.filter((t) => !t.cleared)).toHaveLength(1);
    expect(s.timers[0]!.ms).toBe(DEBOUNCE_MS);
    s.fire();
    await flush();
    expect(s.pushes).toEqual([SHOP]);
  });

  test('suppression pure ignorée', async () => {
    const s = setup();
    await s.refresher.onCookieChanged({ removed: true, cookie: { domain: SHOP }, cause: 'explicit' });
    expect(s.timers).toEqual([]);
  });

  test('domaine non connecté : aucun minuteur, aucune poussée', async () => {
    const s = setup();
    await s.refresher.onCookieChanged({ removed: false, cookie: { domain: OTHER } });
    s.fire();
    await flush();
    expect(s.timers).toEqual([]);
    expect(s.pushes).toEqual([]);
  });
});

describe('concurrence et retentatives', () => {
  test('deux demandes simultanées pour un même domaine : sérialisées, jamais deux poussées en vol', async () => {
    let active = 0;
    let max = 0;
    const s = setup({
      push: async () => {
        active += 1;
        max = Math.max(max, active);
        await flush();
        active -= 1;
        return true;
      },
    });
    await Promise.all([s.refresher.refresh(SHOP), s.refresher.refresh(SHOP), s.refresher.refresh(SHOP)]);
    expect(max).toBe(1);
  });

  test('échec réseau : retentatives bornées avec backoff, puis abandon sans boucle', async () => {
    let calls = 0;
    const s = setup({
      push: async () => {
        calls += 1;
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await s.refresher.refresh(SHOP)).toBe(false);
    expect(calls).toBe(RETRY_DELAYS_MS.length + 1);
    expect(s.sleeps).toEqual([...RETRY_DELAYS_MS]);
  });

  test('échec puis succès : une poussée réussie ; refus définitif (consentement) : pas de retentative', async () => {
    let n = 0;
    const flaky = setup({
      push: async () => {
        n += 1;
        if (n === 1) throw Object.assign(new Error('x'), { code: 'instance_error' });
        return true;
      },
    });
    expect(await flaky.refresher.refresh(SHOP)).toBe(true);
    expect(n).toBe(2);
    let m = 0;
    const refused = setup({
      push: async () => {
        m += 1;
        throw Object.assign(new Error('x'), { code: 'consent_required' });
      },
    });
    expect(await refused.refresher.refresh(SHOP)).toBe(false);
    expect(m).toBe(1);
  });

  test('canari : aucun journal ne contient une valeur de cookie', async () => {
    const s = setup({
      refreshRequests: async () => [SHOP],
      push: async () => {
        throw new TypeError(`Failed to fetch ${CANARY}`.replace(CANARY, 'x'));
      },
    });
    await s.refresher.pollRequests();
    await s.refresher.onCookieChanged({ removed: false, cookie: { domain: SHOP } });
    expect(s.logs.length).toBeGreaterThan(0);
    expect(s.logs.join('\n')).not.toContain(CANARY);
  });
});
