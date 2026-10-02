// SPDX-License-Identifier: AGPL-3.0-only
// ESLint 10, flat config. typescript-eslint en règles recommandées (sans typage : rapide, sans faux positifs de projet).
// Composants .vue de la console (tâche 3.3) : eslint-plugin-vue (règles recommandées), script en TypeScript.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';
// Frontière du module SYM Browser (ADR 23 § 2) : règle locale, versionnée avec le module.
import { browserBoundaries } from './modules/browser/eslint.boundaries.mjs';

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
  {
    files: ['**/*.vue'],
    extends: [js.configs.recommended, tseslint.configs.recommended, pluginVue.configs['flat/recommended']],
    languageOptions: { parser: vueParser, parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'], sourceType: 'module' } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      // Les globales du navigateur (document, Event…) sont vérifiées par vue-tsc, pas par no-undef.
      'no-undef': 'off',
      // Props optionnelles typées en TypeScript : pas de valeur par défaut imposée.
      'vue/require-default-prop': 'off',
      // Jamais de HTML non maîtrisé dans l'origine de la console (08b § 2).
      'vue/no-v-html': 'error',
      // Reformatage libre (composants shadcn-vue copiés tels quels) : on ne vérifie que le fond, pas la mise en forme.
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/html-indent': 'off',
      'vue/first-attribute-linebreak': 'off',
    },
  },
  {
    // Composants copiés de shadcn-vue : noms d'un seul mot (Button, Card…) voulus par la bibliothèque.
    files: ['apps/web/src/components/ui/**/*.vue', 'apps/web/src/views/*.vue', 'apps/web/src/App.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
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
  browserBoundaries,
);
