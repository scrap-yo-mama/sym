// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.12, critères « Images et visuels » et « Enregistrements » de 22b §3 (u8 R3, R4, R5) : budgets de poids, aperçu social, SVG sûrs,
// licences des visuels, absence de secret et de marque, copie vers le site de doc, script VHS reproductible, index des vidéos.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { assetMarksProblems, bannerGhostProblems, bannerProblems, licensesListedProblems, secretProblems, sizeProblems, socialPreviewProblems, svgEmojiProblems, svgFileProblems } from '../../scripts/vitrine/lib/assets.ts';
import { brandDrift } from '../../scripts/vitrine/lib/brand-sync.ts';
import { decodePng, isOpaque, parseGif, parsePng } from '../../scripts/vitrine/lib/images.ts';
import { assetsDir, repoRoot, runtimeDir } from '../../scripts/vitrine/lib/paths.ts';
import { localizedSvg, RENDER_JOBS } from '../../scripts/vitrine/lib/render.ts';
import { loadBudgets } from '../../scripts/vitrine/lib/readme.ts';
import { mediaProblems, quickstartTapeCommands, tapeCommands, tapeProblems } from '../../scripts/vitrine/lib/surface.ts';
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
  }, 30_000);

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

describe('signature SYM des visuels : l\'icône SVG de packages/ui, jamais l\'emoji (20 §2.3, 4.12b)', () => {
  // Un emoji dans un <text> est tracé au rendu par la police emoji du système (Apple Color Emoji sur macOS, Noto sous Linux) :
  // le PNG porterait une œuvre tierce, et changerait d'une machine à l'autre.
  test('aucun emoji dans un texte des SVG de .github/assets ; chaque bandeau trace l\'icône sym-ghost.svg', () => {
    expect(svgEmojiProblems()).toEqual([]);
    expect(bannerGhostProblems()).toEqual([]);
  });

  test('cas négatifs : emoji en clair, en entité ou dans un <tspan> ; bandeau sans le tracé de l\'icône ; le texte sans emoji reste permis', () => {
    const svg = (text: string): string => `<svg xmlns="http://www.w3.org/2000/svg"><text x="1">${text}</text></svg>`;
    expect(svgEmojiProblems(fakeAssets({ 'src/a.svg': svg('SYM 👻') })).join()).toMatch(/emoji/);
    expect(svgEmojiProblems(fakeAssets({ 'src/a.svg': svg('SYM &#x1F47B;') })).join()).toMatch(/emoji/);
    expect(svgEmojiProblems(fakeAssets({ 'src/a.svg': svg('SYM &#128123;') })).join()).toMatch(/emoji/);
    expect(svgEmojiProblems(fakeAssets({ 'brand/b.svg': svg('<tspan>✨ ok</tspan>') })).join()).toMatch(/emoji/);
    expect(svgEmojiProblems(fakeAssets({ 'src/a.svg': svg('SYM · open source') }))).toEqual([]);
    const ghost = readFileSync(join(runtimeDir, 'packages/ui/icons/sym-ghost.svg'), 'utf8');
    const d = /\sd="([^"]+)"/.exec(ghost)?.[1] ?? '';
    expect(d).not.toBe('');
    const banner = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg"><text>SYM</text>${body}</svg>`;
    expect(bannerGhostProblems(fakeAssets({ 'src/banner-dark.svg': banner(''), 'src/banner-light.svg': banner(`<path d="${d}"/>`) })).join()).toMatch(/banner-dark\.svg.*sym-ghost/);
    expect(bannerGhostProblems(fakeAssets({ 'src/banner-dark.svg': banner('<path d="M0 0h1"/>') })).join()).toMatch(/sym-ghost/);
    expect(bannerGhostProblems(fakeAssets({ 'src/banner-dark.svg': banner(`<path transform="translate(1 2) scale(3)" fill="#FBF8F3" fill-rule="evenodd" d="${d}"/>`) }))).toEqual([]);
    expect(bannerGhostProblems(fakeAssets({ 'src/other.svg': banner('') }))).toEqual(['aucun bandeau src/banner-*.svg']);
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

  const tape = readFileSync(join(assetsDir, 'demo/quickstart.tape'), 'utf8');

  // Contrôle de FORME du script (le rejeu réel, avec VHS, est le test.todo ci-dessus) : sortie, réglages figés, commandes
  // tapées = étapes « secrets » puis « start » du quickstart rejoué en CI, aucune URL hors instance.
  test('contrôle de forme du script VHS : sortie, réglages figés, aucune URL hors instance, aucun chemin personnel', () => {
    expect(tapeProblems(tape)).toEqual([]);
  });

  test('les commandes tapées sont dérivées du quickstart (étapes « secrets » puis « start ») : le .env est créé avant le démarrage', () => {
    const wanted = quickstartTapeCommands();
    expect(wanted.join('\n')).toMatch(/MASTER_KEY=.*\n[\s\S]*docker compose up --build$/);
    expect(tapeCommands(tape)).toEqual(wanted);
    // Sans l'étape « secrets », MASTER_KEY reste vide (docker-compose.yml : ${MASTER_KEY:-}) et le serveur refuse de démarrer.
    const withoutSecrets = tape.split('\n').filter((line) => !/^Type\s/.test(line) || /cd runtime|clear|# Recorded|docker compose/.test(line)).join('\n');
    expect(withoutSecrets).not.toBe(tape);
    expect(tapeProblems(withoutSecrets).join()).toMatch(/quickstart/);
  });

  test('l\'invocation documentée (lancée depuis la racine du dépôt) écrit là où dit `Output`, puis entre dans runtime/', () => {
    const output = /^Output\s+(\S+)$/m.exec(tape)?.[1] ?? '';
    expect(output.startsWith('.github/assets/demo/')).toBe(true);
    const invocation = 'vhs .github/assets/demo/quickstart.tape';
    expect(readFileSync(join(assetsDir, 'demo/README.md'), 'utf8')).toContain(invocation);
    expect(tape).toContain(invocation);
    expect(tape).not.toMatch(/vhs demo\/quickstart\.tape/);
    expect(readFileSync(join(assetsDir, 'demo/README.md'), 'utf8')).not.toMatch(/vhs demo\/quickstart\.tape/);
    expect(tapeProblems(tape.replace('Type "cd runtime"', 'Type "cd ."')).join()).toMatch(/cd runtime/);
  });

  test('cas négatifs : site réel, commande hors liste, chemin personnel, réglage manquant, sortie hors dossier', () => {
    expect(tapeProblems(`${tape}\nType "curl https://example.com"`).join()).toMatch(/quickstart/);
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

  test('release (22b §5) : la release à blanc et release.yml jouent le contrôle ; une MINOR sans vidéo reste en brouillon', () => {
    const run = (version: string): { status: number | null; output: string } => {
      const out = join(scratch, `github-output-${(counter += 1)}`);
      writeFileSync(out, '');
      const result = spawnSync(process.execPath, ['scripts/vitrine/check.mjs', 'media', version], { cwd: runtimeDir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
      return { status: result.status, output: readFileSync(out, 'utf8') };
    };
    expect(run('0.2.0')).toEqual({ status: 0, output: 'draft=true\n' });
    expect(run('0.2.1')).toEqual({ status: 0, output: 'draft=false\n' });
    const dryRun = readFileSync(join(runtimeDir, 'scripts/release/dry-run.ts'), 'utf8');
    expect(dryRun).toMatch(/mediaProblems\(plan\.version/);
    const workflow = parse(readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')) as { jobs: { release: { steps: { id?: string; run?: string; env?: Record<string, string> }[] } } };
    const steps = workflow.jobs.release.steps;
    const mediaStep = steps.findIndex((step) => step.id === 'media' && /node scripts\/vitrine\/check\.mjs media "\$VERSION"/.test(step.run ?? ''));
    const publish = steps.findIndex((step) => /gh release create/.test(step.run ?? ''));
    expect(mediaStep).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(mediaStep);
    expect(steps[publish]?.env?.['DRAFT']).toBe('${{ steps.media.outputs.draft }}');
    expect(steps[publish]?.run).toMatch(/"\$DRAFT" = true[\s\S]*--draft/);
    expect(steps[publish]?.run).toMatch(/gh release edit "\$TAG" --draft=true/);
  });

  test("le job vitrine (check.mjs all) ne joue pas l'index des vidéos : la PR release-please d'une MINOR reste verte, seule la release passe en brouillon", () => {
    const all = spawnSync(process.execPath, ["scripts/vitrine/check.mjs"], { cwd: runtimeDir, encoding: "utf8" });
    expect(all.status, all.stderr).toBe(0);
    expect(`${all.stdout}${all.stderr}`).not.toMatch(/assert_media_index_current|index des vidéos/);
    expect(readFileSync(join(runtimeDir, "scripts/vitrine/lib/all.ts"), "utf8")).not.toMatch(/mediaProblems|mediaGate/);
  });

  test('cas négatifs : MINOR sans version citée, sans URL ; un patch n\'exige rien', () => {
    expect(mediaProblems('0.2.0', media).join()).toMatch(/ne cite pas la version 0\.2\.0/);
    expect(mediaProblems('0.2.0', `${media}\n| 0.2.0 | Console | no link |`).join()).toMatch(/user-attachments/);
    expect(mediaProblems('0.2.0', '| 0.2.0 | Console | https://github.com/user-attachments/assets/abc |')).toEqual([]);
    expect(mediaProblems('0.2.1', media)).toEqual([]);
    expect(mediaProblems('1.0.0', media)).not.toEqual([]);
  });

  test("cas négatifs : la version se lit dans la cellule Version d'une ligne du tableau, exactement, avec une URL user-attachments sur la même ligne", () => {
    const row = (version: string, url = "https://github.com/user-attachments/assets/abc"): string => `| Version | Video | URL |\n|---|---|---|\n| ${version} | Console | ${url} |\n`;
    expect(mediaProblems("0.2.0", row("0.2.0"))).toEqual([]);
    expect(mediaProblems("0.2.0", row("v0.2.0"))).toEqual([]);
    expect(mediaProblems("0.2.0", row("10.2.0")).join()).toMatch(/0\.2\.0/);
    expect(mediaProblems("0.2.0", row("0.2.0-beta")).join()).toMatch(/0\.2\.0/);
    expect(mediaProblems("0.2.0", row("0.2.0", "not uploaded yet")).join()).toMatch(/user-attachments/);
    // Une URL sur la ligne d'une autre version ne valide pas la ligne de 0.2.0.
    expect(mediaProblems("0.2.0", `${row("0.1.0")}| 0.2.0 | Console | not uploaded yet |\n`).join()).toMatch(/user-attachments/);
    // La version citée hors tableau (prose) ne compte pas.
    expect(mediaProblems("0.2.0", "Video for 0.2.0: https://github.com/user-attachments/assets/abc").join()).toMatch(/0\.2\.0/);
    // Une pré-version (canal beta) n'est pas la MINOR : rien à exiger ; une étiquette illisible garde la release en brouillon.
    expect(mediaProblems("0.2.0-beta.1", "")).toEqual([]);
    expect(mediaProblems("0.2", "").join()).toMatch(/illisible/);
  });
});
