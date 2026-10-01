// SPDX-License-Identifier: AGPL-3.0-only
// Thème clair, sombre ou système (06 § 1).
import { describe, expect, test } from 'vitest';
import { applyTheme, isTheme, readStoredTheme, resolveDark, storeTheme, THEME_STORAGE_KEY } from './theme';

describe('thème', () => {
  test('le thème système suit prefers-color-scheme, les deux autres sont fixes', () => {
    expect(resolveDark('system', true)).toBe(true);
    expect(resolveDark('system', false)).toBe(false);
    expect(resolveDark('dark', false)).toBe(true);
    expect(resolveDark('light', true)).toBe(false);
  });

  test('valeur mémorisée invalide ou stockage indisponible : thème système', () => {
    expect(readStoredTheme({ getItem: () => 'neon' })).toBe('system');
    expect(readStoredTheme({ getItem: () => 'dark' })).toBe('dark');
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error('SecurityError');
        },
      }),
    ).toBe('system');
    expect(isTheme(null)).toBe(false);
  });

  test('storeTheme mémorise sous la clé attendue par public/theme-init.js ; applyTheme pose la classe dark', () => {
    const written: Record<string, string> = {};
    storeTheme('dark', { setItem: (key, value) => void (written[key] = value) });
    expect(written).toEqual({ [THEME_STORAGE_KEY]: 'dark' });
    const toggled: Array<[string, boolean | undefined]> = [];
    const root = { classList: { toggle: (name: string, force?: boolean) => void toggled.push([name, force]) } } as unknown as HTMLElement;
    applyTheme('dark', root, false);
    applyTheme('system', root, false);
    expect(toggled).toEqual([['dark', true], ['dark', false]]);
  });
});
