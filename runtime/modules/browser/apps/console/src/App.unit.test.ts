// SPDX-License-Identifier: AGPL-3.0-only
// Console, fondations (tâche 3.5) : rendu côté serveur des écrans publics en fr (tutoiement) et en en, design system SYM
// (packages/ui), structure accessible (repères, titre unique, libellés liés, autocomplete), messages i18n `console.<écran>.<élément>`.
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory } from 'vue-router';
import { describe, expect, test } from 'vitest';
import { createConsoleApp } from './app.js';
import { detectLocale, errorKey, LOCALES, messages, normalizeLocale, type Locale } from './i18n.js';
import { createMockAuthApi } from './testing/mock-auth.js';

const ADMIN = { email: 'admin@example.test', password: 'douze-caracteres-au-moins' };

async function render(path: string, locale: Locale, initialized = true): Promise<string> {
  const api = createMockAuthApi({ bootstrapToken: 't', admin: initialized ? ADMIN : undefined });
  const { app, router } = createConsoleApp({ api, locale, history: createMemoryHistory(), ssr: true });
  await router.push(path);
  await router.isReady();
  return renderToString(app);
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const keys = (node: object, prefix = ''): string[] =>
  Object.entries(node).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`]));
const values = (node: object): string[] => Object.values(node).flatMap((v) => (typeof v === 'object' && v !== null ? values(v as object) : [String(v)]));

describe('page de connexion', () => {
  test('français, au tutoiement : titre, champs, bouton', async () => {
    const html = await render('/login', 'fr');
    expect(text(html)).toContain('Connexion à la console');
    expect(text(html)).toContain('Connecte-toi');
    expect(html).toMatch(/<label[^>]*for="login-email"/);
    expect(html).toMatch(/<input[^>]*id="login-email"[^>]*autocomplete="username"|<input[^>]*autocomplete="username"[^>]*id="login-email"/);
    expect(html).toMatch(/autocomplete="current-password"/);
    expect(html).toMatch(/<button[^>]*type="submit"/);
  });

  test('anglais', async () => {
    const html = await render('/login', 'en');
    expect(text(html)).toContain('Sign in to the console');
    expect(text(html)).toContain('Password');
  });

  test('repères : lien d’évitement, barre de navigation, contenu principal, un seul h1 ; signature SYM de packages/ui', async () => {
    const html = await render('/login', 'fr');
    expect(html).toMatch(/<a[^>]*href="#main"/);
    expect(html).toMatch(/<header/);
    expect(html).toMatch(/<main[^>]*id="main"/);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('data-sym-signature');
    expect(html).toContain('sym-on-ink');
  });

  test('sélecteur de langue libellé, avec les deux langues', async () => {
    const html = await render('/login', 'en');
    expect(html).toMatch(/<label[^>]*for="console-locale"/);
    expect(html).toMatch(/<select[^>]*id="console-locale"/);
    expect(html).toContain('value="fr"');
    expect(html).toContain('value="en"');
    expect(html).toMatch(/<option[^>]*lang="fr"[^>]*>Français/);
  });
});

describe('premier démarrage', () => {
  test('/setup : jeton, e-mail, mot de passe (12 caractères), SYM parle au tutoiement', async () => {
    const html = await render('/setup', 'fr', false);
    expect(text(html)).toContain('Premier démarrage');
    expect(html).toMatch(/id="setup-token"/);
    expect(html).toMatch(/id="setup-email"/);
    expect(html).toMatch(/id="setup-password"[^>]*|autocomplete="new-password"/);
    expect(html).toMatch(/minlength="12"/);
    expect(text(html)).toContain('12 caractères au minimum');
    expect(html).toContain('data-variant="speaking"');
  });
});

describe('messages', () => {
  test('mêmes clés en fr et en, toutes sous `console.`', () => {
    expect(keys(messages.fr).sort()).toEqual(keys(messages.en).sort());
    expect(Object.keys(messages.fr)).toEqual(['console']);
    expect(LOCALES).toEqual(['fr', 'en']);
  });

  test('français au tutoiement : ni « vous », ni « votre », ni « vos »', () => {
    const vouvoiement = values(messages.fr).filter((v) => /\b(vous|votre|vos)\b/i.test(v));
    expect(vouvoiement).toEqual([]);
  });

  test('aucun emoji dans les messages : la signature SYM est l’icône SVG de packages/ui', () => {
    expect(values(messages.fr).concat(values(messages.en)).filter((v) => /\p{Extended_Pictographic}/u.test(v))).toEqual([]);
  });

  test('chaque code d’erreur d’AuthApi et du transport a son message ; un code inconnu devient `unexpected`', () => {
    const login = ['invalid_credentials', 'rate_limited', 'not_initialized', 'invalid_code', 'no_pending_login', 'network', 'unexpected'];
    const setup = ['invalid_bootstrap_token', 'already_initialized', 'weak_password', 'invalid_email', 'rate_limited', 'network', 'unexpected'];
    for (const code of login) expect(errorKey('login', code)).toBe(`console.login.errors.${code}`);
    for (const code of setup) expect(errorKey('setup', code)).toBe(`console.setup.errors.${code}`);
    expect(errorKey('login', 'toString')).toBe('console.login.errors.unexpected');
    expect(errorKey('setup', 'phrase du serveur')).toBe('console.setup.errors.unexpected');
  });

  test('langue : choix mémorisé, sinon navigateur (fr-* → fr), sinon en', () => {
    expect(normalizeLocale('fr-CA')).toBe('fr');
    expect(normalizeLocale('de-DE')).toBe('en');
    expect(normalizeLocale(undefined)).toBe('en');
    expect(detectLocale('fr', 'en-US')).toBe('fr');
    expect(detectLocale('xx', 'fr-FR')).toBe('fr');
    expect(detectLocale(null, undefined)).toBe('en');
  });
});
