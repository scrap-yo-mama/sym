// SPDX-License-Identifier: AGPL-3.0-only
// assert_fonts_self_hosted, volet statique (20b § 3.1, étage S ; le volet navigateur, 0 requête tierce à froid, est dans
// apps/web/e2e/brand.e2e.ts) : les polices de la charte sont des fichiers woff2 du paquet, déclarés sans URL distante,
// de poids tenu, sous SIL OFL 1.1 avec leur texte et leur attribution dans NOTICE.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { listFiles } from './testing/color-rules.ts';

const uiRoot = new URL('..', import.meta.url).pathname;
const runtimeRoot = join(uiRoot, '../..');
const fontsCss = readFileSync(join(uiRoot, 'src/fonts.css'), 'utf8');
const themeCss = readFileSync(join(uiRoot, 'src/theme.css'), 'utf8');
/** NOTICE retourne à la ligne : on compare sans les sauts. */
const notice = readFileSync(join(runtimeRoot, 'NOTICE'), 'utf8').replace(/\s+/g, ' ');

/** Fichiers copiés tels quels des paquets @fontsource 5.3.0 (OFL-1.1) : empreintes sha256. */
const FONT_FILES: Record<string, string> = {
  'bricolage-grotesque-latin-800-normal.woff2': '3e1b5f0a56ee995b7c1445bc54e6ec98c5dffb585ef5c4baf86731cf68e27c61',
  'dm-sans-latin-400-normal.woff2': '4ab51eb2cd7305d177187908d6397474d4520663f6c6e572feb0a64f4fa80006',
  'dm-sans-latin-500-normal.woff2': '19bf1984956517c35c2bd35b6cdedac12a21d6fcd3596c614ecdfb88b648909d',
  'dm-sans-latin-700-normal.woff2': '35c5efa0e5daa52ee5c6500f5be354bf751fb65c4e49e1d6806c6eb5883e8fe9',
  'jetbrains-mono-latin-400-normal.woff2': '14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb',
  'jetbrains-mono-latin-600-normal.woff2': '400c6bfda18d5d14acad1c15d6dcb9f8e13c015e7286317e0b9a482539bef147',
};

/** Budget de poids (20 § 1.2 : « à valider », fixé ici) : texte et titres sous les 80 Ko de la landing (u7 R22), code à part. */
const CORE_BUDGET_BYTES = 70_000;
const MONO_BUDGET_BYTES = 45_000;

const size = (name: string): number => statSync(join(uiRoot, 'fonts', name)).size;

describe('assert_fonts_self_hosted (statique)', () => {
  test('chaque @font-face pointe vers un woff2 du paquet, et le paquet n’a pas d’autre police', () => {
    const urls = [...fontsCss.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1] ?? '');
    expect(urls.length).toBe(Object.keys(FONT_FILES).length);
    for (const url of urls) {
      expect(url, url).toMatch(/^\.\.\/fonts\/[a-z0-9-]+\.woff2$/);
      expect(existsSync(join(uiRoot, 'src', url)), url).toBe(true);
    }
    expect(urls.map((url) => url.replace('../fonts/', '')).sort()).toEqual(Object.keys(FONT_FILES).sort());
  });

  test('les familles et graisses sont celles de la charte : Bricolage 800, DM Sans 400/500/700, JetBrains Mono 400/600', () => {
    const faces = [...fontsCss.matchAll(/font-family:\s*'([^']+)';[\s\S]*?font-weight:\s*(\d+);/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(faces.sort()).toEqual(['Bricolage Grotesque 800', 'DM Sans 400', 'DM Sans 500', 'DM Sans 700', 'JetBrains Mono 400', 'JetBrains Mono 600']);
    expect(fontsCss.match(/font-display:\s*swap;/g)).toHaveLength(6);
  });

  test('aucune URL distante ni data: dans les feuilles du paquet, aucune référence à un service de polices tiers dans la console et l’extension', () => {
    expect(fontsCss + themeCss).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\/|url\(\s*['"]?data:|@import\s+url\(/i);
    const hosts = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/i;
    const offenders: string[] = [];
    for (const dir of ['packages/ui', 'apps/web', 'apps/extension']) {
      for (const file of listFiles(join(runtimeRoot, dir), /\.(vue|ts|css|html|js)$/, /(^|\/)(node_modules|dist|\.wxt|\.output|e2e|testing)(\/|$)/)) {
        if (hosts.test(readFileSync(file, 'utf8'))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('chaque fichier est un woff2 et correspond à l’empreinte inscrite (copie fidèle du paquet @fontsource 5.3.0)', () => {
    for (const [name, sha] of Object.entries(FONT_FILES)) {
      const bytes = readFileSync(join(uiRoot, 'fonts', name));
      expect(bytes.subarray(0, 4).toString('latin1'), name).toBe('wOF2');
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(sha);
    }
  });

  test(`budget de poids : texte et titres ≤ ${CORE_BUDGET_BYTES} octets, JetBrains Mono ≤ ${MONO_BUDGET_BYTES} octets`, () => {
    const core = Object.keys(FONT_FILES).filter((name) => !name.startsWith('jetbrains')).reduce((sum, name) => sum + size(name), 0);
    const mono = Object.keys(FONT_FILES).filter((name) => name.startsWith('jetbrains')).reduce((sum, name) => sum + size(name), 0);
    expect(core).toBeLessThanOrEqual(CORE_BUDGET_BYTES);
    expect(mono).toBeLessThanOrEqual(MONO_BUDGET_BYTES);
  });

  test('licences : le texte de la SIL OFL 1.1 de chaque famille est livré et NOTICE les cite avec leur attribution', () => {
    for (const [family, file, copyright] of [
      ['Bricolage Grotesque', 'OFL-bricolage-grotesque.txt', 'The Bricolage Grotesque Project Authors'],
      ['DM Sans', 'OFL-dm-sans.txt', 'The DM Sans Project Authors'],
      ['JetBrains Mono', 'OFL-jetbrains-mono.txt', 'The JetBrains Mono Project Authors'],
    ] as const) {
      const text = readFileSync(join(uiRoot, 'fonts', file), 'utf8');
      expect(text, file).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(text, file).toContain(copyright);
      expect(notice, family).toContain(family);
      expect(notice, family).toContain(copyright);
    }
    expect(notice).toContain('SIL Open Font License 1.1');
  });
});
