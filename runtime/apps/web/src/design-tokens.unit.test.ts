// SPDX-License-Identifier: AGPL-3.0-only
// Test de jetons (06 § 1, WCAG 1.4.3 et 1.4.11, tâche 3.9) : en clair et en sombre, chaque paire texte/fond des jetons de
// main.css atteint 4,5:1, chaque bordure de champ, anneau de focus et teinte de statut 3:1. axe juge le rendu réel
// (apps/web/e2e/a11y.e2e.ts) ; ce test garde les couleurs que le rendu de test ne montre pas (survol, états, thème non affiché).
import { describe, expect, test } from 'vitest';
import { BLACK, contrast, cssVariables, oklchToLinear, over, readText, WHITE, type Rgb } from '@/testing/contrast';
import { API_STATUSES, STATUS_TONE } from '@/lib/status';

const mainCss = readText(new URL('./assets/main.css', import.meta.url));
const tailwindTheme = readText(new URL('../node_modules/tailwindcss/theme.css', import.meta.url));

/** Couleurs de la palette de Tailwind (`sky-800` → `--color-sky-800: oklch(…)`). */
const palette = (name: string): Rgb => {
  const value = new RegExp(`--color-${name}:\\s*(oklch\\([^)]*\\))`).exec(tailwindTheme)?.[1];
  if (!value) throw new Error(`teinte absente de la palette : ${name}`);
  return oklchToLinear(value);
};

const THEMES = {
  light: cssVariables(mainCss, ':root'),
  dark: cssVariables(mainCss, '.dark'),
} as const;

type Theme = keyof typeof THEMES;
const token = (theme: Theme, name: string): Rgb => {
  const value = THEMES[theme][`--${name}`];
  if (!value) throw new Error(`jeton absent (${theme}) : --${name}`);
  return oklchToLinear(value);
};

const TEXT = 4.5;
const NON_TEXT = 3;

describe('calcul de contraste (oracle)', () => {
  const eightBit = (color: Rgb): number[] =>
    [color.r, color.g, color.b].map((linear) => Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055)));

  test('noir et blanc : 21:1 ; deux couleurs égales : 1:1', () => {
    expect(contrast(WHITE, BLACK)).toBeCloseTo(21, 5);
    expect(contrast(WHITE, WHITE)).toBe(1);
  });

  test('conversion OKLCH → sRGB : valeurs de référence de la palette de Tailwind (sky-800 ≈ #075985 à 8 bits près : hors gamut, gris 50 % = #636363)', () => {
    expect(eightBit(oklchToLinear('oklch(1 0 0)'))).toEqual([255, 255, 255]);
    expect(eightBit(oklchToLinear('oklch(0 0 0)'))).toEqual([0, 0, 0]);
    for (const [got, want] of [[eightBit(palette('sky-800')), [0x07, 0x59, 0x85]], [eightBit(oklchToLinear('oklch(0.5 0 0)')), [0x63, 0x63, 0x63]]] as const) {
      got.forEach((channel, index) => expect(Math.abs(channel - (want[index] ?? 0))).toBeLessThanOrEqual(8));
    }
  });

  test('le test détecte un jeton trop pâle : gris 0,75 sur blanc ne passe pas 4,5:1', () => {
    expect(contrast(oklchToLinear('oklch(0.75 0 0)'), WHITE)).toBeLessThan(TEXT);
    expect(contrast(oklchToLinear('oklch(0.45 0 0)'), WHITE)).toBeGreaterThanOrEqual(TEXT);
  });
});

describe('jetons de main.css', () => {
  test('les deux thèmes déclarent les mêmes jetons', () => {
    expect(Object.keys(THEMES.dark).sort()).toEqual(Object.keys(THEMES.light).filter((name) => name !== '--radius').sort());
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} : texte, 4,5:1 sur chaque fond où la console l'emploie`, () => {
      const t = (name: string) => token(theme, name);
      const pairs: [string, Rgb, Rgb][] = [
        ['foreground / background', t('foreground'), t('background')],
        ['card-foreground / card', t('card-foreground'), t('card')],
        ['popover-foreground / popover', t('popover-foreground'), t('popover')],
        ['primary-foreground / primary', t('primary-foreground'), t('primary')],
        ['secondary-foreground / secondary', t('secondary-foreground'), t('secondary')],
        ['accent-foreground / accent', t('accent-foreground'), t('accent')],
        ['foreground / muted', t('foreground'), t('muted')],
        ['muted-foreground / background', t('muted-foreground'), t('background')],
        ['muted-foreground / card', t('muted-foreground'), t('card')],
        ['muted-foreground / muted', t('muted-foreground'), t('muted')],
        ['muted-foreground / secondary', t('muted-foreground'), t('secondary')],
        ['muted-foreground / accent', t('muted-foreground'), t('accent')],
        ['muted-foreground / muted à 50 % sur background', t('muted-foreground'), over(t('muted'), 0.5, t('background'))],
        ['destructive / background', t('destructive'), t('background')],
        ['destructive / card', t('destructive'), t('card')],
        ['destructive / muted à 50 % sur background', t('destructive'), over(t('muted'), 0.5, t('background'))],
        ['primary / background (lien)', t('primary'), t('background')],
        // Survol : `hover:bg-primary/90`, `hover:bg-accent`, `hover:bg-secondary/80`.
        ['primary-foreground / primary à 90 % (survol)', t('primary-foreground'), over(t('primary'), 0.9, t('background'))],
        ['accent-foreground / accent (survol)', t('accent-foreground'), t('accent')],
        ['secondary-foreground / secondary à 80 % (survol)', t('secondary-foreground'), over(t('secondary'), 0.8, t('background'))],
      ];
      const failing = pairs.map(([name, fg, bg]) => ({ name, ratio: contrast(fg, bg) })).filter(({ ratio }) => ratio < TEXT);
      expect(failing).toEqual([]);
    });

    test(`${theme} : bordures de champ et anneau de focus, 3:1 sur background, card et muted`, () => {
      const t = (name: string) => token(theme, name);
      for (const control of ['input', 'ring'] as const) {
        for (const surface of ['background', 'card', 'muted'] as const) {
          expect(contrast(t(control), t(surface)), `${control} / ${surface}`).toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    });
  }

  test('bouton destructif : texte blanc sur --destructive (clair) et sur --destructive à 60 % (sombre), 4,5:1', () => {
    // Button.vue : `bg-destructive text-white dark:bg-destructive/60`.
    expect(contrast(WHITE, token('light', 'destructive'))).toBeGreaterThanOrEqual(TEXT);
    expect(contrast(WHITE, over(token('dark', 'destructive'), 0.6, token('dark', 'background')))).toBeGreaterThanOrEqual(TEXT);
    expect(contrast(WHITE, over(token('dark', 'destructive'), 0.6, token('dark', 'card')))).toBeGreaterThanOrEqual(TEXT);
  });
});

describe('teintes de statut (lib/status.ts)', () => {
  /** `border-sky-700 text-sky-800 dark:border-sky-400 dark:text-sky-300` → teintes de bordure et de texte par thème. */
  const tones = (classes: string, theme: Theme): { border: string; text: string } => {
    const pick = (prefix: string, dark: boolean): string => {
      const pattern = dark ? new RegExp(`dark:${prefix}-([a-z]+-\\d+)`) : new RegExp(`(?:^| )${prefix}-([a-z]+-\\d+)`);
      const found = pattern.exec(classes)?.[1];
      if (!found) throw new Error(`teinte ${prefix} absente de « ${classes} »`);
      return found;
    };
    return { border: pick('border', theme === 'dark'), text: pick('text', theme === 'dark') };
  };

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} : chaque badge a un texte à 4,5:1 et une bordure à 3:1 sur background, card et muted`, () => {
      const failing: string[] = [];
      for (const status of API_STATUSES) {
        const { border, text } = tones(STATUS_TONE[status], theme);
        for (const surface of ['background', 'card', 'muted'] as const) {
          const ground = token(theme, surface);
          if (contrast(palette(text), ground) < TEXT) failing.push(`${status} texte ${text} / ${surface}`);
          if (contrast(palette(border), ground) < NON_TEXT) failing.push(`${status} bordure ${border} / ${surface}`);
        }
      }
      expect(failing).toEqual([]);
    });
  }

  test('bandeaux « Reprise » et « Action requise » : texte sky-900 / sky-200 et bordures orange sur background', () => {
    expect(contrast(palette('sky-900'), token('light', 'background'))).toBeGreaterThanOrEqual(TEXT);
    expect(contrast(palette('sky-200'), token('dark', 'background'))).toBeGreaterThanOrEqual(TEXT);
    expect(contrast(palette('orange-700'), token('light', 'background'))).toBeGreaterThanOrEqual(NON_TEXT);
    expect(contrast(palette('orange-400'), token('dark', 'background'))).toBeGreaterThanOrEqual(NON_TEXT);
  });
});

describe('anneau de focus', () => {
  test('une règle sans calque pose un anneau opaque de 2 px sur tout :focus-visible (l’emporte sur `outline-none` des composants)', () => {
    const unlayered = mainCss.replace(/@layer base \{[\s\S]*?\n\}\n/, '').replace(/@media[\s\S]*?\n\}\n/, '');
    const rule = /:focus-visible:not\(\[tabindex="-1"\]\)\s*\{([^}]*)\}/.exec(unlayered)?.[1] ?? '';
    expect(rule).toMatch(/outline:\s*2px solid var\(--ring\)/);
    expect(rule).toMatch(/outline-offset:\s*2px/);
  });
});
