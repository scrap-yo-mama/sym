// SPDX-License-Identifier: AGPL-3.0-only
// ESLint 10, flat config. typescript-eslint en règles recommandées (sans typage : rapide, sans faux positifs de projet).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/.wxt/', '**/.output/', '**/coverage/', '**/blob-report/', '**/test-results/', '**/playwright-report/', '**/node_modules/']),
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
);
