<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file LocaleSwitcher.vue
 * @description Choix de la langue dans l'en-tête (04d § 5.1) : liste native libellée (clavier et lecteurs d'écran sans
 * effort), chaque langue nommée dans sa propre langue (attribut lang). Le choix est mémorisé dans le navigateur.
 * @component
 */
import { useI18n } from 'vue-i18n';
import { applyLocale } from '../locale.js';
import { isLocale, LOCALES } from '../i18n.js';

const { t, locale } = useI18n();

function change(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (isLocale(value)) applyLocale(locale, value);
}
</script>

<template>
  <div class="flex items-center gap-2">
    <label for="console-locale" class="text-sm text-nav-muted-foreground">{{ t('console.common.language') }}</label>
    <select
      id="console-locale"
      :value="locale"
      class="min-h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring"
      @change="change"
    >
      <option v-for="code in LOCALES" :key="code" :value="code" :lang="code">{{ t(`console.common.languages.${code}`) }}</option>
    </select>
  </div>
</template>
