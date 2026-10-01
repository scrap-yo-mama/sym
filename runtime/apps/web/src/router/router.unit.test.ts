// SPDX-License-Identifier: AGPL-3.0-only
// Garde de session du routeur : connexion obligatoire, page publique fermée aux sessions ouvertes, redirection interne seule.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import en from '@runtime/i18n/locales/en.json';
import { resetSession } from '@/composables/useSession';
import { buildApi, setApi } from '@/lib/api';
import { createAppRouter, focusRouteHeading, focusRouteHeadingWhenReady, safeRedirect } from './index';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { id: '3f2b6c1e-0000-4000-8000-000000000001', email: 'a@x.test', displayName: 'Ada', role: 'member', locale: 'en', theme: 'system', via: 'ui', scopes: null, permissions: [], mfaEnabled: false, mfaRequired: false, mfaEnrollmentRequired: false };

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

  test('instance non initialisée : l’assistant de premier démarrage est la seule page (13 § 4)', async () => {
    server(503);
    const router = createAppRouter(createMemoryHistory());
    for (const path of ['/', '/login', '/apis', '/invite/abc']) {
      await router.push(path);
      expect(router.currentRoute.value.name, path).toBe('setup');
    }
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

// Écrans de la tâche 3.5 : Nouvelle API, Tous les runs, Réglages BYO. Tous exigent une session ouverte.
describe('routes de la tâche 3.5', () => {
  const PAGES = ['/apis/new', '/apis/new/6f1c8a52-0000-4000-8000-000000000010', '/runs', '/settings/models', '/settings/proxies', '/settings/extension', '/settings/alerts', '/settings/diagnostic'];

  test('sans session, chaque page mène à la connexion en gardant la destination', async () => {
    for (const path of PAGES) {
      resetSession();
      server(401);
      const router = createAppRouter(createMemoryHistory());
      await router.push(path);
      expect(router.currentRoute.value.name, path).toBe('login');
      expect(router.currentRoute.value.query.redirect, path).toBe(path);
    }
  });

  test('avec session, chaque page s’ouvre ; /settings mène aux modèles IA ; /apis/new ne se confond pas avec une fiche', async () => {
    server(200);
    const router = createAppRouter(createMemoryHistory());
    const expected: Record<string, string> = {
      '/apis/new': 'new-api',
      '/apis/new/6f1c8a52-0000-4000-8000-000000000010': 'new-api-run',
      '/runs': 'runs',
      '/settings': 'settings-models',
      '/settings/proxies': 'settings-proxies',
      '/settings/extension': 'settings-extension',
      '/settings/alerts': 'settings-alerts',
      '/settings/diagnostic': 'settings-diagnostic',
    };
    for (const [path, name] of Object.entries(expected)) {
      await router.push(path);
      expect(router.currentRoute.value.name, path).toBe(name);
    }
    expect(router.currentRoute.value.params).toEqual({});
  });
});

// Le <h1> d'une page qui charge ses données n'existe pas encore au changement de route (fiche d'une API : squelette, puis fiche) :
// le focus l'attend au lieu de rester sur <body> (06 § 1, WCAG 2.4.3).
describe('focusRouteHeadingWhenReady', () => {
  type Heading = { focus: () => void };
  function harness(options: { heading?: Heading | null; activeIsBody?: boolean } = {}) {
    const state = { heading: options.heading ?? null, activeIsBody: options.activeIsBody ?? true };
    let onChange: (() => void) | undefined;
    let timeout: (() => void) | undefined;
    const log: string[] = [];
    const body = { tagName: 'BODY' };
    const root = {
      querySelector: (() => state.heading) as ParentNode['querySelector'],
      get activeElement() {
        return state.activeIsBody ? body : { tagName: 'INPUT' };
      },
      body,
    } as unknown as Parameters<typeof focusRouteHeadingWhenReady>[0];
    const deps = {
      observe: (callback: () => void) => {
        onChange = callback;
        log.push('observe');
        return () => log.push('disconnect');
      },
      schedule: (callback: () => void) => {
        timeout = callback;
        return () => log.push('unschedule');
      },
    };
    return { state, root, deps, log, appear: (heading: Heading) => { state.heading = heading; onChange?.(); }, expire: () => timeout?.() };
  }

  test('le <h1> est déjà là : focus tout de suite, rien n’est observé', () => {
    let focused = 0;
    const h = harness({ heading: { focus: () => (focused += 1) } });
    focusRouteHeadingWhenReady(h.root, h.deps);
    expect(focused).toBe(1);
    expect(h.log).toEqual([]);
  });

  test('le <h1> arrive après le chargement des données : il prend le focus à son apparition, puis l’observation s’arrête', () => {
    let focused = 0;
    const h = harness();
    focusRouteHeadingWhenReady(h.root, h.deps);
    expect(h.log).toEqual(['observe']);
    h.appear({ focus: () => (focused += 1) });
    expect(focused).toBe(1);
    expect(h.log).toEqual(['observe', 'disconnect', 'unschedule']);
  });

  test('la personne a déjà mis le focus ailleurs (champ, bouton) : le <h1> qui arrive ne le lui vole pas', () => {
    let focused = 0;
    const h = harness({ activeIsBody: false });
    focusRouteHeadingWhenReady(h.root, h.deps);
    h.appear({ focus: () => (focused += 1) });
    expect(focused).toBe(0);
    expect(h.log).toContain('disconnect');
  });

  test('aucun <h1> avant le délai : l’observation s’arrête sans focus', () => {
    const h = harness();
    focusRouteHeadingWhenReady(h.root, h.deps);
    h.expire();
    expect(h.log).toEqual(['observe', 'disconnect']);
  });

  test('une nouvelle navigation annule l’attente de la précédente', () => {
    let first = 0;
    let second = 0;
    const a = harness();
    focusRouteHeadingWhenReady(a.root, a.deps);
    const b = harness({ heading: { focus: () => (second += 1) } });
    focusRouteHeadingWhenReady(b.root, b.deps);
    a.appear({ focus: () => (first += 1) });
    expect(a.log).toContain('disconnect');
    expect(first).toBe(0);
    expect(second).toBe(1);
  });
});
