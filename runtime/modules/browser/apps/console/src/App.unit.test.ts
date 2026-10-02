// SPDX-License-Identifier: AGPL-3.0-only
// Console (squelette) : rendu côté serveur en fr et en, signature SYM de packages/ui, parité des messages.
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, test } from 'vitest';
import App from './App.vue';
import { createConsoleI18n, LOCALES, messages, normalizeLocale, type Locale } from './i18n.js';

const render = (locale: Locale): Promise<string> => renderToString(createSSRApp(App).use(createConsoleI18n(locale)));
const text = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const keys = (node: object, prefix = ''): string[] =>
  Object.entries(node).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`]));

describe('console (squelette)', () => {
  test('français, au tutoiement', async () => {
    const html = await render('fr');
    expect(html).toContain('data-sym-signature');
    expect(text(html)).toContain('Tu y suivras tes sessions');
  });

  test('anglais', async () => {
    expect(text(await render('en'))).toContain('You will follow your sessions');
  });

  test('mêmes clés en fr et en', () => {
    expect(keys(messages.fr).sort()).toEqual(keys(messages.en).sort());
    expect(LOCALES).toEqual(['fr', 'en']);
  });

  test('langue du navigateur : fr-* → fr, sinon en', () => {
    expect(normalizeLocale('fr-CA')).toBe('fr');
    expect(normalizeLocale('de-DE')).toBe('en');
    expect(normalizeLocale(undefined)).toBe('en');
  });
});
