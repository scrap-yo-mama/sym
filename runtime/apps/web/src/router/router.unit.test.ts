// SPDX-License-Identifier: AGPL-3.0-only
// Garde de session du routeur : connexion obligatoire, page publique fermée aux sessions ouvertes, redirection interne seule.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import en from '@/i18n/locales/en.json';
import { resetSession } from '@/composables/useSession';
import { buildApi, setApi } from '@/lib/api';
import { createAppRouter, focusRouteHeading, safeRedirect } from './index';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { id: '3f2b6c1e-0000-4000-8000-000000000001', email: 'a@x.test', displayName: 'Ada', role: 'member', locale: 'en', theme: 'system', via: 'ui', scopes: null };

/** 200 : session ouverte ; 401 : anonyme (get-session répond 200 avec null) ; 503 : instance non initialisée. */
function server(status: number) {
  const session = { session: { id: 's' }, user: { id: ME.id, email: ME.email } };
  setApi(
    buildApi({
      baseUrl: 'http://x.test',
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (status === 503) return json(503, { error: { code: 'not_initialized', message: 'x' } });
        if (path === '/api/auth/get-session') return json(200, status === 200 ? session : null);
        return json(200, ME);
      },
    }),
  );
}

beforeEach(() => resetSession());
afterEach(() => setApi(undefined));

describe('safeRedirect', () => {
  test.each([
    ['/', '/'],
    ['/apis?status=sain', '/apis?status=sain'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/ok\nSet-Cookie: x', '/'],
    [undefined, '/'],
    [['/a', '/b'], '/a'],
    [42, '/'],
  ])('%j -> %s', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected);
  });
});

describe('garde de session', () => {
  test('sans session, la page vide mène à la connexion', async () => {
    server(401);
    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('login');
  });

  test('avec session, la page vide s’ouvre et la connexion renvoie à l’accueil', async () => {
    server(200);
    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('home');
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('home');
  });

  test('instance non initialisée : la connexion reste accessible, avec son message', async () => {
    server(503);
    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('login');
  });

  test('le focus va sur le <h1> de la route (06 § 1)', () => {
    let focused = 0;
    let selector = '';
    focusRouteHeading({
      querySelector: ((s: string) => {
        selector = s;
        return { focus: () => (focused += 1) };
      }) as ParentNode['querySelector'],
    });
    expect(selector).toBe('h1[data-route-heading]');
    expect(focused).toBe(1);
  });

  test('chaque page a un titre traduisible', () => {
    const router = createAppRouter(createMemoryHistory());
    const lookup = (key: string): unknown => key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined), en);
    for (const route of router.getRoutes()) expect(typeof lookup(route.meta.titleKey), String(route.name)).toBe('string');
  });
});
