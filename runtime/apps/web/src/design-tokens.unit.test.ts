// SPDX-License-Identifier: AGPL-3.0-only
// Jetons de la console (06 § 1, WCAG 1.4.3 et 1.4.11, tâches 3.9 et 3.15) : les jetons vivent dans packages/ui (theme.css,
// contrastes jugés par packages/ui/src/tokens.unit.test.ts) ; ce test garde le branchement de la console sur eux : chaque
// jeton est nommé pour Tailwind, chaque statut emploie sa famille de jetons, aucune feuille ni classe ne pose du texte
// blanc sur l'orange, de l'orange en texte ou du bleu sur anthracite, et l'anneau de focus est une règle sans calque.
// axe juge le rendu réel (apps/web/e2e/a11y.e2e.ts) ; ce test garde les couleurs que le rendu de test ne montre pas.
import { describe, expect, test } from 'vitest';
import { listFiles, readSource, sheetViolations } from '@runtime/ui/testing/color-rules';
import { contrast, cssVariables, readText, resolveColor, toHex } from '@runtime/ui/testing/contrast';
import { API_STATUSES, STATUS_TONE } from '@/lib/status';

const mainCss = readText(new URL('./assets/main.css', import.meta.url));
const themeCss = readText(new URL('../../../packages/ui/src/theme.css', import.meta.url));
const ROOT = cssVariables(themeCss, ':root');
const DARK = cssVariables(themeCss, '.dark, .sym-on-ink');
const VARIABLES = { light: ROOT, dark: { ...ROOT, ...DARK } };

/** `--color-nom: var(--jeton);` du bloc `@theme inline` de main.css. */
const colorMap = Object.fromEntries([...mainCss.matchAll(/--color-([\w-]+):\s*var\((--[\w-]+)\);/g)].map((m) => [m[1] ?? '', m[2] ?? '']));

const sourceFiles = (): string[] => listFiles(new URL('.', import.meta.url).pathname, /\.(vue|ts)$/);

describe('branchement de Tailwind sur les jetons de packages/ui', () => {
  test('chaque jeton sémantique de theme.css (sauf formes et ombres) a son nom de couleur, et chaque nom vise un jeton existant', () => {
    const named = new Set(Object.values(colorMap));
    for (const target of named) expect(ROOT[target], target).toBeDefined();
    const colorTokens = Object.keys(ROOT).filter((name) => !name.startsWith('--sym-') && !['--radius', '--shadow-flat-color'].includes(name));
    expect(colorTokens.filter((name) => !named.has(name))).toEqual([]);
  });

  test('la console ne redéfinit aucune couleur : main.css ne contient aucune valeur de couleur', () => {
    expect(mainCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b|oklch\(|rgb\(|hsl\(/);
  });

  test('polices et formes viennent des jetons : Bricolage pour les titres, DM Sans pour le texte, rayons de 10 px, 16 px et 20 px', () => {
    expect(mainCss).toMatch(/--font-sans:\s*var\(--sym-font-sans\)/);
    expect(mainCss).toMatch(/--font-display:\s*var\(--sym-font-display\)/);
    expect(mainCss).toMatch(/--font-mono:\s*var\(--sym-font-mono\)/);
    expect(ROOT['--sym-radius-control']).toBe('10px');
    expect(ROOT['--sym-radius-card']).toBe('20px');
    expect(ROOT['--sym-radius-pill']).toBe('999px');
    expect(ROOT['--sym-shadow-flat']).toBe('0 10px 0 var(--sym-ink)');
  });
});

describe('teintes de statut (lib/status.ts)', () => {
  const family = (status: string): string => status.replace('_', '-');

  test('chaque statut emploie la surface et le texte de sa propre famille, avec la bordure de statut', () => {
    for (const status of API_STATUSES) {
      const tone = STATUS_TONE[status];
      expect(tone, status).toContain(`bg-status-${family(status)} `);
      expect(tone, status).toContain(`text-status-${family(status)}-foreground`);
      expect(tone, status).toContain('border-status-border');
    }
  });

  test('familles de la charte : sain aqua, warning jaune, réparation lilas, action requise bleu (texte papier), erreur orange (texte anthracite), bloquée anthracite (texte papier)', () => {
    const light = (name: string): string => toHex(resolveColor(VARIABLES.light, `var(--${name})`));
    expect(light('status-sain')).toBe(light('sym-aqua'));
    expect(light('status-warning')).toBe(light('sym-yellow'));
    expect(light('status-reparation')).toBe(light('sym-lilac'));
    expect(light('status-action-requise')).toBe(light('sym-blue'));
    expect(light('status-action-requise-foreground')).toBe(light('sym-paper'));
    expect(light('status-erreur')).toBe(light('sym-orange'));
    expect(light('status-erreur-foreground')).toBe(light('sym-ink'));
    expect(light('status-bloquee')).toBe(light('sym-ink'));
    expect(light('status-bloquee-foreground')).toBe(light('sym-paper'));
    expect(light('status-enquete')).toBe(light('sym-paper'));
  });

  test('en sombre, aucune surface de statut n’est le bleu (jamais de bleu sur anthracite)', () => {
    const blue = toHex(resolveColor(VARIABLES.light, 'var(--sym-blue)'));
    for (const status of API_STATUSES) expect(toHex(resolveColor(VARIABLES.dark, `var(--status-${family(status)})`)), status).not.toBe(blue);
  });
});

describe('règles de couleur appliquées aux feuilles et aux classes de la console', () => {
  test('main.css respecte les règles de feuille', () => {
    expect(sheetViolations(mainCss, VARIABLES, 'main.css')).toEqual([]);
  });

  test("aucune classe ne pose du texte blanc ou de l'orange en texte : text-white, text-destructive, text-status-erreur ne sont employés nulle part", () => {
    const orange = (theme: 'light' | 'dark', token: string): boolean => toHex(resolveColor(VARIABLES[theme], `var(${token})`)) === toHex(resolveColor(VARIABLES[theme], 'var(--sym-orange)'));
    const orangeNames = Object.entries(colorMap).filter(([, token]) => orange('light', token) || orange('dark', token)).map(([name]) => name);
    expect(orangeNames).toEqual(expect.arrayContaining(['destructive', 'status-erreur']));
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readSource(file);
      for (const name of orangeNames) if (new RegExp(`(?<![\\w-])(?:[a-z-]+:)*text-${name}(?![\\w-])`).test(source)) offenders.push(`${file} : text-${name}`);
      if (/(?<![\w-])(?:[a-z-]+:)*text-white(?![\w-])/.test(source)) offenders.push(`${file} : text-white`);
    }
    expect(offenders).toEqual([]);
  });

  test('toute surface orange de la console porte un texte anthracite (classes bg-destructive et bg-status-erreur)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const match of readSource(file).matchAll(/["'`]([^"'`]*\bbg-(?:destructive|status-erreur)\b[^"'`]*)["'`]/g)) {
        const classes = match[1] ?? '';
        if (!/\btext-(?:destructive-foreground|status-erreur-foreground)\b/.test(classes)) offenders.push(`${file} : « ${classes.trim().slice(0, 80)} »`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('anneau de focus', () => {
  test('une règle sans calque pose un anneau opaque de 2 px sur tout :focus-visible (l’emporte sur `outline-none` des composants)', () => {
    const rule = /:focus-visible:not\(\[tabindex="-1"\]\)\s*\{([^}]*)\}/.exec(themeCss)?.[1] ?? '';
    expect(rule).toMatch(/outline:\s*2px solid var\(--ring\)/);
    expect(rule).toMatch(/outline-offset:\s*2px/);
    expect(mainCss).not.toMatch(/:focus-visible/);
  });

  test('l’anneau est à 3:1 au moins sur chaque fond, en clair et en sombre', () => {
    for (const theme of ['light', 'dark'] as const) {
      const ring = resolveColor(VARIABLES[theme], 'var(--ring)');
      for (const surface of ['background', 'card', 'popover', 'muted']) {
        expect(contrast(ring, resolveColor(VARIABLES[theme], `var(--${surface})`)), `${theme} ring / ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
    // La barre anthracite (`sym-on-ink`) porte les jetons sombres, anneau lilas compris, même dans le thème clair.
    expect(contrast(resolveColor(VARIABLES.dark, 'var(--ring)'), resolveColor(VARIABLES.dark, 'var(--nav)'))).toBeGreaterThanOrEqual(3);
  });
});
