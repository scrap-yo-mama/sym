// SPDX-License-Identifier: AGPL-3.0-only
// ESLint 10, flat config. typescript-eslint en règles recommandées (sans typage : rapide, sans faux positifs de projet).
// Composants .vue de la console (tâche 3.3) : eslint-plugin-vue (règles recommandées), script en TypeScript.
import vueI18n from '@intlify/eslint-plugin-vue-i18n';
import js from '@eslint/js';
import { readFileSync } from 'node:fs';
import { defineConfig, globalIgnores } from 'eslint/config';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

// Langues du produit : `registry.json` est la seule liste (21 § 2) ; aucune langue n'est écrite ici (M14).
const localeCodes = JSON.parse(readFileSync(new URL('./packages/i18n/locales/registry.json', import.meta.url), 'utf8')).languages.map((l) => l.code);

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
  // Messages et gabarits de la console (21 § 9, tâche 3.20) : syntaxe des messages, aucun HTML dans un message, clés existantes,
  // formes de pluriel valides, aucun `v-html`. Le catalogue est celui de `packages/i18n` (clés historiques de la console conservées).
  {
    files: ['apps/web/src/**/*.{ts,vue}'],
    ignores: ['**/*.test.ts', '**/testing/**'],
    extends: [vueI18n.configs['flat/base']],
    settings: {
      'vue-i18n': {
        localeDir: { pattern: `./packages/i18n/locales/{${localeCodes.join(',')}}.json`, localeKey: 'file' },
        messageSyntaxVersion: '^11.0.0',
      },
    },
    rules: {
      '@intlify/vue-i18n/valid-message-syntax': 'error',
      '@intlify/vue-i18n/no-html-messages': 'error',
      '@intlify/vue-i18n/no-v-html': 'error',
      '@intlify/vue-i18n/valid-plural-forms': 'error',
      '@intlify/vue-i18n/no-missing-keys-in-other-locales': 'error',
      '@intlify/vue-i18n/no-duplicate-keys-in-locale': 'error',
      '@intlify/vue-i18n/no-missing-keys': 'error',
      // Texte brut dans un gabarit (21 § 9) : seuls la ponctuation, les symboles et des noms techniques identiques dans toutes les
      // langues (fichiers lus sur le site, préfixe de version, multiplicateur de vitesse) restent permis.
      '@intlify/vue-i18n/no-raw-text': ['error', { ignorePattern: '^[\\s()\\[\\]:;,.*·—–…×∅⦸◆!/|+-]*$', ignoreText: ['llms.txt', 'robots', 'v', 'x'] }],
    },
  },
  // Catalogues eux-mêmes : syntaxe vue-i18n 11, aucun HTML dans un message (« une phrase = une clé », 21b § 3), pluriels valides, clés uniques.
  {
    files: [`packages/i18n/locales/{${localeCodes.join(',')}}.json`],
    extends: [vueI18n.configs['flat/base']],
    settings: { 'vue-i18n': { localeDir: { pattern: `./packages/i18n/locales/{${localeCodes.join(',')}}.json`, localeKey: 'file' }, messageSyntaxVersion: '^11.0.0' } },
    rules: {
      '@intlify/vue-i18n/valid-message-syntax': 'error',
      '@intlify/vue-i18n/no-html-messages': 'error',
      '@intlify/vue-i18n/valid-plural-forms': 'error',
      '@intlify/vue-i18n/no-duplicate-keys-in-locale': 'error',
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
      // Silence d'un avertissement de bibliothèque tiers (`@intlify/core-base` en développement) et détection du repli de `cronstrue`.
      'packages/i18n/src/render.ts',
      'packages/i18n/src/cron.ts',
      'packages/i18n/scripts/**',
    ],
    rules: { 'no-console': 'error' },
  },
);
