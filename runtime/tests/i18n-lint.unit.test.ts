// SPDX-License-Identifier: AGPL-3.0-only
// Porte de CI « messages et gabarits » de la console (21 § 9, tâche 3.20) : `@intlify/eslint-plugin-vue-i18n` refuse une clé
// absente du catalogue (`no-missing-keys`) et un texte brut dans un gabarit (`no-raw-text`) ; la ponctuation et les symboles
// restent permis. Contrôlé sur la configuration réelle du dépôt (eslint.config.mjs), avec un composant de sonde jamais écrit sur disque.
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const PROBE = 'apps/web/src/components/ZzI18nLintProbe.vue';

const lint = async (template: string): Promise<string[]> => {
  const eslint = new ESLint({ cwd: root });
  const source = `<script setup lang="ts">\nimport { useI18n } from 'vue-i18n';\nconst { t } = useI18n();\n</script>\n\n<template>\n  ${template}\n</template>\n`;
  const [result] = await eslint.lintText(source, { filePath: `${root}/${PROBE}` });
  return (result?.messages ?? []).map((m) => m.ruleId ?? m.message);
};

describe('ESLint vue-i18n de la console (21 § 9)', () => {
  test('assert_i18n_lint_gates : clé absente et texte brut refusés ; clé existante, ponctuation et symboles permis', async () => {
    expect(await lint(`<p>{{ t('zz.cle.inexistante') }}</p>`)).toContain('@intlify/vue-i18n/no-missing-keys');
    expect(await lint(`<p>Hello world</p>`)).toContain('@intlify/vue-i18n/no-raw-text');
    expect(await lint(`<p>{{ t('app.skipToContent') }} (·) — …</p>`)).toEqual([]);
  }, 60_000);
});
