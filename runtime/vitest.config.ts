import { defineConfig } from 'vitest/config';

// Trois projets (15 §2). Suffixes : *.unit.test.ts, *.prop.test.ts, *.integration.test.ts, *.contract.test.ts
export default defineConfig({
  test: {
    passWithNoTests: true,
    // Couverture produite localement et publiée en artefact par le job unit : aucun seuil avant la fin de la W0.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.{unit,prop}.test.ts',
            'apps/*/src/**/*.{unit,prop}.test.ts',
            'tests/**/*.{unit,prop}.test.ts',
            'tests/invariants.todo.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
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
            'tests/**/*.contract.test.ts',
          ],
        },
      },
    ],
  },
});
