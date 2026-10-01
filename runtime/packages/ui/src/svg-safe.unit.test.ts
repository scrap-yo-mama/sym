// SPDX-License-Identifier: AGPL-3.0-only
// assert_svg_safe (20b § 3.1, U1) : tout SVG versionné (packages/ui, .github/assets/, apps/docs/public/, et les SVG en ligne
// des composants) passe le contrôle ; l'icône SYM de packages/ui est en `currentColor`, sans texte, et identique au tracé
// que les composants rendent (une seule icône pour la console, l'extension et le site de doc).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { inlineSvgs, svgProblems } from './testing/svg-safe.ts';
import { listFiles } from './testing/color-rules.ts';
import { SYM_GHOST_PATH, SYM_GHOST_VIEWBOX } from './sym-ghost.ts';

const uiRoot = new URL('..', import.meta.url).pathname;
const repoRoot = new URL('../../../../', import.meta.url).pathname;
const runtimeRoot = join(repoRoot, 'runtime');
const NO_SKIP = /(^|\/)(node_modules|dist|\.wxt|\.output)(\/|$)/;

/** SVG versionnés : (dossier, règle « aucun texte » ?). Un dossier absent n'a pas encore de SVG. */
const FILE_SCOPES: readonly { dir: string; noText: boolean }[] = [
  { dir: uiRoot, noText: true },
  { dir: join(repoRoot, '.github/assets'), noText: false },
  { dir: join(runtimeRoot, 'apps/docs/public'), noText: false },
];

describe('assert_svg_safe', () => {
  test('chaque fichier .svg versionné passe le contrôle', () => {
    const report: string[] = [];
    let seen = 0;
    for (const { dir, noText } of FILE_SCOPES) {
      if (!existsSync(dir)) continue;
      for (const file of listFiles(dir, /\.svg$/, NO_SKIP)) {
        seen += 1;
        for (const problem of svgProblems(readFileSync(file, 'utf8'), { noText })) report.push(`${file} : ${problem}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(report).toEqual([]);
  });

  test('les SVG en ligne des gabarits (packages/ui, console, extension) passent le contrôle', () => {
    const report: string[] = [];
    for (const dir of [uiRoot, join(runtimeRoot, 'apps/web/src'), join(runtimeRoot, 'apps/extension/src')]) {
      for (const file of listFiles(dir, /\.(vue|ts)$/, /(^|\/)(node_modules|dist|\.wxt|\.output|testing)(\/|$)/)) {
        for (const svg of inlineSvgs(readFileSync(file, 'utf8'))) {
          for (const problem of svgProblems(svg, { noText: dir === uiRoot })) report.push(`${file} : ${problem}`);
        }
      }
    }
    expect(report).toEqual([]);
  });

  test('le contrôle refuse un SVG fautif', () => {
    const bad: [string, string][] = [
      ['<script', '<svg><script>alert(1)</script></svg>'],
      ['attribut on*', '<svg onload="x()"></svg>'],
      ['<foreignObject', '<svg><foreignObject/></svg>'],
      ['lien externe', '<svg><use href="https://exemple.test/a.svg#b"/></svg>'],
      ['@import', '<svg><defs>@import url(a.css)</defs></svg>'],
      ['<style', '<svg><style>a{}</style></svg>'],
      ['style=', '<svg><path style="fill:red"/></svg>'],
      ['image externe', '<svg><image href="//exemple.test/a.png"/></svg>'],
    ];
    for (const [reason, svg] of bad) expect(svgProblems(svg, { noText: false }).length, reason).toBeGreaterThan(0);
    expect(svgProblems('<svg><text>SYM</text></svg>', { noText: true })).toHaveLength(1);
    expect(svgProblems('<svg><text>SYM</text></svg>', { noText: false })).toEqual([]);
    expect(svgProblems('<svg><use href="#a"/></svg>', { noText: true })).toEqual([]);
  });
});

describe('icône SYM', () => {
  const svg = readFileSync(join(uiRoot, 'icons/sym-ghost.svg'), 'utf8');

  test('le fichier est en currentColor, décoratif, sans couleur en dur', () => {
    expect(svg).toContain('fill="currentColor"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });

  test('le tracé et le viewBox des composants sont ceux du fichier', () => {
    expect(/\sd="([^"]+)"/.exec(svg)?.[1]).toBe(SYM_GHOST_PATH);
    expect(/viewBox="([^"]+)"/.exec(svg)?.[1]).toBe(SYM_GHOST_VIEWBOX);
  });
});
