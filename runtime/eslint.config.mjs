// ESLint 10, flat config. typescript-eslint en règles recommandées (sans typage : rapide, sans faux positifs de projet).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', '**/blob-report/', '**/test-results/', '**/playwright-report/', '**/node_modules/']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  // 14 § 10 : pas de console.* dans le code des services (le journal pino masque, console non). Exceptions : la CLI (sortie
  // destinée à l'humain) et les messages de démarrage, émis avant que le journal existe (refus de démarrer, variable ignorée).
  {
    files: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      '**/*.testkit.ts',
      '**/testing/**',
      'apps/cli/**',
      'apps/server/src/index.ts',
      'apps/server/src/config.ts',
      'apps/worker/src/main.ts',
      'packages/core/src/crypto/master-key.ts',
    ],
    rules: { 'no-console': 'error' },
  },
);
