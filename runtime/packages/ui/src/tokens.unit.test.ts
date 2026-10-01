// SPDX-License-Identifier: AGPL-3.0-only
// assert_brand_tokens_contrast (20b § 3.1, U1, gate a11y A10) : chaque paire de jetons déclarée (texte, icône, bordure,
// focus), en clair et en sombre, atteint 4,5:1 (texte) ou 3:1 (éléments d'interface), et toute feuille qui pose du texte
// blanc sur l'orange, de l'orange en texte, ou du bleu sur anthracite fait échouer la CI.
import { describe, expect, test } from 'vitest';
import { sheetViolations } from './testing/color-rules.ts';
import { contrast, cssVariables, over, readText, resolveColor, toHex, type Rgb } from './testing/contrast.ts';

const themeCss = readText(new URL('./theme.css', import.meta.url));
const ROOT = cssVariables(themeCss, ':root');
const DARK = cssVariables(themeCss, '.dark, .sym-on-ink');
const VARIABLES = { light: ROOT, dark: { ...ROOT, ...DARK } };
const TEXT = 4.5;
const NON_TEXT = 3;

const color = (theme: 'light' | 'dark', name: string): Rgb => resolveColor(VARIABLES[theme], `var(--${name})`);

describe('assert_brand_tokens_contrast : palette de la maquette (20 § 1.3, valeurs mesurées)', () => {
  const sym = (name: string): Rgb => color('light', `sym-${name}`);
  const cases: [string, string, string, number, number][] = [
    ['ink', 'cream', 'anthracite / crème', 13.2, TEXT],
    ['ink', 'paper', 'anthracite / papier', 14.39, TEXT],
    ['muted', 'cream', 'atténué / crème', 7.43, TEXT],
    ['muted', 'paper', 'atténué / papier', 8.1, TEXT],
    ['blue', 'cream', 'bleu / crème', 6.24, TEXT],
    ['blue', 'paper', 'bleu / papier', 6.81, TEXT],
    ['ink', 'orange', 'anthracite / orange', 4.89, TEXT],
    ['ink', 'yellow', 'anthracite / jaune', 9.76, TEXT],
    ['ink', 'aqua', 'anthracite / aqua', 10.77, TEXT],
    ['ink', 'lilac', 'anthracite / lilas', 9.1, TEXT],
    ['lilac', 'ink', 'lilas / anthracite (sombre)', 9.1, TEXT],
    ['nav-muted', 'ink', 'gris de navigation / anthracite', 8.78, TEXT],
    ['todo', 'paper', 'bord à faire / papier', 3.37, NON_TEXT],
  ];
  for (const [fg, bg, label, expected, floor] of cases) {
    test(`${label} : ${expected}:1 (mesuré en 20 § 1.3), au moins ${floor}:1`, () => {
      const ratio = contrast(sym(fg), sym(bg));
      expect(ratio).toBeGreaterThanOrEqual(floor);
      expect(ratio).toBeCloseTo(expected, 0);
    });
  }

  test('coche anthracite-aqua de la pastille « fait » : au moins 4,5:1', () => {
    expect(contrast(sym('aqua-ink'), sym('aqua'))).toBeGreaterThanOrEqual(TEXT);
  });

  test('les trois échecs de 20 § 1.3 restent des échecs : blanc sur orange, orange sur crème ou papier, bleu sur anthracite', () => {
    const white: Rgb = { r: 1, g: 1, b: 1 };
    expect(contrast(white, sym('orange'))).toBeLessThan(TEXT);
    expect(contrast(sym('orange'), sym('cream'))).toBeLessThan(NON_TEXT);
    expect(contrast(sym('orange'), sym('paper'))).toBeLessThan(NON_TEXT);
    expect(contrast(sym('blue'), sym('ink'))).toBeLessThan(NON_TEXT);
  });
});

describe('assert_brand_tokens_contrast : jetons sémantiques', () => {
  test('les deux thèmes déclarent les mêmes jetons sémantiques (hors formes et polices, communes)', () => {
    const semantic = (vars: Record<string, string>): string[] => Object.keys(vars).filter((name) => !name.startsWith('--sym-') && name !== '--radius');
    const light = semantic(ROOT);
    const dark = semantic(DARK);
    expect(dark.sort()).toEqual(light.sort());
  });

  for (const theme of ['light', 'dark'] as const) {
    const t = (name: string): Rgb => color(theme, name);

    test(`${theme} : texte, 4,5:1 sur chaque fond où l'interface l'emploie`, () => {
      const pairs: [string, Rgb, Rgb][] = [
        ['foreground / background', t('foreground'), t('background')],
        ['card-foreground / card', t('card-foreground'), t('card')],
        ['popover-foreground / popover', t('popover-foreground'), t('popover')],
        ['primary-foreground / primary', t('primary-foreground'), t('primary')],
        ['secondary-foreground / secondary', t('secondary-foreground'), t('secondary')],
        ['accent-foreground / accent', t('accent-foreground'), t('accent')],
        ['destructive-foreground / destructive', t('destructive-foreground'), t('destructive')],
        ['signature-foreground / signature', t('signature-foreground'), t('signature')],
        ['nav-foreground / nav', t('nav-foreground'), t('nav')],
        ['nav-muted-foreground / nav', t('nav-muted-foreground'), t('nav')],
        ['foreground / muted', t('foreground'), t('muted')],
        ['muted-foreground / background', t('muted-foreground'), t('background')],
        ['muted-foreground / card', t('muted-foreground'), t('card')],
        ['muted-foreground / muted', t('muted-foreground'), t('muted')],
        ['muted-foreground / secondary', t('muted-foreground'), t('secondary')],
        ['muted-foreground / accent', t('muted-foreground'), t('accent')],
        ['muted-foreground / muted à 50 % sur background', t('muted-foreground'), over(t('muted'), 0.5, t('background'))],
        ['primary / background (lien)', t('primary'), t('background')],
        ['primary / card (lien)', t('primary'), t('card')],
        // Survol : `hover:bg-primary/90`, `hover:bg-accent`, `hover:bg-secondary/80` .
        ['primary-foreground / primary à 90 % (survol)', t('primary-foreground'), over(t('primary'), 0.9, t('background'))],
        ['secondary-foreground / secondary à 80 % (survol)', t('secondary-foreground'), over(t('secondary'), 0.8, t('background'))],
        ['foreground / diff ajouté', t('foreground'), t('diff-added')],
        ['foreground / diff retiré', t('foreground'), t('diff-removed')],
        ['foreground / diff modifié', t('foreground'), t('diff-changed')],
      ];
      const failing = pairs.map(([name, fg, bg]) => ({ name, ratio: Number(contrast(fg, bg).toFixed(2)) })).filter(({ ratio }) => ratio < TEXT);
      expect(failing).toEqual([]);
    });

    test(`${theme} : bordures de champ et anneau de focus, 3:1 sur background, card, popover et muted`, () => {
      for (const control of ['input', 'ring'] as const) {
        for (const surface of ['background', 'card', 'popover', 'muted'] as const) {
          expect(contrast(t(control), t(surface)), `${control} / ${surface}`).toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    });

    test(`${theme} : chaque statut a un texte à 4,5:1 sur sa surface et une bordure à 3:1 sur background, card et muted`, () => {
      const failing: string[] = [];
      for (const status of ['enquete', 'sain', 'warning', 'reparation', 'action-requise', 'erreur', 'bloquee']) {
        const ratio = contrast(t(`status-${status}-foreground`), t(`status-${status}`));
        if (ratio < TEXT) failing.push(`${status} : texte ${ratio.toFixed(2)}:1`);
        for (const surface of ['background', 'card', 'muted']) {
          const edge = contrast(t('status-border'), t(surface));
          if (edge < NON_TEXT) failing.push(`${status} : bordure ${edge.toFixed(2)}:1 sur ${surface}`);
        }
      }
      expect(failing).toEqual([]);
    });
  }

  test("l'orange n'est une surface qu'à texte anthracite : destructive et statut erreur, en clair et en sombre", () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const [surface, text] of [['destructive', 'destructive-foreground'], ['status-erreur', 'status-erreur-foreground']] as const) {
        expect(toHex(color(theme, surface)), `${theme} ${surface}`).toBe(toHex(color(theme, 'sym-orange')));
        expect(toHex(color(theme, text)), `${theme} ${text}`).toBe(toHex(color(theme, 'sym-ink')));
      }
    }
  });

  test("le bleu n'est jamais posé sur l'anthracite : aucun jeton sombre de texte, d'icône ou de focus n'est le bleu", () => {
    const blue = toHex(color('light', 'sym-blue'));
    for (const name of ['foreground', 'card-foreground', 'primary', 'ring', 'muted-foreground', 'accent-foreground', 'status-action-requise']) {
      expect(toHex(color('dark', name)), `sombre : --${name}`).not.toBe(blue);
    }
    expect(toHex(color('dark', 'primary'))).toBe(toHex(color('light', 'sym-lilac')));
    expect(toHex(color('dark', 'ring'))).toBe(toHex(color('light', 'sym-lilac')));
  });
});

describe('assert_brand_tokens_contrast : règles de feuille', () => {
  test('theme.css respecte les règles de feuille', () => {
    expect(sheetViolations(themeCss, VARIABLES, 'theme.css')).toEqual([]);
  });

  test('le test détecte une feuille fautive : blanc sur orange, orange en texte, bleu sur anthracite (sombre)', () => {
    const bad = `
      .zz-a { color: #FFFFFF; background-color: var(--sym-orange); }
      .zz-b { color: var(--sym-orange); background: var(--sym-cream); }
      .dark .zz-c { color: var(--sym-blue); background: var(--sym-ink); }
      .zz-d { color: var(--sym-ink); background: var(--sym-orange); }
    `;
    const problems = sheetViolations(bad, VARIABLES, 'zz');
    expect(problems.some((p) => p.includes('.zz-a') && p.includes('orange'))).toBe(true);
    expect(problems.some((p) => p.includes('.zz-b') && p.includes("jamais du texte"))).toBe(true);
    expect(problems.some((p) => p.includes('.zz-c') && p.includes('bleu'))).toBe(true);
    expect(problems.some((p) => p.includes('.zz-d'))).toBe(false);
  });
});
