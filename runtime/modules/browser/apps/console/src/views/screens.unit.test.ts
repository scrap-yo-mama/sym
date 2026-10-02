// SPDX-License-Identifier: AGPL-3.0-only
// Écrans de la console (tâche 3.6, 04d § 5.2) rendus côté serveur avec la simulation : sessions (en cours, passées, filtres),
// détail (vue en direct, frise d'événements, enregistrements, fichiers, usage), nœuds et capacité, clés et quotas, profils,
// consommation. Textes fr (tutoiement) et en, structure accessible (titres, tableaux légendés, pastilles icône + libellé +
// couleur, états vide et erreur en voix SYM, navigation avec la page courante marquée).
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory } from 'vue-router';
import { describe, expect, test } from 'vitest';
import type { ConsoleApi } from '../api/console.js';
import { createConsoleApp } from '../app.js';
import type { Locale } from '../i18n.js';
import { createMockAuthApi } from '../testing/mock-auth.js';
import { createMockConsoleApi } from '../testing/mock-console.js';

const ADMIN = { email: 'admin@example.test', password: 'douze-caracteres-au-moins' };

async function render(path: string, locale: Locale, consoleApi: ConsoleApi = createMockConsoleApi()): Promise<string> {
  const api = createMockAuthApi({ bootstrapToken: 't', admin: ADMIN });
  await api.login(ADMIN);
  const { app, router } = createConsoleApp({ api, consoleApi, locale, history: createMemoryHistory(), ssr: true });
  await router.push(path);
  await router.isReady();
  return renderToString(app);
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const h1 = (html: string): string => text(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '');

/** API dont toutes les lectures échouent (serveur injoignable). */
function failingApi(): ConsoleApi {
  const base = createMockConsoleApi();
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop === 'string' && /^(list|get|usage)/.test(prop) && typeof value === 'function') return async () => ({ ok: false, status: 0, code: 'network' });
      return value;
    },
  });
}

const SCREENS = [
  { path: '/sessions', fr: 'Sessions', en: 'Sessions' },
  { path: '/sessions/ses_recorded', fr: 'Session ses_recorded', en: 'Session ses_recorded' },
  { path: '/nodes', fr: 'Nœuds et capacité', en: 'Nodes and capacity' },
  { path: '/keys', fr: 'Clés et quotas', en: 'Keys and quotas' },
  { path: '/profiles', fr: 'Profils', en: 'Profiles' },
  { path: '/usage', fr: 'Consommation', en: 'Usage' },
] as const;

describe('les 6 écrans : titre, un seul h1, navigation', () => {
  for (const screen of SCREENS) {
    for (const locale of ['fr', 'en'] as const) {
      test(`${screen.path} (${locale})`, async () => {
        const html = await render(screen.path, locale);
        expect(h1(html)).toBe(screen[locale]);
        expect(html.match(/<h1/g)).toHaveLength(1);
        expect(html).toMatch(/<nav[^>]*aria-label="[^"]+"/);
        for (const href of ['/sessions', '/nodes', '/keys', '/profiles', '/usage']) expect(html).toContain(`href="${href}"`);
        const section = screen.path.split('/')[1];
        expect(html).toMatch(new RegExp(`<a[^>]*href="/${section}"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="/${section}"`));
      });
    }
  }
});

describe('sessions (/sessions)', () => {
  test('onglets « En cours » et « Passées », filtres libellés, tableau légendé, pastilles icône + libellé', async () => {
    const html = await render('/sessions', 'fr');
    expect(html).toMatch(/role="tablist"/);
    expect(text(html)).toContain('En cours');
    expect(text(html)).toContain('Passées');
    for (const id of ['filter-state', 'filter-type', 'filter-key', 'filter-node', 'filter-from', 'filter-to', 'filter-metadata']) {
      expect(html, id).toMatch(new RegExp(`<label[^>]*for="${id}"`));
      expect(html, id).toMatch(new RegExp(`id="${id}"`));
    }
    expect(html).toMatch(/<caption/);
    for (const col of ['Identifiant', 'État', 'Type', 'Durée', 'Octets', 'Clé']) expect(html).toMatch(new RegExp(`<th[^>]*scope="col"[^>]*>\\s*${col}`));
    expect(html).toContain('data-status="running"');
    expect(html).toMatch(/data-status="running"[\s\S]*?<svg[\s\S]*?En cours/);
    expect(html).toContain('href="/sessions/ses_live"');
  });

  test('passées, filtre par état dans l’URL ; pagination par curseur proposée', async () => {
    const html = await render('/sessions?tab=past&state=failed', 'en');
    expect(html).toContain('data-status="failed"');
    expect(html).not.toContain('data-status="ended"');
    expect(text(html)).toContain('Failed');
    const all = await render('/sessions?tab=past', 'en');
    expect(text(all)).toContain('Load more sessions');
  });

  test('état vide et erreur en voix SYM, au tutoiement', async () => {
    const empty = await render('/sessions?tab=past&metadata=run%3Dabsent', 'fr');
    expect(empty).toContain('data-variant="speaking"');
    expect(text(empty)).toContain('Aucune session ne correspond à tes filtres');
    const failed = await render('/sessions', 'fr', failingApi());
    expect(failed).toMatch(/role="alert"/);
    expect(text(failed)).toContain('Le serveur ne répond pas');
  });
});

describe('détail (/sessions/:id)', () => {
  test('en-tête, actions, frise annoncée, enregistrements, fichiers, usage', async () => {
    const html = await render('/sessions/ses_recorded', 'fr');
    expect(text(html)).toContain('Terminée');
    expect(html).toMatch(/aria-live="polite"/);
    expect(text(html)).toContain('Enregistrements');
    expect(html).toMatch(/href="\/v1\/sessions\/ses_recorded\/recordings\/[^"]+"/);
    expect(html).toMatch(/href="\/v1\/sessions\/ses_recorded\/files\/[^"]+"/);
    expect(text(html)).toContain('Usage de la session');
    // Session terminée : plus d'action ni de vue en direct.
    expect(text(html)).not.toContain('Libérer la session');
    expect(text(html)).toContain('La vue en direct n’est disponible que pendant la session');
  });

  test('session en cours : libérer, prolonger, vue en direct en lecture seule annoncée en texte', async () => {
    const html = await render('/sessions/ses_live', 'fr');
    expect(text(html)).toContain('Libérer la session');
    expect(html).toMatch(/<label[^>]*for="extend-seconds"/);
    expect(text(html)).toContain('Vue en direct');
    expect(text(html)).toContain('Lecture seule');
    expect(text(html)).toContain('Prendre la main');
  });

  test('session inconnue : message, lien de retour', async () => {
    const html = await render('/sessions/inconnue', 'en');
    expect(text(html)).toContain('This session does not exist');
    expect(html).toContain('href="/sessions"');
  });
});

describe('nœuds (/nodes)', () => {
  test('une carte par nœud : état, slots, RSS, versions, battement, drainer ; alerte sous 15 % de slots libres', async () => {
    const html = await render('/nodes', 'fr');
    for (const state of ['ready', 'draining', 'down']) expect(html).toContain(`data-status="${state}"`);
    expect(text(html)).toContain('Prêt');
    expect(text(html)).toContain('En drainage');
    expect(text(html)).toContain('Hors service');
    expect(text(html)).toMatch(/slots libres/);
    expect(text(html)).toContain('Playwright 1.63.0');
    expect(text(html)).toContain('Chromium 153.0.8010.12');
    expect(text(html)).toContain('Drainer');
    expect(html).toMatch(/<meter|role="meter"|<progress/);
    expect(text(html)).toContain('moins de 15 %');
  });
});

describe('clés et quotas (/keys)', () => {
  test('clients et quotas, clés (préfixe, scopes, expiration, dernière utilisation), formulaire de création libellé', async () => {
    const html = await render('/keys', 'fr');
    expect(text(html)).toContain('Quotas');
    expect(text(html)).toContain('Sessions simultanées');
    expect(text(html)).toContain('symb_live_');
    expect(text(html)).toContain('sessions:read');
    for (const col of ['Préfixe', 'Scopes', 'Expiration', 'Dernière utilisation']) expect(html).toMatch(new RegExp(`<th[^>]*scope="col"[^>]*>\\s*${col}`));
    for (const id of ['key-tenant', 'key-name', 'key-expires']) expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    expect(html).toMatch(/<fieldset[\s\S]*?<legend/);
    expect(text(html)).toContain('Révoquer');
  });
});

describe('profils (/profiles)', () => {
  test('profils (taille, version, verrou et session porteuse), proxys (test, IP de sortie), import et export', async () => {
    const html = await render('/profiles', 'fr');
    expect(text(html)).toContain('Verrouillé');
    expect(html).toMatch(/href="\/sessions\/ses_[a-z_]+"/);
    expect(text(html)).toContain('Exporter');
    expect(text(html)).toContain('Importer');
    expect(text(html)).toContain('Profils de proxy');
    expect(text(html)).toContain('Tester');
    expect(text(html)).not.toMatch(/password|mot de passe :/i);
  });
});

describe('consommation (/usage)', () => {
  test('période, courbe par jour (alternative en tableau), tableau par clé, export CSV, écart de réconciliation', async () => {
    const html = await render('/usage', 'fr');
    for (const id of ['usage-from', 'usage-to']) expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-labelledby="/);
    expect(html).toMatch(/href="\/v1\/usage\.csv\?from=\d{4}-\d{2}-\d{2}&amp;to=\d{4}-\d{2}-\d{2}&amp;groupBy=key"/);
    expect(text(html)).toContain('Écart de réconciliation');
    expect(text(html)).toContain('Réconcilier');
    expect(html.match(/<table/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('accueil', () => {
  test('connecté : liens vers les écrans', async () => {
    const html = await render('/', 'fr');
    expect(h1(html)).toBe('Accueil');
    for (const href of ['/sessions', '/nodes', '/keys', '/profiles', '/usage']) expect(html).toContain(`href="${href}"`);
  });
});
