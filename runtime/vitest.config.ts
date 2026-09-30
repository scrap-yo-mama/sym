import { defineConfig } from 'vitest/config';

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
