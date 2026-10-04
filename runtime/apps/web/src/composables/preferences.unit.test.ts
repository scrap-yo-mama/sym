// SPDX-License-Identifier: AGPL-3.0-only
// Langue et fuseau du compte (tâche 3.20, 21 § 3, 21b M2) : la langue du COMPTE gagne sur le choix mémorisé dans le navigateur, un
// changement de langue connecté est écrit sur le compte, le fuseau du navigateur est posé une fois à la première connexion,
// l'écran Mon compte l'enregistre ; les heures affichées suivent `users.timezone`.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAppI18n, LOCALE_STORAGE_KEY } from '@/i18n';
import { applyAccountPreferences, persistPreferences } from '@/composables/usePreferences';
import { resetSession, useSession } from '@/composables/useSession';
import { setApi } from '@/lib/api';
import { formatDateTime, setDisplayTimeZone } from '@/lib/format';
import { installFakeServer, json, ME, signedIn } from '@/testing/console.testkit';

const store = new Map<string, string>();
const root = { lang: '', dir: '', classList: { toggle: () => false } } as unknown as HTMLElement;

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal('document', { documentElement: root });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  resetSession();
  setDisplayTimeZone(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setApi(undefined);
  resetSession();
});

const account = (over: Record<string, unknown> = {}) => ({ locale: 'fr', theme: 'system', timezone: 'Europe/Paris', timezoneInitialized: true, ...over });

describe('applyAccountPreferences', () => {
  test('la langue du compte l’emporte sur le choix mémorisé dans ce navigateur', async () => {
    store.set(LOCALE_STORAGE_KEY, 'en');
    const i18n = createAppI18n();
    await applyAccountPreferences(i18n.global, account());
    expect(i18n.global.locale.value).toBe('fr');
    expect(store.get(LOCALE_STORAGE_KEY)).toBe('fr');
    // Une langue du compte que la console ne propose plus retombe sur `en`.
    await applyAccountPreferences(i18n.global, account({ locale: 'zz' }));
    expect(i18n.global.locale.value).toBe('en');
  });

  test('premier passage sans fuseau : le fuseau du navigateur est enregistré une fois ; avec un fuseau, rien n’est écrit', async () => {
    const calls = installFakeServer({ 'PATCH /api/me': (call) => json(200, { ...ME, ...(call.body as object) }) });
    await applyAccountPreferences(createAppI18n().global, account({ timezone: null, timezoneInitialized: false }));
    const patch = calls.filter((c) => c.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(patch[0]?.path).toBe('/api/me');
    expect(patch[0]?.body).toEqual({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    calls.length = 0;
    await applyAccountPreferences(createAppI18n().global, account());
    expect(calls).toEqual([]);
  });

  test('fuseau effacé volontairement dans Mon compte : la connexion suivante ne le réécrit pas (initialisation marquée, pas « timezone === null »)', async () => {
    const calls = installFakeServer({ 'PATCH /api/me': (call) => json(200, { ...ME, ...(call.body as object) }) });
    await applyAccountPreferences(createAppI18n().global, account({ timezone: null, timezoneInitialized: true }));
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    // Serveur d'avant le marqueur (champ absent) : aucune écriture non plus.
    await applyAccountPreferences(createAppI18n().global, { locale: 'fr', theme: 'system', timezone: null });
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  test('l’heure affichée suit users.timezone', async () => {
    const iso = '2026-10-01T22:30:00Z';
    await applyAccountPreferences(createAppI18n().global, account({ timezone: 'Asia/Tokyo' }));
    expect(formatDateTime(iso, 'en')).toMatch(/Oct 2, 2026/);
    setDisplayTimeZone('America/Los_Angeles');
    expect(formatDateTime(iso, 'en')).toMatch(/Oct 1, 2026, 3:30/);
  });
});

describe('persistPreferences', () => {
  test('PATCH /api/me, l’identité de la console est remplacée par la réponse', async () => {
    const calls = installFakeServer({
      'GET /api/auth/get-session': () => json(200, { session: { id: 's' }, user: { id: ME.id, email: ME.email } }),
      'GET /api/me': () => json(200, ME),
      'PATCH /api/me': (call) => json(200, { ...ME, ...(call.body as object) }),
    });
    await signedIn();
    const result = await persistPreferences({ locale: 'fr', timezone: 'Europe/Paris' });
    expect(result.ok).toBe(true);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ locale: 'fr', timezone: 'Europe/Paris' });
    expect(useSession().me.value).toMatchObject({ locale: 'fr', timezone: 'Europe/Paris' });
  });

  test('un fuseau refusé par le serveur : résultat d’erreur typé, identité inchangée', async () => {
    installFakeServer({
      'GET /api/auth/get-session': () => json(200, { session: { id: 's' }, user: { id: ME.id, email: ME.email } }),
      'GET /api/me': () => json(200, ME),
      'PATCH /api/me': () => json(400, { error: { code: 'invalid_timezone', message: 'x' } }),
    });
    await signedIn();
    const result = await persistPreferences({ timezone: 'Paris' });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'invalid_timezone' });
    expect(useSession().me.value?.locale).toBe(ME.locale);
  });
});
