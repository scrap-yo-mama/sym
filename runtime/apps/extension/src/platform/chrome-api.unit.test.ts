// SPDX-License-Identifier: AGPL-3.0-only
// `http_fetch` du service worker (tâche 2.7, correctif 16 de la vérification) : `redirect: 'manual'`, une redirection
// n'est jamais suivie (INV10 : contrôle AVANT connexion, pas après) et rendue `redirected: true`, sans corps.
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: { debugger: { onEvent: { addListener: () => undefined } } },
}));

const { chromeBrowserApi } = await import('./chrome-api.ts');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chromeBrowserApi().fetch', () => {
  test('redirect: manual ; réponse opaqueredirect → redirected, aucun second appel', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(init);
      return { type: 'opaqueredirect', status: 0, url: 'https://zz-test-shop.example/go', headers: new Headers(), body: null } as unknown as Response;
    });
    const res = await chromeBrowserApi().fetch('https://zz-test-shop.example/go', { method: 'GET', headers: {} });
    expect(res).toMatchObject({ redirected: true, status: 0 });
    expect(await res.text(100)).toBe('');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ redirect: 'manual', credentials: 'include' });
  });
});
