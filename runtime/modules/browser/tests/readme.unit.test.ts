// SPDX-License-Identifier: AGPL-3.0-only
// README de SYM Browser (en, fr) et page du site SYM (cdc/sym-browser 06, tâche 5.5) : DA de SYM (bannière, « SYM 👻 »,
// badges, ton du README de SYM), liens valides, exemples du SDK (04 § 10) et `connectOverCDP` (04f § 7), parité fr/en.
// Tests nommés : readme_links_valid (liens), readme_da_sym (bannière, badges, mentions), readme_fr_en_parity,
// readme_examples (exemple d'environ 20 lignes), readme_svg_safe (bannière et badges sans script ni ressource externe,
// couleurs de la palette SYM).
// Liens : une cible relative existe dans le module (ancre comprise) ; un lien absolu est en https vers un hôte connu ;
// aucune image distante (rien n'est chargé depuis un tiers à l'affichage, le README marche hors ligne et dans le miroir).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';

const README_EN = join(MODULE_ROOT, 'README.md');
const README_FR = join(MODULE_ROOT, 'README.fr.md');
const SITE_EN = join(MODULE_ROOT, 'docs/site/en/sym-browser.md');
const SITE_FR = join(MODULE_ROOT, 'docs/site/fr/sym-browser.md');
const DOCS = [README_EN, README_FR, SITE_EN, SITE_FR];
const read = (file: string) => readFileSync(file, 'utf8');

/** Hôtes (et préfixes de chemin) permis pour un lien absolu : dépôts du projet, licences, clients CDP cités. */
const ALLOWED_EXTERNAL = [
  'https://github.com/scrap-yo-mama/sym',
  'https://github.com/scrap-yo-mama/sym-browser',
  'https://www.gnu.org/licenses/agpl-3.0',
  'https://opensource.org/license/mit',
  'https://playwright.dev/',
  'https://pptr.dev/',
  'https://github.com/browserbase/stagehand',
  'https://github.com/browser-use/browser-use',
  'https://chromedevtools.github.io/devtools-protocol/',
];

/** Code des blocs ``` retiré : un lien d'exemple dans du code n'est pas un lien du document. */
const prose = (md: string) => md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

function links(md: string): { url: string; image: boolean }[] {
  const text = prose(md);
  const out: { url: string; image: boolean }[] = [];
  for (const m of text.matchAll(/(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ url: m[2]!, image: m[1] === '!' });
  for (const m of text.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) out.push({ url: m[1]!, image: true });
  for (const m of text.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) out.push({ url: m[1]!, image: false });
  return out;
}

/** Ancre GitHub d'un titre : minuscules, ponctuation retirée (sauf `-` et `_`), espaces → `-`, emoji retirés. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const m of md.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of md.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]!);
  return out;
}

function sections(md: string): string[] {
  return [...md.replace(/```[\s\S]*?```/g, '').matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
}

function codeBlocks(md: string): { lang: string; code: string }[] {
  return [...md.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1]!, code: m[2]! }));
}

/** Code sans commentaires ni lignes vides : les commentaires sont traduits, le code est identique en fr et en en. */
const bareCode = (code: string) =>
  code
    .split('\n')
    .map((l) => l.replace(/\s*\/\/.*$/, '').replace(/\s*#.*$/, '').trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n');

describe('fichiers livrés', () => {
  test.each(DOCS.map((f) => [relative(MODULE_ROOT, f), f]))('%s présent et non vide', (_name, file) => {
    expect(existsSync(file)).toBe(true);
    expect(read(file).length).toBeGreaterThan(1000);
  });
});

describe('readme_links_valid : liens et images', () => {
  test.each(DOCS.map((f) => [relative(MODULE_ROOT, f), f]))('%s : chaque lien relatif mène à un fichier du module (ancre comprise), chaque lien absolu est en https vers un hôte connu, aucune image distante', (_name, file) => {
    const md = read(file);
    const found = links(md);
    expect(found.length).toBeGreaterThan(5);
    const problems: string[] = [];
    for (const { url, image } of found) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        if (image) problems.push(`image distante : ${url}`);
        else if (!ALLOWED_EXTERNAL.some((prefix) => url === prefix || url.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || url.startsWith(`${prefix}#`)))
          problems.push(`lien absolu hors liste ou non https : ${url}`);
        continue;
      }
      const [path = '', anchor] = url.split('#');
      const target = path === '' ? file : resolve(dirname(file), decodeURIComponent(path));
      if (!target.startsWith(MODULE_ROOT)) {
        problems.push(`lien hors du module : ${url}`);
        continue;
      }
      if (!existsSync(target)) {
        problems.push(`cible absente : ${url}`);
        continue;
      }
      if (anchor !== undefined) {
        if (!target.endsWith('.md')) problems.push(`ancre vers un fichier non Markdown : ${url}`);
        else if (!anchors(read(target)).has(anchor)) problems.push(`ancre absente : ${url}`);
      }
      if (image && !/\.(svg|png)$/.test(target)) problems.push(`image d’un format inattendu : ${url}`);
    }
    expect(problems).toEqual([]);
  });

  test('chaque fichier de docs/assets est utilisé par au moins un document', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const used = new Set(DOCS.flatMap((f) => links(read(f)).filter((l) => !/^[a-z]+:/i.test(l.url)).map((l) => resolve(dirname(f), l.url.split('#')[0]!))));
    for (const asset of walk(join(MODULE_ROOT, 'docs/assets'))) expect(used.has(asset), relative(MODULE_ROOT, asset)).toBe(true);
  });
});

describe('readme_da_sym : DA du README de SYM', () => {
  test.each([
    ['README.md', README_EN, 'README.fr.md', 'Français'],
    ['README.fr.md', README_FR, 'README.md', 'English'],
  ] as const)('%s : bannière en tête, « SYM 👻 », badges locaux, sélecteur de langue, avertissement de pré-version', (_name, file, other, otherLabel) => {
    const md = read(file);
    const head = md.slice(0, md.indexOf('</div>'));
    expect(md.trimStart().startsWith('<div align="center">')).toBe(true);
    expect(head).toMatch(/<img\b[^>]*src="docs\/assets\/banner\.svg"[^>]*alt="[^"]+"/);
    expect(head).toMatch(/^# SYM Browser \(SYM 👻\)$/m);
    const badges = [...head.matchAll(/<img\b[^>]*src="docs\/assets\/badges\/([a-z-]+)\.svg"/g)].map((m) => m[1]);
    expect(badges).toEqual(['license', 'sdk', 'status', 'protocol', 'deploy']);
    expect(head).toContain(`[${otherLabel}](${other})`);
    expect(md).toMatch(/> \[!WARNING\]\n> \*\*/);
    expect(md).toMatch(/^> SYM 👻 ?:/m);
  });

  test.each([
    [README_EN, ['CDP', 'wss://', 'Playwright', 'Puppeteer', 'Stagehand', 'browser-use', 'self-hosted', 'AGPL-3.0', 'MIT', 'SYM', 'open source', 'connectOverCDP']],
    [README_FR, ['CDP', 'wss://', 'Playwright', 'Puppeteer', 'Stagehand', 'browser-use', 'auto-hébergé', 'AGPL-3.0', 'MIT', 'SYM', 'open source', 'connectOverCDP']],
  ])('ce que fait SYM Browser est dit (%s)', (file, words) => {
    const md = read(file);
    for (const w of words) expect(md, w).toContain(w);
    // Installable seul ou avec SYM.
    expect(md).toMatch(file === README_EN ? /on its own or (alongside|with) SYM/i : /seul ou avec SYM/i);
  });

  test('ton de SYM : tutoiement en français, pas de vouvoiement', () => {
    const fr = prose(read(README_FR)) + prose(read(SITE_FR));
    expect(fr).not.toMatch(/\b(vous|votre|vos)\b/i);
    expect(fr).toMatch(/\b(tu|ton|ta|tes)\b/);
  });

  test('section « fait avec l’aide de l’IA » et licences comme le README de SYM', () => {
    expect(sections(read(README_EN))).toEqual(expect.arrayContaining(['License', 'Built with AI assistance']));
    expect(sections(read(README_FR))).toEqual(expect.arrayContaining(['Licence', 'Écrit avec l’aide de l’IA']));
  });
});

describe('readme_fr_en_parity', () => {
  test.each([
    ['README', README_EN, README_FR],
    ['page du site', SITE_EN, SITE_FR],
  ])('%s : mêmes sections, mêmes blocs de code (hors commentaires), mêmes liens hors langue', (_name, en, fr) => {
    const a = read(en);
    const b = read(fr);
    expect(sections(a).length).toBe(sections(b).length);
    expect(codeBlocks(a).map((c) => [c.lang, bareCode(c.code)])).toEqual(codeBlocks(b).map((c) => [c.lang, bareCode(c.code)]));
    const external = (md: string) => links(md).filter((l) => /^https:/.test(l.url)).map((l) => l.url).sort();
    expect(external(a)).toEqual(external(b));
  });
});

describe('readme_examples', () => {
  const blocks = codeBlocks(read(README_EN)).filter((b) => b.lang === 'ts');

  test('exemple du SDK d’environ 20 lignes (15 à 25), API de 04 § 10, TypeScript sans erreur de syntaxe', () => {
    const sdk = blocks.find((b) => b.code.includes('new SymBrowser'));
    expect(sdk).toBeDefined();
    const lines = sdk!.code.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(15);
    expect(lines.length).toBeLessThanOrEqual(25);
    expect(sdk!.code).toContain("from '@sym-browser/sdk'");
    expect(sdk!.code).toMatch(/symb\.sessions\.create\(/);
    expect(sdk!.code).toMatch(/symb\.connectCDP\(session\)/);
    expect(sdk!.code).toMatch(/await using session/);
    for (const b of blocks) {
      const out = ts.transpileModule(b.code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      expect(out.diagnostics ?? [], b.code.slice(0, 40)).toEqual([]);
    }
  });

  test('exemple connectOverCDP : REST /v1/sessions puis connectUrls.cdp, aussi pour Puppeteer', () => {
    const cdp = blocks.find((b) => b.code.includes('connectOverCDP'));
    expect(cdp).toBeDefined();
    expect(cdp!.code).toMatch(/\/v1\/sessions/);
    expect(cdp!.code).toMatch(/chromium\.connectOverCDP\(session\.connectUrls\.cdp\)/);
    expect(cdp!.code).toMatch(/puppeteer\.connect\(\{ browserWSEndpoint: session\.connectUrls\.cdp \}\)/);
    expect(cdp!.code).toMatch(/Authorization: `Bearer \$\{/);
  });

  test('aucun secret ni hôte réel dans les exemples : clé lue dans l’environnement, hôte d’exemple', () => {
    for (const file of DOCS) {
      for (const b of codeBlocks(read(file))) {
        expect(b.code).not.toMatch(/symb_[A-Za-z0-9_-]{16,}/);
        for (const m of b.code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) expect(m[1], file).toMatch(/(^|\.)example\.com$|^localhost$/);
      }
    }
  });
});

describe('readme_svg_safe : bannière et badges', () => {
  const palette = new Set([...read(join(MODULE_ROOT, '../../packages/ui/src/theme.css')).matchAll(/--sym-[a-z-]+:\s*(#[0-9A-Fa-f]{6})/g)].map((m) => m[1]!.toUpperCase()));
  const ghost = /SYM_GHOST_PATH =\s*'([^']+)'/.exec(read(join(MODULE_ROOT, '../../packages/ui/src/sym-ghost.ts')))![1]!;
  const svgs = () => {
    const dir = join(MODULE_ROOT, 'docs/assets');
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    return walk(dir).filter((f) => f.endsWith('.svg'));
  };

  test('au moins la bannière et 5 badges', () => {
    expect(svgs().map((f) => relative(MODULE_ROOT, f)).sort()).toEqual(
      ['banner', 'badges/deploy', 'badges/license', 'badges/protocol', 'badges/sdk', 'badges/status'].map((n) => `docs/assets/${n}.svg`).sort(),
    );
  });

  test.each(['banner', 'badges/license', 'badges/sdk', 'badges/status', 'badges/protocol', 'badges/deploy'])('%s.svg : SVG autonome, sans script ni ressource externe, couleurs de la palette SYM', (name) => {
    const svg = read(join(MODULE_ROOT, `docs/assets/${name}.svg`));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*\bviewBox="[\d. ]+"[^>]*>/);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).not.toMatch(/<script|<foreignObject|<image\b|\bon[a-z]+\s*=|javascript:|@import|url\(\s*['"]?(https?:|\/\/)/i);
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:\/\//);
    expect(svg).toMatch(/<title>[^<]+<\/title>/);
    const colors = [...svg.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => m[0].toUpperCase());
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) expect(palette.has(c), `${name} : ${c} hors palette SYM`).toBe(true);
  });

  test('la bannière porte l’icône SYM 👻 de packages/ui (même tracé) et le nom du produit', () => {
    const banner = read(join(MODULE_ROOT, 'docs/assets/banner.svg'));
    expect(banner).toContain(`d="${ghost}"`);
    expect(banner).toContain('SYM Browser');
  });
});

describe('page SYM Browser du site SYM (docs/site)', () => {
  test.each([
    [SITE_EN, '../fr/sym-browser.md', 'Français'],
    [SITE_FR, '../en/sym-browser.md', 'English'],
  ])('%s : en-tête VitePress (titre, description), lien vers l’autre langue, exemple connectOverCDP, liens vers le README', (file, other, label) => {
    const md = read(file);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(md);
    expect(front).not.toBeNull();
    expect(front![1]).toMatch(/^title: .+$/m);
    expect(front![1]).toMatch(/^description: .+$/m);
    expect(md).toContain(`[${label}](${other})`);
    expect(md).toContain('connectOverCDP');
    expect(md).toContain('SYM 👻');
  });
});
