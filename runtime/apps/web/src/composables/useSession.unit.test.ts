// SPDX-License-Identifier: AGPL-3.0-only
// Session de la console : états déduits des codes HTTP, échecs de connexion en codes stables, aucun secret conservé.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApi, onUnauthorized, setApi } from '@/lib/api';
import { ensureSession, loadSession, markExpired, resetSession, signIn, signOut, useSession } from './useSession';

type Handler = (request: Request) => Response | Promise<Response>;

function install(routes: Record<string, Handler>): string[] {
  const seen: string[] = [];
  setApi(
    buildApi({
      baseUrl: 'http://x.test',
      fetch: async (request) => {
        const key = `${request.method} ${new URL(request.url).pathname}`;
        seen.push(key);
        const handler = routes[key];
        if (!handler) throw new TypeError(`réseau coupé : ${key}`);
        return handler(request);
      },
    }),
  );
  return seen;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SESSION = { session: { id: 's' }, user: { id: '3f2b6c1e-0000-4000-8000-000000000001', email: 'a@x.test' } };
const ME = { id: '3f2b6c1e-0000-4000-8000-000000000001', email: 'a@x.test', displayName: 'Ada', role: 'owner', locale: 'fr', theme: 'dark', via: 'ui', scopes: null, permissions: [], mfaEnabled: false, mfaRequired: false, mfaEnrollmentRequired: false };

beforeEach(() => resetSession());
afterEach(() => setApi(undefined));

describe('loadSession', () => {
  test('session confirmée puis identité relue : authentifié', async () => {
    const seen = install({ 'GET /api/auth/get-session': () => json(200, SESSION), 'GET /api/me': () => json(200, ME) });
    expect(await loadSession()).toBe('authenticated');
    expect(useSession().me.value?.email).toBe('a@x.test');
    expect(seen).toEqual(['GET /api/auth/get-session', 'GET /api/me']);
  });

  test('sans session : anonyme, et /api/me n’est jamais appelé (aucun 401 dans la console du navigateur)', async () => {
    const seen = install({ 'GET /api/auth/get-session': () => json(200, null) });
    expect(await loadSession()).toBe('anonymous');
    expect(useSession().me.value).toBeNull();
    expect(seen).toEqual(['GET /api/auth/get-session']);
  });

  test('session révoquée entre les deux lectures (401 de /api/me) : anonyme', async () => {
    install({ 'GET /api/auth/get-session': () => json(200, SESSION), 'GET /api/me': () => json(401, { error: { code: 'unauthorized', message: 'x' } }) });
    expect(await loadSession()).toBe('anonymous');
  });

  test('503 not_initialized : assistant de premier démarrage à terminer', async () => {
    install({ 'GET /api/auth/get-session': () => json(503, { error: { code: 'not_initialized', message: 'x' } }) });
    expect(await loadSession()).toBe('not_initialized');
  });

  test('réseau coupé ou 500 : serveur indisponible, jamais « anonyme »', async () => {
    install({});
    expect(await loadSession()).toBe('unavailable');
    install({ 'GET /api/auth/get-session': () => json(500, { error: { code: 'internal', message: 'x' } }) });
    expect(await loadSession()).toBe('unavailable');
    install({ 'GET /api/auth/get-session': () => json(200, SESSION), 'GET /api/me': () => json(500, { error: { code: 'internal', message: 'x' } }) });
    expect(await loadSession()).toBe('unavailable');
  });

  test('ensureSession ne charge qu’une fois même appelée en parallèle', async () => {
    const seen = install({ 'GET /api/auth/get-session': () => json(200, null) });
    await Promise.all([ensureSession(), ensureSession(), ensureSession()]);
    expect(seen).toEqual(['GET /api/auth/get-session']);
  });
});

describe('signIn', () => {
  test('succès : POST de connexion puis relecture de l’identité', async () => {
    let body: unknown;
    const seen = install({
      'POST /api/auth/sign-in/email': async (request) => {
        body = await request.json();
        return json(200, { redirect: false, user: { id: ME.id, email: ME.email, name: 'Ada' } });
      },
      'GET /api/auth/get-session': () => json(200, SESSION),
      'GET /api/me': () => json(200, ME),
    });
    expect(await signIn('a@x.test', 'pw')).toEqual({ ok: true });
    expect(body).toEqual({ email: 'a@x.test', password: 'pw' });
    expect(seen).toEqual(['POST /api/auth/sign-in/email', 'GET /api/auth/get-session', 'GET /api/me']);
    // Le mot de passe n'est conservé nulle part dans l'état de session.
    expect(JSON.stringify(useSession().me.value)).not.toContain('pw');
  });

  test('401, 429, 503 not_initialized, réseau : codes stables distincts, session inchangée', async () => {
    install({ 'POST /api/auth/sign-in/email': () => json(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'x' }) });
    expect(await signIn('a@x.test', 'bad')).toEqual({ ok: false, failure: 'invalid_credentials' });
    install({ 'POST /api/auth/sign-in/email': () => json(429, { error: { code: 'too_many_attempts', message: 'x' } }) });
    expect(await signIn('a@x.test', 'bad')).toEqual({ ok: false, failure: 'too_many_attempts' });
    install({ 'POST /api/auth/sign-in/email': () => json(503, { error: { code: 'not_initialized', message: 'x' } }) });
    expect(await signIn('a@x.test', 'pw')).toEqual({ ok: false, failure: 'not_initialized' });
    expect(useSession().state.value).toBe('not_initialized');
    install({});
    expect(await signIn('a@x.test', 'pw')).toEqual({ ok: false, failure: 'network' });
    install({ 'POST /api/auth/sign-in/email': () => json(500, { error: { code: 'internal', message: 'x' } }) });
    expect(await signIn('a@x.test', 'pw')).toEqual({ ok: false, failure: 'unknown' });
  });
});

describe('signOut et session expirée', () => {
  test('signOut efface la session locale même si le serveur est injoignable', async () => {
    install({ 'GET /api/auth/get-session': () => json(200, SESSION), 'GET /api/me': () => json(200, ME) });
    await loadSession();
    install({});
    await signOut();
    expect(useSession().state.value).toBe('anonymous');
    expect(useSession().me.value).toBeNull();
  });

  test('un 401 d’une requête authentifiée signale la session expirée ; /api/me et /api/auth/* gèrent le leur', async () => {
    install({
      'GET /api/api-keys': () => json(401, { error: { code: 'unauthorized', message: 'x' } }),
      'GET /api/me': () => json(401, { error: { code: 'unauthorized', message: 'x' } }),
      'POST /api/auth/sign-in/email': () => json(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'x' }),
    });
    let calls = 0;
    const off = onUnauthorized(() => (calls += 1));
    const { getApi } = await import('@/lib/api');
    await getApi().GET('/api/me');
    await getApi().POST('/api/auth/sign-in/email', { body: { email: 'a', password: 'b' } });
    expect(calls).toBe(0);
    await getApi().GET('/api/api-keys');
    expect(calls).toBe(1);
    off();
  });

  test('markExpired ne touche qu’une session authentifiée et affiche « session terminée »', async () => {
    markExpired();
    expect(useSession().expired.value).toBe(false);
    install({ 'GET /api/auth/get-session': () => json(200, SESSION), 'GET /api/me': () => json(200, ME) });
    await loadSession();
    markExpired();
    expect(useSession().state.value).toBe('anonymous');
    expect(useSession().expired.value).toBe(true);
  });
});
