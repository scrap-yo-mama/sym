// SPDX-License-Identifier: AGPL-3.0-only
// ESLint 10, flat config. typescript-eslint en règles recommandées (sans typage : rapide, sans faux positifs de projet).
// Composants .vue de la console (tâche 3.3) : eslint-plugin-vue (règles recommandées), script en TypeScript.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

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
);
