// SPDX-License-Identifier: AGPL-3.0-only
// Contrôles des visuels de la vitrine (22 §3.3, 22b §3) : poids, dimensions, fond opaque, marges, SVG sûrs, licences, secrets.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { svgProblems as svgSafetyProblems } from '../../../packages/ui/src/testing/svg-safe.ts';
import { isOpaque, marginViolations, parseGif, parsePng } from './images.ts';
import { assetsDir, runtimeDir } from './paths.ts';
import { marksProblems, type Budgets } from './readme.ts';

function assetFiles(dir = assetsDir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...assetFiles(full));
    else out.push(full);
  }
  return out.sort();
}

const rel = (path: string, dir: string): string => relative(dir, path).split('\\').join('/');
const num = (budgets: Budgets, key: string): number => Number(budgets.assets[key]);

/** Poids : SVG, bandeaux, aperçu social, images OG, GIF, ensemble (22 §3.3). */
export function sizeProblems(budgets: Budgets, dir = assetsDir): string[] {
  const problems: string[] = [];
  const files = assetFiles(dir);
  let total = 0;
  for (const file of files) {
    const name = rel(file, dir);
    const bytes = statSync(file).size;
    total += bytes;
    const limit =
      name.endsWith('.svg') ? num(budgets, 'svgMaxBytes')
      : /^brand\/banner-(light|dark)\.png$/.test(name) ? num(budgets, 'bannerMaxBytes')
      : name === 'brand/social-preview.png' ? num(budgets, 'socialPreviewMaxBytes') - 1
      : /^brand\/og-(en|fr)\.png$/.test(name) ? num(budgets, 'ogMaxBytes')
      : name.endsWith('.gif') ? num(budgets, 'gifMaxBytes')
      : undefined;
    if (limit !== undefined && bytes > limit) problems.push(`${name} : ${bytes} octets (maximum ${limit})`);
  }
  if (total > num(budgets, 'totalMaxBytes')) problems.push(`.github/assets : ${total} octets (maximum ${num(budgets, 'totalMaxBytes')})`);
  return problems;
}

/** `social-preview.png` : 1280×640 exactement, < 400 Ko, fond opaque crème uni, marge de 64 px (22 §3.3). */
export function socialPreviewProblems(budgets: Budgets, path = join(assetsDir, 'brand/social-preview.png')): string[] {
  const problems: string[] = [];
  const buffer = readFileSync(path);
  const png = parsePng(buffer);
  if (png.width !== num(budgets, 'socialPreviewWidth') || png.height !== num(budgets, 'socialPreviewHeight')) problems.push(`${png.width}×${png.height} (attendu ${num(budgets, 'socialPreviewWidth')}×${num(budgets, 'socialPreviewHeight')})`);
  if (buffer.length >= num(budgets, 'socialPreviewMaxBytes')) problems.push(`${buffer.length} octets (moins de ${num(budgets, 'socialPreviewMaxBytes')})`);
  if (!isOpaque(buffer)) problems.push('fond non opaque');
  const bad = marginViolations(buffer, String(budgets.assets['socialPreviewBackground']), num(budgets, 'socialPreviewMargin'));
  if (bad.length > 0) problems.push(`marge de ${num(budgets, 'socialPreviewMargin')} px non unie (fond ${String(budgets.assets['socialPreviewBackground'])}) : ${bad.map((b) => `(${b.x},${b.y})=${b.color}`).join(' ')}`);
  return problems;
}

export function bannerProblems(budgets: Budgets, dir = assetsDir): string[] {
  const problems: string[] = [];
  const files = assetFiles(dir);
  for (const file of files) {
    const name = rel(file, dir);
    if (/^brand\/banner-(light|dark)\.png$/.test(name)) {
      const png = parsePng(readFileSync(file));
      if (png.width !== num(budgets, 'bannerWidth') || png.height !== num(budgets, 'bannerHeight')) problems.push(`${name} : ${png.width}×${png.height} (attendu ${num(budgets, 'bannerWidth')}×${num(budgets, 'bannerHeight')})`);
    }
    if (/^brand\/og-(en|fr)\.png$/.test(name)) {
      const png = parsePng(readFileSync(file));
      if (png.width !== num(budgets, 'ogWidth') || png.height !== num(budgets, 'ogHeight')) problems.push(`${name} : ${png.width}×${png.height} (attendu ${num(budgets, 'ogWidth')}×${num(budgets, 'ogHeight')})`);
    }
    if (name.endsWith('.gif')) {
      const gif = parseGif(readFileSync(file));
      if (gif.frames < 1) problems.push(`${name} : GIF sans image`);
    }
  }
  return problems;
}

/** SVG sûrs : définition unique de packages/ui (20b §3.1) ; le texte reste permis hors de packages/ui. */
export function svgFileProblems(dir = assetsDir): string[] {
  return assetFiles(dir)
    .filter((file) => file.endsWith('.svg'))
    .flatMap((file) => svgSafetyProblems(readFileSync(file, 'utf8'), { noText: false }).map((reason) => `${rel(file, dir)} : ${reason}`));
}

/** Texte d'un SVG : contenu des éléments `<text>` (balises internes retirées, entités numériques décodées). */
function svgTexts(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
    (m[1] ?? '').replace(/<[^>]+>/g, '').replace(/&#x([0-9a-f]+);/gi, (_s, hex: string) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_s, dec: string) => String.fromCodePoint(Number(dec))));
}

/**
 * Aucun emoji dans un texte des SVG de `.github/assets/` (20 §2.3, 4.12b) : au rendu, l'emoji est tracé par la police emoji du
 * système (œuvre tierce, différente d'une machine à l'autre) ; la signature d'une image est l'icône SVG de packages/ui.
 */
export function svgEmojiProblems(dir = assetsDir): string[] {
  return assetFiles(dir)
    .filter((file) => file.endsWith('.svg'))
    .flatMap((file) => svgTexts(readFileSync(file, 'utf8')).filter((text) => /\p{Extended_Pictographic}/u.test(text)).map((text) => `${rel(file, dir)} : emoji dans un texte (« ${text.trim()} »), tracer l'icône de packages/ui à la place`));
}

const GHOST_ICON = join(runtimeDir, 'packages', 'ui', 'icons', 'sym-ghost.svg');

/** Chaque bandeau (`src/banner-*.svg`) trace l'icône SYM de packages/ui (même tracé `d` que `sym-ghost.svg`) à côté du texte « SYM ». */
export function bannerGhostProblems(dir = assetsDir): string[] {
  const d = /\sd="([^"]+)"/.exec(readFileSync(GHOST_ICON, 'utf8'))?.[1];
  if (!d) return ['packages/ui/icons/sym-ghost.svg sans tracé'];
  const banners = assetFiles(dir).filter((file) => /^src\/banner-[^/]*\.svg$/.test(rel(file, dir)));
  if (banners.length === 0) return ['aucun bandeau src/banner-*.svg'];
  return banners
    .filter((file) => ![...readFileSync(file, 'utf8').matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].some((m) => m[1] === d))
    .map((file) => `${rel(file, dir)} : ne trace pas l'icône sym-ghost.svg de packages/ui`);
}

/** Chaque fichier de `.github/assets/` figure dans `ASSETS-LICENSES.md` (auteur, licence, date). */
export function licensesListedProblems(dir = assetsDir, text = readFileSync(join(assetsDir, 'ASSETS-LICENSES.md'), 'utf8')): string[] {
  const problems: string[] = [];
  const files = assetFiles(dir);
  for (const file of files) {
    const name = rel(file, dir);
    if (name === 'ASSETS-LICENSES.md') continue;
    const row = text.split('\n').find((line) => line.startsWith('|') && line.includes(`\`${name}\``));
    if (!row) problems.push(`${name} : absent de ASSETS-LICENSES.md`);
    else {
      const cells = row.split('|').map((c) => c.trim()).filter((c) => c !== '');
      if (cells.length < 4 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[3] ?? '') || !cells[1] || !cells[2]) problems.push(`${name} : ligne de ASSETS-LICENSES.md sans auteur, licence ou date`);
    }
  }
  return problems;
}

const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ['chemin personnel /Users/', /\/Users\//],
  ['chemin personnel /home/', /\/home\/[a-z]/i],
  ['clé sk-', /\bsk-[A-Za-z0-9_-]{8,}/],
  ['jeton Bearer', /Bearer\s+[A-Za-z0-9._-]{8,}/],
  ['adresse e-mail', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['IP privée', /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
];
/** Blocs PNG admis : aucun bloc d'horodatage, d'EXIF ou de profil d'appareil ne s'ajoute à l'image. */
const PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'pHYs', 'sRGB', 'gAMA', 'cHRM']);

/** SVG et PNG sans secret ni chemin personnel (SVG : texte entier ; PNG : métadonnées, blocs limités à la liste). */
export function secretProblems(dir = assetsDir): string[] {
  const problems: string[] = [];
  const files = assetFiles(dir);
  for (const file of files) {
    const name = rel(file, dir);
    let text = '';
    if (name.endsWith('.svg')) text = readFileSync(file, 'utf8');
    else if (name.endsWith('.png')) {
      const png = parsePng(readFileSync(file));
      const extra = png.chunks.filter((chunk) => !PNG_CHUNKS.has(chunk));
      if (extra.length > 0) problems.push(`${name} : blocs PNG non admis (${extra.join(', ')})`);
      text = png.text.map((t) => `${t.keyword} ${t.value}`).join('\n');
    }
    for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(text)) problems.push(`${name} : ${label}`);
  }
  return problems;
}

/** Marques tierces : noms de fichiers, texte et attributs des SVG, métadonnées des PNG (22 §4). */
export function assetMarksProblems(dir = assetsDir): string[] {
  const problems: string[] = [];
  const files = assetFiles(dir);
  for (const file of files) {
    const name = rel(file, dir);
    const parts = [name.replace(/[-_./]/g, ' ')];
    if (name.endsWith('.svg')) parts.push(readFileSync(file, 'utf8').replace(/<path\b[^>]*>/g, ' '));
    else if (name.endsWith('.png')) parts.push(parsePng(readFileSync(file)).text.map((t) => `${t.keyword} ${t.value}`).join('\n'));
    problems.push(...marksProblems(parts.join('\n')).map((p) => `${name} : ${p}`));
  }
  return problems;
}
