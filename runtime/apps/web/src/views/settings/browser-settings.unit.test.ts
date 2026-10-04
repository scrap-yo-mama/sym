// SPDX-License-Identifier: AGPL-3.0-only
// Réglages > Navigateur (tâche 4.7 ; cdc/sym-browser 04g §3, G5) : `cdp_requires_explicit_opt_in` côté console. L'écran d'activation
// affiche le fournisseur publié par le worker, le tableau des capacités présentes et absentes (jamais « tout est bon » : une capacité
// absente est dite absente, en toutes lettres) et le lien « Usage responsable ». L'activation est une variable du worker : aucun champ.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import en from '@runtime/i18n/locales/en.json';
import fr from '@runtime/i18n/locales/fr.json';
import { resetSession } from '@/composables/useSession';
import { setApi } from '@/lib/api';
import { esc, installFakeServer, json, sessionRoutes, view } from '@/testing/console.testkit';
import BrowserSettingsView from './BrowserSettingsView.vue';

beforeEach(() => resetSession());
afterEach(() => {
  setApi(undefined);
  resetSession();
});

const none = { egressPolicy: false, launchArgs: false, freshContextPerRun: false, killBeforeDetach: false, sandboxProbe: false, engineUserAgent: false, privateLatency: false };
const all = Object.fromEntries(Object.keys(none).map((k) => [k, true]));
const served = (body: unknown) => installFakeServer({ ...sessionRoutes, 'GET /api/settings/browser': () => json(200, body) });
const rows = (html: string): string[] => [...html.matchAll(/<tr[^>]*data-testid="browser-capability"[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]);

describe('cdp_requires_explicit_opt_in : écran Réglages > Navigateur', () => {
  test('fournisseur cdp activé : phrase de SYM, dix capacités dites présentes ou absentes, lien « Usage responsable », aucun champ de saisie', async () => {
    served({ kind: 'cdp', capabilities: none, generic_cdp_enabled: true });
    const html = await view(BrowserSettingsView, {}, { locale: 'en' });
    expect(html).toContain(en.instance.browser.bubble);
    expect(html).toContain(en.instance.browser.activationOn);
    expect(html).toContain(esc(en.instance.browser.providerCdp));
    const table = rows(html);
    expect(table).toHaveLength(10);
    for (const row of table) {
      expect(row).toContain(en.instance.browser.present);
      expect(row).toContain(en.instance.browser.absent);
    }
    expect(html).toMatch(/href="\/docs\/responsible-use\/"/);
    expect(html).not.toMatch(/<input|<button|<select/);
    expect(html).not.toContain('👻');
  });

  test('colonne « ce worker » : les capacités publiées, dites en toutes lettres (jamais la couleur seule)', async () => {
    served({ kind: 'sym-browser', capabilities: { ...all, privateLatency: false }, generic_cdp_enabled: false });
    const html = await view(BrowserSettingsView, {}, { locale: 'en' });
    expect(html).toContain(en.instance.browser.providerSymBrowser);
    expect(html).toContain(en.instance.browser.activationOff);
    expect(html).not.toContain(en.instance.browser.bubble);
    const latency = rows(html).find((row) => row.includes(en.instance.browser.capabilities.latency))!;
    expect(latency).toContain(en.instance.browser.absent);
    expect(rows(html)[0]).toContain(en.instance.browser.present);
  });

  test('aucun worker n’a publié : message, tableau de référence sans colonne inventée', async () => {
    served({ kind: null, capabilities: null, generic_cdp_enabled: null });
    const html = await view(BrowserSettingsView, {}, { locale: 'fr' });
    expect(html).toContain(esc(fr.instance.browser.providerUnknown));
    expect(rows(html)).toHaveLength(10);
    expect(rows(html)[0]).not.toContain(fr.instance.browser.unknown);
  });

  test('refus 403 : message « seul un admin », pas de tableau', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/browser': () => json(403, { error: { code: 'forbidden' } }) });
    const html = await view(BrowserSettingsView, {}, { locale: 'en' });
    expect(rows(html)).toHaveLength(0);
    expect(html).toContain(en.settings.adminOnly);
  });
});
