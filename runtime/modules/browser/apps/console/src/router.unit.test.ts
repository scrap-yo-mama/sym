// SPDX-License-Identifier: AGPL-3.0-only
// Garde de navigation de la console (tâche 3.5, 04d § 5.3) : sans admin → /setup ; admin créé mais non connecté → /login
// (retour à la page demandée, chemin interne seulement) ; connecté → plus de /login ni de /setup.
import { describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createAuthStore } from './auth/store.js';
import { createConsoleRouter, safeRedirect } from './router.js';
import { createMockAuthApi, MOCK_TOTP_CODE } from './testing/mock-auth.js';

const ADMIN = { email: 'admin@example.test', password: 'douze-caracteres-au-moins' };

async function boot(path: string, options: Parameters<typeof createMockAuthApi>[0]) {
  const api = createMockAuthApi(options);
  const auth = createAuthStore(api);
  const router = createConsoleRouter(auth, createMemoryHistory());
  await router.push(path);
  await router.isReady();
  return { api, auth, router };
}

describe('garde de navigation', () => {
  test('instance sans admin : toute page mène à /setup', async () => {
    const { router } = await boot('/', { bootstrapToken: 't' });
    expect(router.currentRoute.value.name).toBe('setup');
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('setup');
  });

  test('admin créé, non connecté : /login avec retour vers la page demandée ; /setup n’est plus accessible', async () => {
    const { router } = await boot('/?onglet=1', { bootstrapToken: 't', admin: ADMIN });
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBe('/?onglet=1');
    await router.push('/setup');
    expect(router.currentRoute.value.name).toBe('login');
  });

  test('connecté : accueil ; /login et /setup ramènent à l’accueil ; déconnexion : retour à /login', async () => {
    const { auth, router } = await boot('/login', { bootstrapToken: 't', admin: ADMIN });
    expect(await auth.login(ADMIN.email, ADMIN.password)).toEqual({ ok: true, step: 'done' });
    expect(auth.state.value).toBe('authenticated');
    expect(auth.admin.value).toEqual({ email: ADMIN.email });
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('home');
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('home');
    await router.push('/setup');
    expect(router.currentRoute.value.name).toBe('home');
    await auth.logout();
    await router.push('/?apres=deconnexion');
    expect(router.currentRoute.value.name).toBe('login');
  });

  test('2FA : état `totp_pending` puis connecté ; annuler revient à l’état anonyme', async () => {
    const { auth } = await boot('/login', { bootstrapToken: 't', admin: { ...ADMIN, totp: true } });
    expect(await auth.login(ADMIN.email, ADMIN.password)).toEqual({ ok: true, step: 'totp' });
    expect(auth.state.value).toBe('totp_pending');
    await auth.cancelTotp();
    expect(auth.state.value).toBe('anonymous');
    await auth.login(ADMIN.email, ADMIN.password);
    expect(await auth.verifyTotp(MOCK_TOTP_CODE)).toEqual({ ok: true });
    expect(auth.state.value).toBe('authenticated');
  });

  test('serveur injoignable : état `unavailable`, la page de connexion reste ouverte pour afficher l’erreur', async () => {
    const auth = createAuthStore({
      status: async () => ({ ok: false, status: 0, code: 'network' }),
      login: async () => ({ ok: false, status: 0, code: 'network' }),
      verifyTotp: async () => ({ ok: false, status: 0, code: 'network' }),
      logout: async () => ({ ok: false, status: 0, code: 'network' }),
      setup: async () => ({ ok: false, status: 0, code: 'network' }),
    });
    const router = createConsoleRouter(auth, createMemoryHistory());
    await router.push('/');
    expect(auth.state.value).toBe('unavailable');
    expect(router.currentRoute.value.name).toBe('login');
  });

  test('page inconnue : accueil (donc /login si non connecté)', async () => {
    const { router } = await boot('/nulle-part', { bootstrapToken: 't', admin: ADMIN });
    expect(router.currentRoute.value.name).toBe('login');
  });
});

describe('safeRedirect', () => {
  test('chemin interne seulement', () => {
    expect(safeRedirect('/sessions?x=1')).toBe('/sessions?x=1');
    expect(safeRedirect('//evil.example')).toBe('/');
    expect(safeRedirect('/\\evil.example')).toBe('/');
    expect(safeRedirect('https://evil.example')).toBe('/');
    expect(safeRedirect(['/a'])).toBe('/');
    expect(safeRedirect(undefined)).toBe('/');
    expect(safeRedirect('/login')).toBe('/');
  });
});
