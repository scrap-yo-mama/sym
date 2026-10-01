// SPDX-License-Identifier: AGPL-3.0-only
// Règles de couleur de la charte (20 § 1.3, 20b § 3.1), appliquées aux feuilles de style et aux sources : aucune couleur en
// dur hors des jetons de packages/ui ; jamais de blanc sur l'orange, d'orange en texte, ni de bleu sur anthracite.
// Outil de test seulement (assert_brand_tokens_contrast, assert_no_hardcoded_colors).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast, resolveColor, toHex, type Rgb } from './contrast.ts';

/** Fichiers d'un dossier, récursivement, dont le nom correspond à `pattern` ; `skip` écarte des dossiers entiers. */
export function listFiles(dir: string, pattern: RegExp, skip: RegExp = /(^|\/)(node_modules|dist|\.wxt|\.output|testing|e2e|__snapshots__)(\/|$)/): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (skip.test(full)) return [];
    return entry.isDirectory() ? listFiles(full, pattern, skip) : pattern.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

const PALETTE = '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)';
const UTILITY = '(?:bg|text|border|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|divide|placeholder|accent|shadow|caret|inset-ring)';
const NAMED = '(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|brown|cyan|magenta|silver|gold|navy|teal|lime|maroon|olive|aqua|fuchsia|indigo|violet|crimson|coral|salmon|tomato|beige|ivory|khaki|lavender)';

/** Une règle par forme de couleur écrite en dur : motif et nom lisible. */
const HARDCODED: readonly { name: string; pattern: RegExp }[] = [
  { name: 'couleur hexadécimale', pattern: /(?<![\w&/"'=-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g },
  { name: 'couleur hexadécimale entre guillemets', pattern: /['"]#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})['"]/g },
  { name: 'fonction de couleur', pattern: /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/g },
  { name: 'classe de la palette de Tailwind', pattern: new RegExp(`(?<![\\w-])(?:[a-z-]+:)*-?${UTILITY}-${PALETTE}-\\d{2,3}(?:/\\d+)?(?![\\w-])`, 'g') },
  { name: 'classe blanc ou noir de Tailwind', pattern: new RegExp(`(?<![\\w-])(?:[a-z-]+:)*${UTILITY}-(?:white|black)(?:/\\d+)?(?![\\w-])`, 'g') },
  { name: 'couleur nommée dans une déclaration', pattern: new RegExp(`(?:^|[;{\\s])(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|caret-color|accent-color)\\s*:\\s*${NAMED}\\b`, 'gim') },
  { name: 'attribut de couleur SVG nommé', pattern: new RegExp(`\\b(?:fill|stroke|stop-color|flood-color)=["']${NAMED}["']`, 'g') },
];

export type Finding = { file: string; line: number; rule: string; text: string };

/** Couleurs en dur d'un texte source (commentaires non retirés : un exemple de couleur dans un commentaire se réécrit). */
export function hardcodedColors(source: string, file: string): Finding[] {
  const findings: Finding[] = [];
  for (const { name, pattern } of HARDCODED) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      findings.push({ file, line, rule: name, text: match[0].trim() });
    }
  }
  return findings;
}

const WHITE_LINEAR: Rgb = { r: 1, g: 1, b: 1 };
const isNear = (a: Rgb, b: Rgb): boolean => toHex(a) === toHex(b);

/**
 * Règles de feuille : pour chaque bloc de règle qui pose `color` et/ou `background`, résolu dans les jetons du thème
 * (`.dark` et `.sym-on-ink` : sombre ; sinon clair), le texte n'est ni blanc sur l'orange, ni orange (jamais en texte),
 * ni bleu sur anthracite. Les valeurs non résolubles (`inherit`, `currentColor`, `transparent`) sont ignorées.
 */
export function sheetViolations(css: string, variables: { light: Record<string, string>; dark: Record<string, string> }, file = 'feuille'): string[] {
  const palette = (vars: Record<string, string>) => ({
    orange: resolveColor(vars, vars['--sym-orange'] ?? '#FF5A1F'),
    blue: resolveColor(vars, vars['--sym-blue'] ?? '#3A33F0'),
    ink: resolveColor(vars, vars['--sym-ink'] ?? '#24252D'),
  });
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const problems: string[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim();
    const body = match[2] ?? '';
    if (selector.startsWith('@')) continue;
    const dark = /\.dark\b|\.sym-on-ink\b|\[data-theme=['"]?dark/.test(selector);
    const vars = dark ? variables.dark : variables.light;
    const colors = palette(vars);
    const read = (property: RegExp): Rgb | undefined => {
      const value = new RegExp(`(?:^|[;\\s])${property.source}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1]?.trim();
      if (!value) return undefined;
      try {
        return /^#|^var\(|^oklch\(/.test(value) ? resolveColor(vars, value) : /^(white)$/i.test(value) ? WHITE_LINEAR : undefined;
      } catch {
        return undefined;
      }
    };
    const fg = read(/color/);
    const bg = read(/background(?:-color)?/);
    const where = `${file} « ${selector.replace(/\s+/g, ' ')} »`;
    if (fg && isNear(fg, colors.orange)) problems.push(`${where} : l'orange n'est jamais du texte`);
    if (fg && bg && isNear(bg, colors.orange) && contrast(fg, bg) < 4.5) problems.push(`${where} : texte à ${contrast(fg, bg).toFixed(2)}:1 sur l'orange (anthracite seulement)`);
    if (fg && bg && isNear(fg, WHITE_LINEAR) && isNear(bg, colors.orange)) problems.push(`${where} : jamais de blanc sur l'orange`);
    if (fg && bg && isNear(fg, colors.blue) && isNear(bg, colors.ink)) problems.push(`${where} : jamais de bleu sur l'anthracite`);
  }
  return problems;
}

export const readSource = (file: string): string => readFileSync(file, 'utf8');
