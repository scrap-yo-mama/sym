// SPDX-License-Identifier: AGPL-3.0-only
// Fonctions empaquetées du tunnel (tâche 2.7, correctifs 8 et 16 de la vérification) : `page_fetch` ne suit AUCUNE
// redirection (`redirect: 'manual'`). Une redirection vers une IP privée ou un autre domaine ne déclenche donc jamais la
// requête suivante dans le navigateur de l'utilisateur (INV10, 08b) : elle est rendue comme `redirect`, sans contenu.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { pageFetchInPage } from './in-page.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const request = { url: 'https://zz-test-shop.example/go', method: 'GET', headers: {}, body: null, maxBytes: 1000, maxMeta: 1000 };

describe('pageFetchInPage : redirections jamais suivies', () => {
  test('fetch appelé avec redirect: manual ; réponse opaqueredirect → kind redirect, aucun second appel', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(init);
      return { type: 'opaqueredirect', status: 0, url: request.url, headers: new Headers(), body: null } as unknown as Response;
    });
    expect(await pageFetchInPage(request)).toEqual({ kind: 'redirect' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ redirect: 'manual', credentials: 'include' });
  });

  test('réponse ordinaire : rendue (statut, en-têtes, corps)', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await pageFetchInPage(request)).toMatchObject({ kind: 'ok', status: 200, body: '{"ok":true}' });
  });
});
