// SPDX-License-Identifier: AGPL-3.0-only
// Régression visuelle par langue, part de 3.6 confiée à 3.17 (Catalogue et Nouvelle API, 21b § 6) : ce fichier garde le
// dispositif lui-même ; le navigateur est e2e/visual.e2e.ts. assert_visual_regression_by_locale : projets ui-en, ui-fr et
// ui-pseudo sur la suite visuelle, instantanés de référence présents pour chaque écran, thème et langue sur la plateforme qui
// les a créés. assert_no_hardcoded_strings_pseudo et assert_no_text_overflow_pseudo : la pseudo-locale marque chaque chaîne du
// catalogue, l'allonge et garde la syntaxe de vue-i18n (sinon un texte en clair ou un débordement passerait inaperçu).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import config from '../playwright.config.ts';
import { visualMode } from '../e2e/visual-policy.ts';
import { PSEUDO_CLOSE, PSEUDO_OPEN, pseudoMessage, pseudoMessages } from '../e2e/pseudo.ts';
import en from '@/i18n/locales/en.json';

const VISUAL_DIR = new URL('../e2e/__visual__/', import.meta.url);
const SCREENS = ['catalog', 'catalog-all', 'new-api-gate'];
const THEMES = ['light', 'dark'];
const PROJECTS = ['ui-en', 'ui-fr', 'ui-pseudo'];

function leaves(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (typeof node === 'object' && node !== null) return Object.entries(node).flatMap(([key, value]) => leaves(value, path ? `${path}.${key}` : key));
  return [];
}

describe('assert_visual_regression_by_locale : projets par langue et instantanés de référence', () => {
  test('la suite visuelle tourne dans les projets ui-en, ui-fr et ui-pseudo, et seulement là', () => {
    const projects = config.projects ?? [];
    for (const name of PROJECTS) {
      const project = projects.find((entry) => entry.name === name);
      expect(project, name).toBeDefined();
      expect(String(project?.testMatch)).toContain('visual');
      expect((project?.use as { uiLocale?: string } | undefined)?.uiLocale).toBe(name.slice(3));
    }
    expect(String(projects.find((entry) => entry.name === 'console')?.testIgnore)).toContain('visual');
    expect(readFileSync(new URL('../e2e/visual.e2e.ts', import.meta.url), 'utf8')).toMatch(/const VISUAL_SCREENS = \['catalog', 'catalog-all', 'new-api-gate'\]/);
  });

  test('chaque plateforme qui a des instantanés les a tous : 3 écrans × 2 thèmes × 3 langues', () => {
    const platforms = existsSync(VISUAL_DIR) ? readdirSync(VISUAL_DIR) : [];
    expect(platforms.length, 'au moins une plateforme de référence').toBeGreaterThan(0);
    for (const platform of platforms) {
      for (const project of PROJECTS) {
        const dir = new URL(`${platform}/${project}/`, VISUAL_DIR);
        const files = existsSync(dir) ? readdirSync(dir) : [];
        for (const screen of SCREENS) for (const theme of THEMES) expect(files, `${platform}/${project}`).toContain(`${screen}-${theme}.png`);
      }
    }
  });
});

describe('assert_no_hardcoded_strings_pseudo, assert_no_text_overflow_pseudo : la pseudo-locale', () => {
  test('chaque chaîne du catalogue anglais est marquée ⟦ ⟧, accentuée et allongée', () => {
    for (const [key, value] of leaves(pseudoMessages(en))) {
      if (value.trim() === '') continue;
      for (const form of value.split('|')) {
        if (form.includes('@:')) continue;
        expect(form, key).toContain(PSEUDO_OPEN);
        expect(form, key).toContain(PSEUDO_CLOSE);
      }
    }
    expect(pseudoMessage('Search')).toMatch(/^⟦Šéáŕçĥ ·+⟧$/u);
    expect(Array.from(pseudoMessage('Validate the schema')).length).toBeGreaterThan(Array.from('Validate the schema').length * 1.3);
  });

  test('la syntaxe de vue-i18n est gardée : paramètres, formes plurielles, liens', () => {
    expect(pseudoMessage('{n} of {total} healthy')).toMatch(/^⟦\{n\} óƒ \{total\} ĥéáĺţĥý ·+⟧$/u);
    expect(pseudoMessage('No API | 1 API | {n} APIs').split('|')).toHaveLength(3);
    expect(pseudoMessage('@:common.retry')).toBe('@:common.retry');
  });
});

describe('assert_visual_baselines_ci_platform (renfort d’assert_visual_regression_by_locale) : la CI compare toujours (instantanés de sa plateforme, image épinglée)', () => {
  const runtimeRoot = new URL('../../../', import.meta.url);
  const read = (path: string): string => readFileSync(new URL(path, runtimeRoot), 'utf8');
  const base = { ci: false, hasBaselines: true, updating: false, inImage: false };

  test('mode : comparer quand les références existent ; en CI sans références, erreur (jamais de réussite silencieuse)', () => {
    expect(visualMode({ ...base, platform: 'darwin' })).toBe('compare');
    expect(visualMode({ ...base, platform: 'darwin', hasBaselines: false })).toBe('ignore');
    expect(() => visualMode({ ...base, platform: 'darwin', hasBaselines: false, ci: true })).toThrow(/aucun instantané de référence pour darwin/);
    expect(() => visualMode({ ...base, platform: 'linux', inImage: true, hasBaselines: false, ci: true })).toThrow(/aucun instantané de référence pour linux/);
    expect(visualMode({ ...base, platform: 'linux', inImage: true, ci: true })).toBe('compare');
    expect(visualMode({ ...base, platform: 'darwin', updating: true, hasBaselines: false, ci: true })).toBe('update');
  });

  test('linux hors de l’image épinglée : suite sautée avec sa raison, jamais comparée ni écrite (polices du système)', () => {
    for (const ci of [true, false]) for (const updating of [true, false]) expect(visualMode({ ...base, platform: 'linux', ci, updating })).toBe('excluded');
    const suite = readFileSync(new URL('../e2e/visual.e2e.ts', import.meta.url), 'utf8');
    expect(suite).toMatch(/test\.skip\(process\.env\.SYM_VISUAL_MODE === 'excluded'/);
    const projects = config.projects ?? [];
    for (const name of PROJECTS) expect(projects.find((entry) => entry.name === name)?.ignoreSnapshots, name).toBe(false);
  });

  test('les instantanés de linux, plateforme de la CI, sont là au complet, comme ceux de darwin', () => {
    const platforms = readdirSync(VISUAL_DIR);
    expect(platforms).toEqual(expect.arrayContaining(['darwin', 'linux']));
    for (const project of PROJECTS) {
      expect(readdirSync(new URL(`linux/${project}/`, VISUAL_DIR)).sort(), project).toEqual(readdirSync(new URL(`darwin/${project}/`, VISUAL_DIR)).sort());
    }
  });

  test('la CI officielle et la CI locale jouent la suite visuelle dans l’image Playwright épinglée de deploy/Dockerfile', () => {
    const workflow = read('../.github/workflows/ci.yml');
    const e2eJob = /\n {2}e2e:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/.exec(workflow)?.[1] ?? '';
    expect(e2eJob).toMatch(/run: pnpm visual:image\b/);
    expect(read('scripts/ci-local.ts')).toMatch(/cmd: \['pnpm', 'visual:image'\]/);
    const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(manifest.scripts['visual:image']).toBe('node scripts/visual-image.ts');
    const script = read('scripts/visual-image.ts');
    // Une seule image, épinglée par empreinte : celle de deploy/Dockerfile, lue par le script (jamais une étiquette mobile).
    expect(script).toContain('deploy/Dockerfile');
    expect(script).toContain('SYM_VISUAL_IMAGE=1');
    expect(script).not.toMatch(/playwright:v\d/);
    expect(read('deploy/Dockerfile')).toMatch(/^ARG PLAYWRIGHT_IMAGE=mcr\.microsoft\.com\/playwright:v[\d.]+-noble@sha256:[0-9a-f]{64}$/m);
  });
});
