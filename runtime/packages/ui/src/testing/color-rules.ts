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
  // Entre guillemets (attribut SVG `fill="#fff"`, chaîne `'#000'`) : 3, 4, 6 ou 8 chiffres. Un sélecteur d'identifiant dont le nom
  // s'écrit en chiffres hexadécimaux (`'#add'`) est refusé aussi : il se renomme.
  { name: 'couleur hexadécimale entre guillemets', pattern: /['"]#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})['"]/g },
  { name: 'fonction de couleur', pattern: /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/g },
  { name: 'classe de la palette de Tailwind', pattern: new RegExp(`(?<![\\w-])(?:[a-z-]+:)*-?${UTILITY}-${PALETTE}-\\d{2,3}(?:/\\d+)?(?![\\w-])`, 'g') },
  { name: 'classe blanc ou noir de Tailwind', pattern: new RegExp(`(?<![\\w-])(?:[a-z-]+:)*${UTILITY}-(?:white|black)(?:/\\d+)?(?![\\w-])`, 'g') },
  { name: 'couleur nommée dans une déclaration', pattern: new RegExp(`(?:^|[;{\\s])(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|caret-color|accent-color)\\s*:\\s*${NAMED}\\b`, 'gim') },
  // Ombres de Tailwind (`shadow-xs` à `shadow-2xl`) : un rgb noir écrit en dur dans Tailwind, contraire aux ombres plates
  // de la charte (`shadow-flat`, jeton `--shadow-flat-color`).
  { name: 'ombre de Tailwind', pattern: /(?<![\w-])(?:[a-z-]+:)*shadow-(?:2xs|xs|sm|md|lg|xl|2xl)(?![\w-])/g },
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

type Variables = { light: Record<string, string>; dark: Record<string, string> };
type Block = { selectors: string[]; body: string };

/** Un sélecteur marqué sombre : `.dark`, `.sym-on-ink` ou `[data-theme=dark]` (une négation `:not(.dark)` ne compte pas). */
const isDarkSelector = (selector: string): boolean => /\.dark\b|\.sym-on-ink\b|\[data-theme=['"]?dark/.test(selector.replace(/:not\([^)]*\)/g, ''));

/** Sélecteurs ancêtres d'un sélecteur composé, du plus proche au plus lointain : `.a .b > c` → `.a .b`, `.a`. */
function ancestors(selector: string): string[] {
  const parts = selector.trim().split(/\s*[\s>+~]\s*/).filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i -= 1) {
    // Le préfixe se relit dans le texte d'origine pour garder ses combinateurs.
    const prefix = parts.slice(0, i);
    const pattern = new RegExp(`^\\s*${prefix.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*[\\s>+~]\\s*')}`);
    const text = pattern.exec(selector)?.[0]?.trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * Règles de feuille : pour chaque sélecteur d'un bloc qui pose `color` et/ou `background`, résolu dans les jetons du thème,
 * le texte n'est ni blanc sur l'orange, ni orange (jamais en texte), ni bleu sur anthracite. Un sélecteur marqué sombre
 * (`.dark`, `.sym-on-ink`) est jugé en sombre ; un sélecteur sans marque, en clair ET en sombre (les jetons changent, la règle
 * reste). Le fond d'un texte sans fond propre se lit sur la règle ancêtre la plus proche qui en pose un (`.nav` pour
 * `.nav a`, même dans un autre bloc), à défaut sur `--background` du thème jugé (anthracite en sombre et dans `.sym-on-ink`).
 * Les valeurs non résolubles (`inherit`, `currentColor`, `transparent`) sont ignorées. Limite : la cascade réelle (ordre,
 * spécificité, héritage entre composants) n'est pas rejouée ; axe juge le rendu (apps/web/e2e/a11y.e2e.ts).
 */
export function sheetViolations(css: string, variables: Variables, file = 'feuille'): string[] {
  const palette = (vars: Record<string, string>) => ({
    orange: resolveColor(vars, vars['--sym-orange'] ?? '#FF5A1F'),
    blue: resolveColor(vars, vars['--sym-blue'] ?? '#3A33F0'),
    ink: resolveColor(vars, vars['--sym-ink'] ?? '#24252D'),
  });
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: Block[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim();
    if (selector.startsWith('@')) continue;
    blocks.push({ selectors: selector.split(',').map((part) => part.trim()).filter(Boolean), body: match[2] ?? '' });
  }
  const declared = (body: string, property: RegExp): string | undefined => new RegExp(`(?:^|[;\\s])${property.source}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1]?.trim();
  const resolve = (vars: Record<string, string>, value: string | undefined): Rgb | undefined => {
    if (!value) return undefined;
    try {
      return /^#|^var\(|^oklch\(/.test(value) ? resolveColor(vars, value) : /^(white)$/i.test(value) ? WHITE_LINEAR : undefined;
    } catch {
      return undefined;
    }
  };
  const BG = /background(?:-color)?/;
  const problems = new Set<string>();
  for (const block of blocks) {
    const fgValue = declared(block.body, /color/);
    const bgValue = declared(block.body, BG);
    if (!fgValue && !bgValue) continue;
    for (const selector of block.selectors) {
      const themes: ('light' | 'dark')[] = isDarkSelector(selector) ? ['dark'] : ['light', 'dark'];
      for (const theme of themes) {
        const vars = variables[theme];
        const colors = palette(vars);
        const fg = resolve(vars, fgValue);
        let bg = resolve(vars, bgValue);
        if (fg && !bg) {
          for (const ancestor of ancestors(selector)) {
            const owner = blocks.find((candidate) => candidate.selectors.includes(ancestor) && resolve(vars, declared(candidate.body, BG)));
            if (owner) {
              bg = resolve(vars, declared(owner.body, BG));
              break;
            }
          }
          bg ??= resolve(vars, 'var(--background)');
        }
        const where = `${file} « ${selector.replace(/\s+/g, ' ')} »${themes.length > 1 ? ` (${theme === 'light' ? 'clair' : 'sombre'})` : ''}`;
        if (fg && isNear(fg, colors.orange)) problems.add(`${where} : l'orange n'est jamais du texte`);
        if (fg && bg && isNear(bg, colors.orange) && !isNear(fg, colors.orange) && contrast(fg, bg) < 4.5) problems.add(`${where} : texte à ${contrast(fg, bg).toFixed(2)}:1 sur l'orange (anthracite seulement)`);
        if (fg && bg && isNear(fg, WHITE_LINEAR) && isNear(bg, colors.orange)) problems.add(`${where} : jamais de blanc sur l'orange`);
        if (fg && bg && isNear(fg, colors.blue) && isNear(bg, colors.ink)) problems.add(`${where} : jamais de bleu sur l'anthracite`);
      }
    }
  }
  return [...problems];
}

/**
 * Déplie les `@apply` d'une feuille Tailwind en déclarations lisibles par `sheetViolations` : `text-<nom>` → `color`,
 * `bg-<nom>` → `background-color`, d'après `colorMap` (nom Tailwind → jeton, bloc `@theme inline`) ; `text-[var(--x)]` et
 * `bg-[var(--x)]` sont lus aussi. Une classe à variante (`hover:`, `dark:`) ou à opacité (`/50`) n'est pas dépliée.
 * `@utility nom` devient le sélecteur `.nom`.
 */
export function expandApply(css: string, colorMap: Record<string, string>): string {
  return css
    .replace(/@utility\s+([\w-]+)\s*\{/g, '.$1 {')
    .replace(/@apply\s+([^;]+);/g, (_all, list: string) => {
      const declarations: string[] = [];
      for (const name of list.trim().split(/\s+/)) {
        const match = /^(text|bg)-(?:\[(var\(--[\w-]+\))\]|([\w-]+))$/.exec(name);
        if (!match) continue;
        const token = match[2] ?? (colorMap[match[3] ?? ''] ? `var(${colorMap[match[3] ?? '']})` : undefined);
        if (token) declarations.push(`${match[1] === 'text' ? 'color' : 'background-color'}: ${token};`);
      }
      return declarations.join(' ');
    });
}

const INK_ZONE = /(?<![\w-])bg-(?:nav|status-bloquee)(?![\w-])/;
const BLUE_CLASS = /(?<![\w-])(?:[a-z-]+:)*(?:text|bg|border|ring|ring-offset|outline|decoration|fill|stroke|caret|accent|divide)(?:-[trblxy])?-(?:primary|ring|status-action-requise)(?![\w-])/;

/**
 * Zones anthracite des gabarits et des chaînes de classes : un élément `bg-nav` ou `bg-status-bloquee` sans `sym-on-ink`
 * garde les jetons clairs, où `primary`, `ring` et `status-action-requise` sont bleus : ni lui ni ses descendants (dans le
 * même gabarit) ne portent alors une classe de ces familles. Limite : un descendant venu d'un autre composant (bouton par
 * défaut) n'est pas vu ; `sym-on-ink` sur la zone est la seule parade sûre.
 */
export function inkZoneViolations(source: string, file: string): string[] {
  const problems: string[] = [];
  // Chaîne de classes (lib/status.ts, objets de variantes) : l'élément lui-même.
  for (const match of source.matchAll(/["'`]([^"'`<>]*)["'`]/g)) {
    const classes = match[1] ?? '';
    if (INK_ZONE.test(classes) && !/\bsym-on-ink\b/.test(classes) && BLUE_CLASS.test(classes)) problems.push(`${file} : « ${classes.trim().slice(0, 80)} »`);
  }
  // Gabarit : l'élément et son sous-arbre, jusqu'à la balise fermante de même nom.
  for (const match of source.matchAll(/<([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [opening, tag = '', attributes = ''] = match;
    const classes = [...attributes.matchAll(/(?:^|\s):?class="([^"]*)"/g)].map((m) => m[1] ?? '').join(' ');
    if (!INK_ZONE.test(classes) || /\bsym-on-ink\b/.test(classes)) continue;
    let subtree = opening;
    if (!opening.endsWith('/>')) {
      const rest = source.slice((match.index ?? 0) + opening.length);
      const tags = new RegExp(`<(/?)${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*?(/?)>`, 'g');
      let depth = 1;
      let close = rest.length;
      for (const inner of rest.matchAll(tags)) {
        if (inner[2] === '/') continue;
        depth += inner[1] === '/' ? -1 : 1;
        if (depth === 0) {
          close = (inner.index ?? 0) + inner[0].length;
          break;
        }
      }
      subtree += rest.slice(0, close);
    }
    const blue = BLUE_CLASS.exec(subtree);
    if (blue) problems.push(`${file} : « ${blue[0]} » dans une zone anthracite <${tag}> sans sym-on-ink`);
  }
  return problems;
}

export const readSource = (file: string): string => readFileSync(file, 'utf8');
