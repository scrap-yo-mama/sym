// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.12, critères « Images et visuels » et « Enregistrements » de 22b §3 (u8 R3, R4, R5) : budgets de poids, aperçu social, SVG sûrs,
// licences des visuels, absence de secret et de marque, copie vers le site de doc, script VHS reproductible, index des vidéos.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { assetMarksProblems, bannerProblems, licensesListedProblems, secretProblems, sizeProblems, socialPreviewProblems, svgFileProblems } from '../../scripts/vitrine/lib/assets.ts';
import { brandDrift } from '../../scripts/vitrine/lib/brand-sync.ts';
import { decodePng, isOpaque, parseGif, parsePng } from '../../scripts/vitrine/lib/images.ts';
import { assetsDir } from '../../scripts/vitrine/lib/paths.ts';
import { localizedSvg, RENDER_JOBS } from '../../scripts/vitrine/lib/render.ts';
import { loadBudgets } from '../../scripts/vitrine/lib/readme.ts';
import { mediaProblems, tapeProblems } from '../../scripts/vitrine/lib/surface.ts';
import { makePng } from './png-fixture.ts';

const budgets = loadBudgets();
const scratch = mkdtempSync(join(tmpdir(), 'zz_test_vitrine_assets-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
/** Dossier d'assets synthétique : `files` = chemin relatif → contenu. */
function fakeAssets(files: Record<string, Buffer | string>): string {
  const dir = join(scratch, `assets-${(counter += 1)}`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
const bg = String(budgets.assets['socialPreviewBackground']).replace('#', '');

describe('assert_readme_assets_size_budget : SVG ≤ 10 Ko, bandeau ≤ 150 Ko, aperçu social < 400 Ko, GIF ≤ 1,5 Mo, .github/assets ≤ 5 Mo', () => {
  test('les visuels du dépôt respectent les budgets, dimensions comprises', () => {
    expect(sizeProblems(budgets)).toEqual([]);
    expect(bannerProblems(budgets)).toEqual([]);
    for (const name of ['banner-light', 'banner-dark']) expect(parsePng(readFileSync(join(assetsDir, `brand/${name}.png`)))).toMatchObject({ width: 1600, height: 400 });
  });

  test('cas négatifs : un poids dépassé par type, et l\'ensemble au-delà de 5 Mo', () => {
    const dir = fakeAssets({
      'a.svg': `<svg xmlns="http://www.w3.org/2000/svg">${'x'.repeat(11_000)}</svg>`,
      'brand/banner-light.png': makePng({ width: 1600, height: 400, padding: 160_000 }),
      'brand/social-preview.png': makePng({ width: 1280, height: 640, padding: 420_000 }),
      'demo/quickstart-en.gif': Buffer.alloc(1_600_000),
    });
    const found = sizeProblems(budgets, dir).join('\n');
    for (const name of ['a.svg', 'banner-light.png', 'social-preview.png', 'quickstart-en.gif']) expect(found).toContain(name);
    expect(sizeProblems(budgets, fakeAssets({ 'big.bin': Buffer.alloc(5_300_000) })).join()).toMatch(/\.github\/assets/);
    expect(bannerProblems(budgets, fakeAssets({ 'brand/banner-light.png': makePng({ width: 800, height: 400 }) })).join()).toMatch(/attendu 1600×400/);
  });
});

describe('assert_social_preview_spec : 1280×640 exactement, < 400 Ko, fond opaque crème uni, marge de 64 px', () => {
  test('aperçu social du dépôt', () => {
    expect(socialPreviewProblems(budgets)).toEqual([]);
    const buffer = readFileSync(join(assetsDir, 'brand/social-preview.png'));
    expect(parsePng(buffer)).toMatchObject({ width: 1280, height: 640 });
    expect(buffer.length).toBeLessThan(400 * 1024);
    expect(isOpaque(buffer)).toBe(true);
    const { width, rgba } = decodePng(buffer);
    expect([...rgba.slice(0, 3)]).toEqual([0xfb, 0xf8, 0xf3]);
    expect(width).toBe(1280);
  });

  test('cas négatifs : mauvaises dimensions, fond transparent, marge touchée, mauvais fond, trop lourd', () => {
    const path = (name: string, png: Buffer): string => {
      const file = join(fakeAssets({ [name]: png }), name);
      return file;
    };
    expect(socialPreviewProblems(budgets, path('a.png', makePng({ width: 1200, height: 630, background: bg }))).join()).toMatch(/attendu 1280×640/);
    expect(socialPreviewProblems(budgets, path('b.png', makePng({ width: 1280, height: 640, background: bg, alpha: 128 }))).join()).toMatch(/non opaque/);
    expect(socialPreviewProblems(budgets, path('c.png', makePng({ width: 1280, height: 640, background: bg, paint: [[10, 10, '000000']] }))).join()).toMatch(/marge/);
    expect(socialPreviewProblems(budgets, path('d.png', makePng({ width: 1280, height: 640, background: 'FFFFFF' }))).join()).toMatch(/marge/);
    expect(socialPreviewProblems(budgets, path('e.png', makePng({ width: 1280, height: 640, background: bg, padding: 420_000 }))).join()).toMatch(/octets/);
    expect(socialPreviewProblems(budgets, path('f.png', makePng({ width: 1280, height: 640, background: bg, alpha: 255 })))).toEqual([]);
  });

  test('texte de l\'aperçu : accroche anglaise, corps ≥ 48 px, aucun texte sous la marque de 64 px (source SVG)', () => {
    const svg = readFileSync(join(assetsDir, 'src/social-preview.svg'), 'utf8');
    expect(svg).toContain('Describe the data.');
    expect(svg).toContain('SYM handles the rest.');
    expect(svg).toContain('fill="#FBF8F3"');
    for (const m of svg.matchAll(/<text\b[^>]*font-size="(\d+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(48);
    for (const m of svg.matchAll(/<text\b[^>]*\sx="(\d+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(64);
  });
});

describe('rendu des visuels : les PNG viennent des sources SVG versionnées (pnpm assets:render)', () => {
  test('chaque tâche de rendu a sa source SVG et sa sortie, aux dimensions annoncées', () => {
    expect(RENDER_JOBS.map((job) => job.output)).toEqual(['brand/banner-light.png', 'brand/banner-dark.png', 'brand/social-preview.png', 'brand/og-en.png', 'brand/og-fr.png']);
    for (const job of RENDER_JOBS) {
      expect(readFileSync(join(assetsDir, job.source), 'utf8')).toContain('<svg');
      expect(parsePng(readFileSync(join(assetsDir, job.output)))).toMatchObject({ width: job.width, height: job.height });
    }
  });

  test('images OG : même source SVG que l\'aperçu social, accroche remplacée par langue', () => {
    const source = readFileSync(join(assetsDir, 'src/social-preview.svg'), 'utf8');
    const fr = localizedSvg(source, { line1: 'Décris les données.', line2: "SYM s'occupe du reste." });
    expect(fr).toContain('Décris les données.');
    expect(fr).not.toMatch(/>Describe the data\.</);
    expect(fr.replace(/>[^<]*<\/text>/g, '></text>')).toBe(source.replace(/>[^<]*<\/text>/g, '></text>'));
    expect(localizedSvg(source, { line1: 'A & B <x>' })).toContain('A &amp; B &lt;x>');
  });
});

describe('assert_svg_safe : ni script, ni on*, ni foreignObject, ni lien ou image externe, ni @import, ni <style, ni style=', () => {
  test('tous les SVG de .github/assets', () => {
    expect(svgFileProblems()).toEqual([]);
  });

  test('cas négatifs : un cas par motif interdit ; le texte reste permis hors de packages/ui', () => {
    const bad: Record<string, string> = {
      script: '<svg><script>1</script></svg>', onload: '<svg onload="x()"></svg>', foreign: '<svg><foreignObject/></svg>', extimg: '<svg><image href="https://x.y/a.png"/></svg>',
      extlink: '<svg><use xlink:href="//x.y/a.svg"/></svg>', imp: '<svg>@import url(a.css)</svg>', style: '<svg><style>a{}</style></svg>', inline: '<svg><rect style="fill:red"/></svg>',
    };
    for (const [name, svg] of Object.entries(bad)) expect(svgFileProblems(fakeAssets({ [`${name}.svg`]: svg })), name).not.toEqual([]);
    expect(svgFileProblems(fakeAssets({ 'text.svg': '<svg xmlns="http://www.w3.org/2000/svg"><text x="1">Texte permis</text></svg>' }))).toEqual([]);
  });
});

describe('assert_assets_licenses_listed : chaque fichier de .github/assets figure dans ASSETS-LICENSES.md (auteur, licence, date)', () => {
  test('les fichiers du dépôt', () => {
    expect(licensesListedProblems()).toEqual([]);
  });

  test('cas négatifs : fichier absent de la table, ligne sans date', () => {
    const dir = fakeAssets({ 'brand/new.png': makePng({ width: 4, height: 4 }), 'ASSETS-LICENSES.md': '' });
    expect(licensesListedProblems(dir, '| `brand/other.png` | A | MIT | 2026-10-02 |').join()).toMatch(/new\.png : absent/);
    expect(licensesListedProblems(dir, '| `brand/new.png` | A | MIT | bientôt |').join()).toMatch(/sans auteur, licence ou date/);
    expect(licensesListedProblems(dir, '| `brand/new.png` | A | MIT | 2026-10-02 |')).toEqual([]);
  });
});

describe('assert_assets_no_secret : aucun /Users/, sk-, Bearer, e-mail ni IP privée dans les SVG et les PNG', () => {
  test('les fichiers du dépôt, PNG réduits à leurs blocs d\'image', () => {
    expect(secretProblems()).toEqual([]);
    expect(assetMarksProblems()).toEqual([]);
    for (const name of ['banner-light', 'banner-dark', 'social-preview', 'og-en', 'og-fr']) {
      expect(parsePng(readFileSync(join(assetsDir, `brand/${name}.png`))).chunks.every((c) => ['IHDR', 'IDAT', 'IEND', 'PLTE', 'tRNS', 'pHYs', 'sRGB', 'gAMA', 'cHRM'].includes(c)), name).toBe(true);
    }
  });

  test('cas négatifs : chemin personnel, clé, jeton, e-mail, IP privée, bloc de métadonnées, marque tierce dans un nom ou un texte', () => {
    for (const secret of ['/Users/thomas/x', 'sk-abcdefgh12345678', 'Bearer abcdefgh12345', 'a.b@example.org', '192.168.1.20', '10.0.3.4']) {
      expect(secretProblems(fakeAssets({ 'a.svg': `<svg><text>${secret}</text></svg>` })), secret).not.toEqual([]);
    }
    expect(secretProblems(fakeAssets({ 'a.png': makePng({ width: 4, height: 4, text: [['Comment', '/Users/thomas/photo']] }) })).join()).toMatch(/\/Users\//);
    expect(secretProblems(fakeAssets({ 'a.png': makePng({ width: 4, height: 4, padding: 10 }) })).join()).toMatch(/blocs PNG non admis/);
    expect(assetMarksProblems(fakeAssets({ 'brand/openai-logo.svg': '<svg/>' })).join()).toMatch(/openai/);
    expect(assetMarksProblems(fakeAssets({ 'brand/a.svg': '<svg><text>Works with Claude</text></svg>' })).join()).toMatch(/claude/);
  });
});

describe('copie de la marque vers le site de doc (pnpm brand:sync)', () => {
  test('apps/docs/content/public/brand est identique à .github/assets/brand', () => {
    expect(brandDrift()).toEqual([]);
  });
});

describe('assert_demo_recording_reproducible : quickstart.tape rejoué deux fois donne les mêmes dimensions, durées, poids, captures', () => {
  // D-51 : le GIF de démo est produit par 3.11 (mode démo) ; jusque-là l'emplacement est réservé et le rejeu est un test.todo.
  test.todo('assert_demo_recording_reproducible : deux rejeux de demo/quickstart.tape (VHS) : mêmes dimensions, durées à 0,5 s, poids sous budget, captures d\'étapes à 1 % de pixels ; une requête hors instance fait échouer (livré par 3.11)');

  test('le script VHS du dépôt est rejouable : sortie, réglages figés, seules les commandes du quickstart, aucune URL hors instance', () => {
    expect(tapeProblems(readFileSync(join(assetsDir, 'demo/quickstart.tape'), 'utf8'))).toEqual([]);
  });

  test('cas négatifs : site réel, commande hors liste, chemin personnel, réglage manquant, sortie hors dossier', () => {
    const tape = readFileSync(join(assetsDir, 'demo/quickstart.tape'), 'utf8');
    expect(tapeProblems(`${tape}\nType "curl https://example.com"`).join()).toMatch(/hors liste/);
    expect(tapeProblems(`${tape}\n# https://example.com`).join()).toMatch(/hors de l'instance/);
    expect(tapeProblems(`${tape}\n# /Users/thomas/clé`).join()).toMatch(/chemin personnel/);
    expect(tapeProblems(tape.replace(/^Set Width.*$/m, '')).join()).toMatch(/Set Width/);
    expect(tapeProblems(tape.replace('Output .github/assets/demo/', 'Output ')).join()).toMatch(/Output/);
  });

  test('GIF de terminal : poids ≤ 1,5 Mo ; un GIF présent est lu (dimensions, images, durée) par le lecteur du job', () => {
    // GIF 89a minimal : une image 2×1, délai 50 (0,5 s).
    const gif = Buffer.from('47494638396102000100800000000000ffffff21f90405320000002c00000000020001000002024401003b', 'hex');
    expect(parseGif(gif)).toEqual({ width: 2, height: 1, frames: 1, durationSeconds: 0.5 });
    expect(() => parseGif(Buffer.from('pas un gif'))).toThrow(/pas un GIF/);
  });
});

describe('assert_media_index_current : une MINOR cite sa version et une URL user-attachments dans MEDIA.md', () => {
  const media = readFileSync(join(assetsDir, 'MEDIA.md'), 'utf8');
  test('avant la première MINOR, rien à citer ; MEDIA.md existe et dit qu\'aucune vidéo n\'est envoyée', () => {
    const version = (JSON.parse(readFileSync(join(assetsDir, '../../runtime/package.json'), 'utf8')) as { version: string }).version;
    expect(mediaProblems(version, media)).toEqual([]);
    expect(media).toMatch(/not uploaded yet/);
  });

  test('cas négatifs : MINOR sans version citée, sans URL ; un patch n\'exige rien', () => {
    expect(mediaProblems('0.2.0', media).join()).toMatch(/ne cite pas la version 0\.2\.0/);
    expect(mediaProblems('0.2.0', `${media}\n0.2.0 no link`).join()).toMatch(/user-attachments/);
    expect(mediaProblems('0.2.0', '| 0.2.0 | Console | https://github.com/user-attachments/assets/abc |')).toEqual([]);
    expect(mediaProblems('0.2.1', media)).toEqual([]);
    expect(mediaProblems('1.0.0', media)).not.toEqual([]);
  });
});
