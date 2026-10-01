// SPDX-License-Identifier: AGPL-3.0-only
// Thème clair, sombre ou système (`users.theme`, 06 § 1). La classe `dark` de <html> est posée avant le premier rendu
// par public/theme-init.js ; ce module la maintient ensuite (choix de l'utilisateur, changement du thème système).
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = 'runtime.theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** True si le thème sombre s'applique (le thème système suit `prefers-color-scheme`). */
export function resolveDark(theme: Theme, systemPrefersDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && systemPrefersDark);
}

export function readStoredTheme(storage: Pick<Storage, 'getItem'> = localStorage): Theme {
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement, systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches): void {
  root.classList.toggle('dark', resolveDark(theme, systemPrefersDark));
}

export function storeTheme(theme: Theme, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* stockage indisponible : le choix vaut pour la session seulement */
  }
}
