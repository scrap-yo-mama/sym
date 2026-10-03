// SPDX-License-Identifier: AGPL-3.0-only
// Couverture des gates de la landing (22b § 4) : chaque test nommé de la tâche 4.11 est dans tests/invariants.json et existe dans un
// fichier de test du bon étage. Les tests jugés en Chromium (apps/docs/e2e/*.e2e.ts, `pnpm --filter @runtime/docs test:e2e`) ne sont
// pas des *.test.ts : ce fichier les nomme et vérifie qu'ils existent, comme apps/web/src/a11y.unit.test.ts pour la console.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const docsDir = new URL('../../', import.meta.url).pathname;
const runtimeDir = join(docsDir, '..', '..');
const read = (dir: string, filter: RegExp): string => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) => filter.test(file) && !file.includes('node_modules')).map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');

/** Jugés dans Chromium sur la préproduction : e2e/*.e2e.ts. */
const E2E = [
  'assert_landing_no_signup',
  'assert_landing_no_third_party_request',
  'assert_landing_no_third_party_tracker',
  'assert_landing_no_cookie',
  'assert_landing_csp_strict',
  'assert_landing_reduced_motion',
  'assert_landing_a11y_axe_clean',
  'assert_landing_perf_budget',
];
/** Jugés sur le contenu ou sur le site construit, sans navigateur : src/landing/*.test.ts. */
const BUILD = [
  'assert_landing_seo_meta',
  'assert_landing_i18n_parity',
  'assert_landing_hreflang_reciprocal',
  'assert_landing_links_resolve',
  'assert_landing_stars_build_time',
  'assert_landing_no_bypass_copy',
  'assert_landing_no_third_party_brand',
  'assert_landing_claims_sourced',
  'assert_landing_fr_tutoiement',
  'assert_landing_ghost_icon',
  'assert_landing_demo_allowlist',
  'assert_landing_contrast_tokens',
  'assert_legal_pages_reference_clause',
  'assert_landing_csp_strict',
  'assert_landing_no_signup',
];
/** V1.1 : test.todo (tests/invariants.todo.test.ts). */
const TODO = ['assert_landing_demo_matches_recording'];

describe('gates de la landing : couverture de 22b § 4', () => {
  const table = JSON.parse(readFileSync(join(runtimeDir, 'tests/invariants.json'), 'utf8')) as { test: string; tasks: string[] }[];
  const e2e = read(join(docsDir, 'e2e'), /\.e2e\.ts$/);
  const built = read(join(docsDir, 'src/landing'), /\.test\.ts$/).replace(/const (?:E2E|BUILD|TODO) = \[[\s\S]*?\];/g, '');

  test('chaque gate de 4.11 est dans la table des tests nommés, rattachée à la tâche 4.11', () => {
    for (const name of new Set([...E2E, ...BUILD, ...TODO])) {
      const row = table.find((entry) => entry.test === name);
      expect(row, name).toBeDefined();
      expect(row?.tasks, name).toContain('4.11');
    }
  });

  test('chaque gate jugée dans Chromium est un test de apps/docs/e2e', () => {
    for (const name of E2E) expect(e2e, name).toContain(name);
  });

  test('chaque gate jugée sur le contenu ou le site construit est un test (ni test.todo ni simple mention)', () => {
    for (const name of BUILD) expect(new RegExp(`(?:describe|test)\\(\\s*['"\`]${name}`).test(built), name).toBe(true);
  });

  test('les gates de V1.1 sont des test.todo', () => {
    const todo = readFileSync(join(runtimeDir, 'tests/invariants.todo.test.ts'), 'utf8');
    for (const name of TODO) expect(todo).toContain(`test.todo("${name}")`);
  });

  test('tous les assert_landing_* du catalogue de 22b § 4 sont couverts, V1.1 comprise', () => {
    const catalogue = new Set(['assert_landing_no_signup', 'assert_landing_no_third_party_request', 'assert_landing_no_third_party_tracker', 'assert_landing_no_cookie', 'assert_landing_csp_strict', 'assert_landing_no_bypass_copy', 'assert_landing_no_third_party_brand', 'assert_landing_claims_sourced', 'assert_landing_fr_tutoiement', 'assert_landing_ghost_icon', 'assert_landing_demo_allowlist', 'assert_landing_reduced_motion', 'assert_landing_demo_matches_recording', 'assert_landing_a11y_axe_clean', 'assert_landing_contrast_tokens', 'assert_landing_perf_budget', 'assert_landing_seo_meta', 'assert_landing_i18n_parity', 'assert_landing_hreflang_reciprocal', 'assert_landing_links_resolve', 'assert_landing_stars_build_time']);
    const covered = new Set([...E2E, ...BUILD, ...TODO]);
    for (const name of catalogue) expect(covered.has(name), name).toBe(true);
  });
});
