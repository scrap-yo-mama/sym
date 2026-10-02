// SPDX-License-Identifier: AGPL-3.0-only
// Régression visuelle par langue, part de 3.6 confiée à 3.17 (Catalogue et Nouvelle API, 21b § 6) : ce fichier garde le
// dispositif lui-même ; le navigateur est e2e/visual.e2e.ts. assert_visual_regression_by_locale : projets ui-en, ui-fr et
// ui-pseudo sur la suite visuelle, instantanés de référence présents pour chaque écran, thème et langue sur la plateforme qui
// les a créés. assert_no_hardcoded_strings_pseudo et assert_no_text_overflow_pseudo : la pseudo-locale marque chaque chaîne du
// catalogue, l'allonge et garde la syntaxe de vue-i18n (sinon un texte en clair ou un débordement passerait inaperçu).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import config from '../playwright.config.ts';
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
