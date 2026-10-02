// SPDX-License-Identifier: AGPL-3.0-only
// Rendu des visuels de la vitrine (22 §3.3, u8 R4) : les sources SVG versionnées de `.github/assets/src/` sont rendues en PNG
// par Chromium (déjà une dépendance du monorepo), avec les polices OFL auto-hébergées de `packages/ui`. Aucun service tiers.
// Les PNG sont versionnés : le rendu n'est PAS rejoué en CI (la rastérisation varie d'une plateforme à l'autre) ; la CI
// contrôle leurs propriétés (dimensions, poids, fond opaque, marges), pas leurs pixels.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetsDir, runtimeDir } from './paths.ts';

export type RenderJob = { source: string; output: string; width: number; height: number; background: string; replace?: Record<string, string> };

/** Phrases localisées de l'aperçu social et des images OG (même source SVG, texte seul remplacé). */
const OG_TEXT = {
  en: { line1: 'Describe the data.', line2: 'SYM handles the rest.' },
  fr: { line1: 'Décris les données.', line2: "SYM s'occupe du reste." },
} as const;

export const RENDER_JOBS: RenderJob[] = [
  { source: 'src/banner-light.svg', output: 'brand/banner-light.png', width: 1600, height: 400, background: '#F3EEE6' },
  { source: 'src/banner-dark.svg', output: 'brand/banner-dark.png', width: 1600, height: 400, background: '#24252D' },
  { source: 'src/social-preview.svg', output: 'brand/social-preview.png', width: 1280, height: 640, background: '#FBF8F3' },
  { source: 'src/social-preview.svg', output: 'brand/og-en.png', width: 1200, height: 630, background: '#FBF8F3', replace: OG_TEXT.en },
  { source: 'src/social-preview.svg', output: 'brand/og-fr.png', width: 1200, height: 630, background: '#FBF8F3', replace: OG_TEXT.fr },
];

const FONT_DIR = join(runtimeDir, 'packages', 'ui', 'fonts');
const FONTS = [
  ['Bricolage Grotesque', 800, 'bricolage-grotesque-latin-800-normal.woff2'],
  ['DM Sans', 400, 'dm-sans-latin-400-normal.woff2'],
  ['DM Sans', 700, 'dm-sans-latin-700-normal.woff2'],
  ['JetBrains Mono', 600, 'jetbrains-mono-latin-600-normal.woff2'],
] as const;

/** Source du SVG avec les lignes d'accroche remplacées (les identifiants `line1` et `line2` de la source). */
export function localizedSvg(svg: string, replace: Record<string, string>): string {
  let out = svg;
  for (const [id, value] of Object.entries(replace)) {
    const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    out = out.replace(new RegExp(`(<text id="${id}"[^>]*>)[^<]*(</text>)`), `$1${escaped}$2`);
  }
  return out;
}

export async function renderAssets(jobs: readonly RenderJob[] = RENDER_JOBS): Promise<string[]> {
  const { chromium } = await import('playwright-core');
  const dir = mkdtempSync(join(tmpdir(), 'zz_test_vitrine-'));
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    const faces = FONTS.map(([family, weight, file]) => `@font-face { font-family: '${family}'; font-weight: ${weight}; src: url('${pathToFileURL(join(FONT_DIR, file)).href}') format('woff2'); }`).join('\n');
    for (const job of jobs) {
      const svg = localizedSvg(readFileSync(join(assetsDir, job.source), 'utf8'), job.replace ?? {}).replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
        const cleaned = attrs.replace(/\s(?:width|height)="[^"]*"/g, '');
        return `<svg${cleaned} width="${job.width}" height="${job.height}" preserveAspectRatio="xMidYMid meet">`;
      });
      const page = join(dir, 'page.html');
      writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${faces}\nhtml,body{margin:0;background:${job.background};}svg{display:block;}</style>${svg}`);
      const context = await browser.newContext({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
      const tab = await context.newPage();
      await tab.goto(pathToFileURL(page).href);
      // Expressions en chaîne : ce script Node n'a pas les types du DOM.
      await tab.evaluate('Promise.all([document.fonts.load(\'800 20px "Bricolage Grotesque"\'), document.fonts.load(\'600 20px "JetBrains Mono"\')]).then(() => document.fonts.ready).then(() => 0)');
      const fontsReady = await tab.evaluate('document.fonts.check(\'800 20px "Bricolage Grotesque"\') && document.fonts.check(\'600 20px "JetBrains Mono"\')');
      if (!fontsReady) throw new Error(`polices non chargées pour ${job.output}`);
      const target = join(assetsDir, job.output);
      mkdirSync(join(target, '..'), { recursive: true });
      await tab.screenshot({ path: target, type: 'png', clip: { x: 0, y: 0, width: job.width, height: job.height } });
      await context.close();
      written.push(job.output);
    }
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return written;
}
