// SPDX-License-Identifier: AGPL-3.0-only
// Chaque message des fichiers de langue se compile avec vue-i18n (syntaxe des paramètres, du pluriel et des liens) : une
// erreur de syntaxe n'apparaîtrait sinon qu'à l'affichage de l'écran concerné.
import { describe, expect, test, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import en from './locales/en.json';
import fr from './locales/fr.json';

type Tree = { [key: string]: string | Tree };

function keys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : keys(value, `${prefix}${key}.`)));
}

/** Valeur pour chaque paramètre `{nom}` d'un message. */
function paramsOf(message: string): Record<string, string | number> {
  return Object.fromEntries([...message.matchAll(/\{(\w+)\}/g)].map((match) => [match[1] ?? '', 3]));
}

describe('compilation des messages', () => {
  for (const [code, messages] of [['en', en], ['fr', fr]] as const) {
    test(`${code} : tous les messages se compilent, sans clé manquante ni avertissement, et aucun paramètre n’est laissé tel quel`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const i18n = createI18n({ legacy: false, locale: code, fallbackLocale: false as unknown as string, missingWarn: true, fallbackWarn: true, messages: { [code]: messages } });
        for (const key of keys(messages as Tree)) {
          const raw = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages) as string;
          const out = i18n.global.t(key, paramsOf(raw));
          expect(out, key).not.toBe(key);
          expect(out, key).not.toMatch(/\{\w+\}/);
          expect(typeof out, key).toBe('string');
        }
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });
  }
});

describe('challenge_in_tunnel : un défi arrête le run (04 § 2, 06 § 2), jamais une pause à reprendre', () => {
  // 06 § 4.2 dit « en pause » et « Reprendre » ; 04 (« un défi détecté arrête le run ») et 06 § 2 (« le run est arrêté »,
  // « Réessayer plus tard (nouveau run) », « Aucune reprise automatique ») l'emportent : la console ne suggère aucune reprise.
  const texts = (messages: Tree): string[] => [
    (messages.reason as Tree).challenge_in_tunnel as string,
    ...Object.values((messages.action as Tree).challenge_in_tunnel as Tree).map(String),
  ];

  test('fr : « arrêté », ni « pause » ni « reprendre »', () => {
    for (const text of texts(fr as Tree)) expect(text).not.toMatch(/pause|repren|reprise/iu);
    expect((fr.reason as Tree).challenge_in_tunnel).toMatch(/Le run est arrêté/u);
  });

  test('en : « stopped », ni « paused » ni « resume »', () => {
    for (const text of texts(en as Tree)) expect(text).not.toMatch(/pause|resum/iu);
    expect((en.reason as Tree).challenge_in_tunnel).toMatch(/The run is stopped/u);
  });
});
