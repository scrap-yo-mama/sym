// SPDX-License-Identifier: AGPL-3.0-only
// Calcul de contraste WCAG 2.x (1.4.3, 1.4.11) à partir des jetons de la console, écrits en OKLCH (main.css) ou lus dans la
// palette de Tailwind (theme.css). Aucune dépendance : conversion OKLab → sRGB linéaire (Björn Ottosson), rognage dans le gamut
// sRGB comme le fait le navigateur, luminance relative et rapport de contraste de WCAG.
import { readFileSync } from 'node:fs';

export type Rgb = { r: number; g: number; b: number };

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const inGamut = (rgb: Rgb): boolean => [rgb.r, rgb.g, rgb.b].every((channel) => channel >= -1e-6 && channel <= 1 + 1e-6);

function oklabToLinear(lightness: number, a: number, b: number): Rgb {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/**
 * `oklch(L C H)` ou `oklch(L% C H)` → sRGB linéaire dans [0, 1]. Une couleur hors du gamut sRGB est ramenée dedans en
 * réduisant la chroma à clarté et teinte constantes (principe du rognage CSS Color 4), comme le fait Chromium.
 */
export function oklchToLinear(text: string): Rgb {
  const match = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/[^)]*)?\)/.exec(text);
  if (!match) throw new Error(`couleur oklch illisible : ${text}`);
  const lightness = Number(match[1]) / (match[2] === '%' ? 100 : 1);
  const chroma = Number(match[3]);
  const hue = (Number(match[4]) * Math.PI) / 180;
  const at = (c: number): Rgb => oklabToLinear(lightness, c * Math.cos(hue), c * Math.sin(hue));
  let result = at(chroma);
  if (!inGamut(result)) {
    let low = 0;
    let high = chroma;
    for (let step = 0; step < 40; step += 1) {
      const middle = (low + high) / 2;
      if (inGamut(at(middle))) low = middle;
      else high = middle;
    }
    result = at(low);
  }
  return { r: clamp01(result.r), g: clamp01(result.g), b: clamp01(result.b) };
}

/** Blanc, noir : valeurs littérales de CSS. */
export const WHITE: Rgb = { r: 1, g: 1, b: 1 };
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Composition d'une couleur à opacité `alpha` sur un fond opaque (`bg-muted/50`, `ring-ring/50`), en sRGB gamma-encodé comme le navigateur. */
export function over(foreground: Rgb, alpha: number, background: Rgb): Rgb {
  const mix = (f: number, b: number): number => toLinear(alpha * toGamma(f) + (1 - alpha) * toGamma(b));
  return { r: mix(foreground.r, background.r), g: mix(foreground.g, background.g), b: mix(foreground.b, background.b) };
}

const toGamma = (linear: number): number => (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);
const toLinear = (gamma: number): number => (gamma <= 0.04045 ? gamma / 12.92 : ((gamma + 0.055) / 1.055) ** 2.4);

/** Luminance relative de WCAG ; les canaux sont arrondis à 8 bits comme à l'écran. */
function luminance(color: Rgb): number {
  const channel = (linear: number): number => toLinear(Math.round(toGamma(linear) * 255) / 255);
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Rapport de contraste de WCAG entre deux couleurs opaques, de 1 à 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Variables CSS `--nom: valeur;` déclarées dans le bloc `selector { … }` d'une feuille de style. */
export function cssVariables(css: string, selector: string): Record<string, string> {
  const escaped = selector
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
  const block = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]));
}

export const readText = (url: URL): string => readFileSync(url, 'utf8');

/** `#RRGGBB` ou `#RGB` → sRGB linéaire. */
export function hexToLinear(text: string): Rgb {
  const digits = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text.trim())?.[1];
  if (!digits) throw new Error(`couleur hexadécimale illisible : ${text}`);
  const full = digits.length === 3 ? [...digits].map((c) => c + c).join('') : digits;
  const channel = (offset: number): number => toLinear(parseInt(full.slice(offset, offset + 2), 16) / 255);
  return { r: channel(0), g: channel(2), b: channel(4) };
}

/** Valeur d'un jeton : `#hex`, `oklch(…)` ou `var(--autre)` (résolu dans `variables`, jusqu'à 8 renvois). */
export function resolveColor(variables: Record<string, string>, value: string, depth = 0): Rgb {
  if (depth > 8) throw new Error(`renvoi de jeton trop profond : ${value}`);
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim())?.[1];
  if (reference) {
    const next = variables[reference];
    if (next === undefined) throw new Error(`jeton absent : ${reference}`);
    return resolveColor(variables, next, depth + 1);
  }
  return value.trim().startsWith('#') ? hexToLinear(value) : oklchToLinear(value);
}

/** Couleur de 8 bits « #rrggbb » d'une couleur linéaire (pour comparer deux jetons sans se soucier de la notation). */
export function toHex(color: Rgb): string {
  const part = (linear: number): string => Math.round(toGamma(linear) * 255).toString(16).padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`.toUpperCase();
}
