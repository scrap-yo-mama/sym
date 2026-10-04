// SPDX-License-Identifier: AGPL-3.0-only
// i18n : parité des clés et des variables `en` / `fr` (`assert_i18n_key_parity`, étendu à chaque code de 06 § 4.2 par la
// tâche 3.9), chargement paresseux, choix de la langue initiale.
import { describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createAppRouter } from '@/router/index';
import { SPEC_REASON_CODES } from '@/lib/reasons';
import { pluralRule } from '@runtime/i18n/browser';
import { MissingMessageError, createAppI18n, detectLocale, missingMessageCount, normalizeLocale, setLocale } from './index';
import en from '@runtime/i18n/locales/en.json';
import fr from '@runtime/i18n/locales/fr.json';

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
  // `mcp.model.*` (textes destinés au modèle) n'existe qu'en anglais (21b § 2) : hors de la parité de la console.
  const english = new Map([...flatten(en)].filter(([key]) => !key.startsWith('mcp.model.')));
  const french = flatten(fr);

  test('assert_i18n_key_parity : mêmes clés, mêmes variables, aucune valeur vide', () => {
    expect([...french.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, message] of english) {
      expect(message.trim(), key).not.toBe('');
      expect(french.get(key)?.trim(), key).not.toBe('');
      expect(variables(french.get(key) ?? ''), key).toEqual(variables(message));
    }
  });

  test('assert_i18n_key_parity : même nombre de formes de pluriel (« un | plusieurs ») et mêmes messages liés (@:clé) dans les deux langues', () => {
    const forms = (message: string): number => message.split(' | ').length;
    const links = (message: string): string[] => [...message.matchAll(/@(?:\.\w+)?:([\w.]+)/g)].map((m) => m[1] ?? '').sort();
    for (const [key, message] of english) {
      const other = french.get(key) ?? '';
      expect(forms(other), `formes de pluriel de ${key}`).toBe(forms(message));
      expect(links(other), `messages liés de ${key}`).toEqual(links(message));
    }
    // Un message lié pointe sur une clé qui existe.
    for (const [key, message] of [...english, ...french]) {
      for (const target of message.matchAll(/@(?:\.\w+)?:([\w.]+)/g)) expect(english.has(target[1] ?? ''), `${key} → ${target[1]}`).toBe(true);
    }
  });

  test('assert_i18n_key_parity : chaque code de 06 § 4.2 a sa phrase (reasons) et son libellé court (reasonLabel) en en et en fr, mêmes variables', () => {
    expect(SPEC_REASON_CODES.length).toBe(27); // 29 avant D-91 (robots_disallowed et robots_unreachable retirés)
    for (const code of SPEC_REASON_CODES) {
      for (const family of ['reasons', 'reasonLabel']) {
        const key = `${family}.${code}`;
        expect(english.get(key)?.trim(), `en ${key}`).toBeTruthy();
        expect(french.get(key)?.trim(), `fr ${key}`).toBeTruthy();
        expect(variables(french.get(key) ?? ''), key).toEqual(variables(english.get(key) ?? ''));
      }
    }
  });

  test('assert_i18n_key_parity : le titre du document de chaque route (meta.titleKey) existe dans les deux langues', () => {
    const router = createAppRouter(createMemoryHistory());
    const titles = router.getRoutes().map((route) => route.meta.titleKey).filter((key): key is string => typeof key === 'string');
    expect(titles.length).toBeGreaterThanOrEqual(10);
    for (const key of titles) {
      expect(english.get(key), `en ${key}`).toBeTruthy();
      expect(french.get(key), `fr ${key}`).toBeTruthy();
    }
    expect(english.get('app.titleSuffix')).toBeTruthy();
    expect(french.get('app.titleSuffix')).toBeTruthy();
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

  test('assert_i18n_fallback_english : une clé absente d’une langue retombe sur l’anglais (production : repli et compteur local)', async () => {
    const i18n = createAppI18n({ strictMissing: false });
    const before = missingMessageCount();
    await setLocale(i18n.global, 'fr', document_stub());
    // Avant le retrait, la valeur française est servie ; après, c'est la valeur anglaise (repli), pas la clé brute.
    expect(i18n.global.t('app.skipToContent')).toBe(fr.app.skipToContent);
    i18n.global.mergeLocaleMessage('fr', { app: { skipToContent: undefined } } as never);
    expect(i18n.global.t('app.skipToContent')).toBe(en.app.skipToContent);
    expect(i18n.global.t('app.skipToContent')).not.toBe('app.skipToContent');
    // Les autres clés restent en français.
    expect(i18n.global.t('auth.login.submit')).toBe(fr.auth.login.submit);
    // Compteur local des clés manquantes (aucune télémétrie, 21b § 3).
    expect(missingMessageCount()).toBeGreaterThan(before);
  });

  test('gestionnaire missing (21b § 3) : une clé manquante LÈVE en développement et en E2E (défaut sous vitest, DEV)', async () => {
    const i18n = createAppI18n();
    await setLocale(i18n.global, 'fr', document_stub());
    expect(i18n.global.t('auth.login.submit')).toBe(fr.auth.login.submit);
    expect(() => i18n.global.t('zz.cle.inexistante')).toThrow(MissingMessageError);
    i18n.global.mergeLocaleMessage('fr', { app: { skipToContent: undefined } } as never);
    expect(() => i18n.global.t('app.skipToContent')).toThrow(/app\.skipToContent/);
    // te() (codes dynamiques vérifiés avant affichage) ne déclenche pas le gestionnaire.
    expect(i18n.global.te('zz.cle.inexistante')).toBe(false);
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
    expect([0, 1, 5].map((n) => pluralRule('fr')(n, 3))).toEqual([0, 1, 2]);
    expect([0, 1, 5].map((n) => pluralRule('en')(n, 3))).toEqual([0, 1, 2]);
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
