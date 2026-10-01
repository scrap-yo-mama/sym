// SPDX-License-Identifier: AGPL-3.0-only
// i18n : parité des clés et des variables `en` / `fr` (`assert_i18n_key_parity`, étendu à chaque code de 06 § 4.2 par la
// tâche 3.9), chargement paresseux, choix de la langue initiale.
import { describe, expect, test } from 'vitest';
import { createAppI18n, detectLocale, frenchPlural, normalizeLocale, setLocale } from './index';
import en from './locales/en.json';
import fr from './locales/fr.json';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') out.set(prefix + key, value);
    else for (const [k, v] of flatten(value, `${prefix}${key}.`)) out.set(k, v);
  }
  return out;
}

const variables = (message: string): string[] => [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('fichiers de langue', () => {
  const english = flatten(en);
  const french = flatten(fr);

  test('assert_i18n_key_parity : mêmes clés, mêmes variables, aucune valeur vide', () => {
    expect([...french.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, message] of english) {
      expect(message.trim(), key).not.toBe('');
      expect(french.get(key)?.trim(), key).not.toBe('');
      expect(variables(french.get(key) ?? ''), key).toEqual(variables(message));
    }
  });

  // Garde légère des fondations ; le test complet (messages REST et MCP compris, noms d'outils de protection) est
  // `assert_ui_strings_no_forbidden_words`, livré par la tâche 3.5.
  test('aucun texte n’emploie un mot interdit par 06 § 4.1 (contourner, débloquer, passer, bypass, unblock, circumvent)', () => {
    for (const [key, message] of [...english, ...french]) expect(forbiddenWords(message), key).toEqual([]);
  });

  test('la garde reconnaît toutes les formes de « passer », sans viser « mot de passe » ni « dépasser »', () => {
    for (const text of ['Passez outre', 'on passe outre la page', 'nous passons', 'passé outre', 'ils passent', 'il passait', 'passer', 'Contourne', 'débloquez', 'Bypassing', 'unblocked', 'circumvents']) {
      expect(forbiddenWords(text), text).not.toEqual([]);
    }
    for (const text of ['Mot de passe', 'mots de passe oubliés', 'Password', 'budget dépassé', 'Le délai est dépassé', 'passport', 'compass']) {
      expect(forbiddenWords(text), text).toEqual([]);
    }
  });
});

/**
 * Mots interdits trouvés dans `text` (06 § 4.1). Exceptions explicites : « mot(s) de passe » (champ de connexion) ;
 * « dépasser » et l'anglais « password », « passport », « compass » ne sont pas des formes de « passer ».
 */
function forbiddenWords(text: string): string[] {
  const cleaned = text.replace(/\bmots? de passe\b/giu, ' ');
  const pattern = /contourn\p{L}*|débloqu\p{L}*|(?<!\p{L})pass(?:e|es|er|ez|ons|ent|é|ée|és|ées|ait|aient|ant|era|erai|erons|erez|eront)(?!\p{L})|bypass\p{L}*|unblock\p{L}*|circumvent\p{L}*/giu;
  return [...cleaned.matchAll(pattern)].map((match) => match[0]);
}

describe('chargement paresseux', () => {
  test('seule la langue active et la langue de repli sont chargées', async () => {
    const i18n = createAppI18n();
    const root = document_stub();
    await setLocale(i18n.global, 'en', root);
    expect(i18n.global.availableLocales).toEqual(['en']);
    expect(root.lang).toBe('en');
    await setLocale(i18n.global, 'fr', root);
    expect([...i18n.global.availableLocales].sort()).toEqual(['en', 'fr']);
    expect(i18n.global.t('auth.login.title')).toBe(fr.auth.login.title);
    expect(root.lang).toBe('fr');
  });

  test('une clé absente d’une langue retombe sur l’anglais', async () => {
    const i18n = createAppI18n();
    await setLocale(i18n.global, 'fr', document_stub());
    i18n.global.mergeLocaleMessage('fr', { app: { name: undefined } } as never);
    expect(i18n.global.t('auth.login.submit')).toBe(fr.auth.login.submit);
  });
});

describe('pluriels (ADR 0002)', () => {
  test('syntaxe native « un | plusieurs » : en suit n = 1, fr traite 0 et 1 comme singulier', async () => {
    const i18n = createAppI18n();
    const root = document_stub();
    await setLocale(i18n.global, 'en', root);
    i18n.global.mergeLocaleMessage('en', { zz: { items: '{n} item | {n} items' } } as never);
    expect([0, 1, 2].map((n) => i18n.global.t('zz.items', { n }, n))).toEqual(['0 items', '1 item', '2 items']);
    await setLocale(i18n.global, 'fr', root);
    i18n.global.mergeLocaleMessage('fr', { zz: { items: '{n} élément | {n} éléments' } } as never);
    expect([0, 1, 2].map((n) => i18n.global.t('zz.items', { n }, n))).toEqual(['0 élément', '1 élément', '2 éléments']);
  });

  test('trois formes (aucun | un | plusieurs) : règle par défaut', () => {
    expect([0, 1, 5].map((n) => frenchPlural(n, 3))).toEqual([0, 1, 2]);
  });
});

describe('langue initiale', () => {
  test('choix mémorisé > langue du navigateur > anglais', () => {
    expect(detectLocale('fr', 'en-US')).toBe('fr');
    expect(detectLocale(null, 'fr-CA')).toBe('fr');
    expect(detectLocale(null, 'de-DE')).toBe('en');
    expect(detectLocale('xx', undefined)).toBe('en');
    expect(normalizeLocale('FR_be')).toBe('fr');
  });
});

function document_stub(): HTMLElement {
  return { lang: '' } as HTMLElement;
}
