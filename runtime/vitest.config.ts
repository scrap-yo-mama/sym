// SPDX-License-Identifier: AGPL-3.0-only
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const webSrc = fileURLToPath(new URL('./apps/web/src', import.meta.url));

// Trois projets (15 §2). Suffixes : *.unit.test.ts, *.prop.test.ts, *.integration.test.ts, *.contract.test.ts
export default defineConfig({
  test: {
    passWithNoTests: true,
    // Couverture produite localement et publiée en artefact par le job unit : aucun seuil avant la fin de la W0.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'fixtures/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
    },
    projects: [
      {
        // Composants .vue de la console (tâche 3.3) : rendu côté serveur sous Node, sans navigateur ; alias `@` de apps/web.
        plugins: [vue()],
        resolve: { alias: { '@': webSrc } },
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.{unit,prop}.test.ts',
            'apps/*/src/**/*.{unit,prop}.test.ts',
            'fixtures/src/**/*.{unit,prop}.test.ts',
            'tests/**/*.{unit,prop}.test.ts',
            'tests/invariants.todo.test.ts',
            // Banc d'évaluation (15 §11) : seuls ses tests unitaires tournent en PR, jamais un run LLM.
            'eval/**/*.{unit,prop}.test.ts',
          ],
        },
      },
      {
        // La console (3.3) a un test d'intégration (serveur réel + composables) : mêmes plugin et alias que `unit`.
        plugins: [vue()],
        resolve: { alias: { '@': webSrc } },
        test: {
          name: 'integration',
          // Un conteneur PostgreSQL (PG_VERSION, défaut 16) par exécution ; une base par fichier (tests/helpers/pg.ts).
          globalSetup: ['tests/setup/postgres.global.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          include: [
            'packages/*/src/**/*.integration.test.ts',
            'apps/*/src/**/*.integration.test.ts',
            'tests/**/*.integration.test.ts',
          ],
        },
      },
      {
        test: {
          // Étage S (15 §2) : SSRF (Chromium compris), bac à sable, télémétrie. `pnpm test:security`.
          name: 'security',
          testTimeout: 60_000,
          hookTimeout: 120_000,
          include: [
            'packages/*/src/**/*.security.test.ts',
            'apps/*/src/**/*.security.test.ts',
            'tests/**/*.security.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'contract',
          include: [
            'packages/*/src/**/*.contract.test.ts',
            'apps/*/src/**/*.contract.test.ts',
            'fixtures/src/**/*.contract.test.ts',
            'tests/**/*.contract.test.ts',
          ],
        },
      },
    ],
  },
});
