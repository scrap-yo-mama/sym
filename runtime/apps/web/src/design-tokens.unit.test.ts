// SPDX-License-Identifier: AGPL-3.0-only
// Jetons de la console (06 § 1, WCAG 1.4.3 et 1.4.11, tâches 3.9 et 3.15) : les jetons vivent dans packages/ui (theme.css,
// contrastes jugés par packages/ui/src/tokens.unit.test.ts) ; ce test garde le branchement de la console sur eux : chaque
// jeton est nommé pour Tailwind, chaque statut emploie sa famille de jetons, aucune feuille ni classe ne pose du texte
// blanc sur l'orange, de l'orange en texte ou du bleu sur anthracite, et l'anneau de focus est une règle sans calque.
// axe juge le rendu réel (apps/web/e2e/a11y.e2e.ts) ; ce test garde les couleurs que le rendu de test ne montre pas.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { expandApply, inkZoneViolations, listFiles, readSource, sheetViolations } from '@runtime/ui/testing/color-rules';
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

const runtimeRoot = new URL('../../../', import.meta.url).pathname;
/** Toutes les feuilles de style des interfaces : console, extension et packages/ui (hors builds, rapports et outils de test). */
const styleSheets = (): string[] =>
  ['apps/web', 'apps/extension', 'packages/ui'].flatMap((dir) =>
    listFiles(join(runtimeRoot, dir), /\.css$/, /(^|\/)(node_modules|dist|\.wxt|\.output|testing|e2e|coverage|test-results|playwright-report|blob-report)(\/|$)/),
  );

describe('branchement de Tailwind sur les jetons de packages/ui', () => {
  test('chaque jeton sémantique de theme.css (sauf formes et ombres) a son nom de couleur, et chaque nom vise un jeton existant', () => {
    const named = new Set(Object.values(colorMap));
    for (const target of named) expect(ROOT[target], target).toBeDefined();
    const colorTokens = Object.keys(ROOT).filter((name) => !name.startsWith('--sym-') && !['--radius', '--shadow-flat-color'].includes(name));
    expect(colorTokens.filter((name) => !named.has(name))).toEqual([]);
  });

  test('une seule couche CSS d’animations, celle de packages/ui (20 § 4.3) : main.css n’importe aucune bibliothèque d’animations', () => {
    const imports = [...mainCss.matchAll(/@import\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(['tailwindcss', '@runtime/ui/theme.css']);
    const manifest = JSON.parse(readSource(join(runtimeRoot, 'apps/web/package.json'))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter((name) => /animat/i.test(name))).toEqual([]);
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
  test('chaque feuille de apps/web, apps/extension et packages/ui respecte les règles de feuille, classes des @apply comprises', () => {
    const sheets = styleSheets();
    const relative = sheets.map((file) => file.replace(runtimeRoot, ''));
    expect(relative).toEqual(expect.arrayContaining(['apps/web/src/assets/main.css', 'apps/extension/src/entrypoints/popup/popup.css', 'packages/ui/src/theme.css', 'packages/ui/src/fonts.css']));
    const problems = sheets.flatMap((file) => sheetViolations(expandApply(readSource(file), colorMap), VARIABLES, file.replace(runtimeRoot, '')));
    expect(problems).toEqual([]);
  });

  test('les classes des @apply et des @utility sont lues : un @apply qui pose de l’orange en texte, du blanc sur l’orange ou du bleu sur anthracite est refusé', () => {
    const bad = `
      @utility zz-error { @apply rounded-md bg-destructive px-2 text-primary-foreground; }
      .zz-text { @apply text-sm text-destructive; }
      .dark .zz-link { @apply text-[var(--sym-blue)] underline; }
      .zz-bar { @apply bg-status-bloquee; }
      .zz-bar a { @apply text-ring; }
    `;
    const problems = sheetViolations(expandApply(bad, colorMap), VARIABLES, 'zz');
    expect(problems.some((p) => p.includes('.zz-error') && p.includes('orange'))).toBe(true);
    expect(problems.some((p) => p.includes('.zz-text') && p.includes('jamais du texte'))).toBe(true);
    expect(problems.some((p) => p.includes('.dark .zz-link') && p.includes('bleu'))).toBe(true);
    expect(problems.some((p) => p.includes('.zz-bar a') && p.includes('bleu'))).toBe(true);
    expect(sheetViolations(expandApply('.zz-ok { @apply bg-destructive text-destructive-foreground; }', colorMap), VARIABLES, 'zz')).toEqual([]);
  });

  test('zones anthracite (bg-nav, bg-status-bloquee) : sans `sym-on-ink`, aucune classe bleue (primary, ring, action requise) sur l’élément ni dans ses descendants', () => {
    expect(sourceFiles().flatMap((file) => inkZoneViolations(readSource(file), file.replace(runtimeRoot, '')))).toEqual([]);
    const bad = [
      '<header class="bg-nav text-nav-foreground"><a class="text-primary underline">x</a></header>',
      '<div class="bg-status-bloquee text-status-bloquee-foreground"><p><span class="focus-visible:ring-primary">x</span></p></div>',
      "const tone = 'bg-status-bloquee text-primary';",
      '<nav class="bg-nav"><div><div></div><button class="border-ring">x</button></div></nav>',
    ];
    for (const source of bad) expect(inkZoneViolations(source, 'zz').length, source).toBeGreaterThan(0);
    const good = [
      '<header class="sym-on-ink bg-nav"><a class="text-primary">x</a></header>',
      '<div class="bg-status-bloquee text-status-bloquee-foreground"></div><p class="text-primary">après la zone</p>',
      "const tone = 'border-status-border bg-status-bloquee text-status-bloquee-foreground';",
    ];
    for (const source of good) expect(inkZoneViolations(source, 'zz'), source).toEqual([]);
  });

  test('l’orange est une surface seulement : aucune bordure, aucun anneau ni contour orange (2:1 sur crème), même à opacité réduite', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const match of readSource(file).matchAll(/(?<![\w-])(?:[a-z-]+:)*(?:border|ring|outline|decoration|divide|ring-offset)(?:-[trblxy])?-(?:destructive|status-erreur)(?:\/\d+)?(?![\w-])/g)) {
        offenders.push(`${file.replace(runtimeRoot, '')} : ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('champs de la refonte : aucun anneau shadcn à 50 % (ring-ring/50), et chaque champ bordé (border-input) a 44 px de haut (h-11), comme Input', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readSource(file);
      for (const match of source.matchAll(/(?<![\w-])(?:[a-z-]+:)*ring-ring\/\d+(?![\w-])/g)) offenders.push(`${file.replace(runtimeRoot, '')} : ${match[0]}`);
      for (const match of source.matchAll(/["'`]([^"'`]*\bborder-input\b[^"'`]*)["'`]/g)) {
        if (/(?<![\w:-])h-(?:[0-9]|10)(?![\w-])/.test(match[1] ?? '')) offenders.push(`${file.replace(runtimeRoot, '')} : « ${(match[1] ?? '').trim().slice(0, 60)} »`);
      }
    }
    expect(offenders).toEqual([]);
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
