<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { usePreferences } from '@/composables/usePreferences';
import { LANGUAGE_CHOICES, isLocale } from '@/i18n';
import { THEMES, isTheme } from '@/lib/theme';

const { t, locale } = useI18n();
const { changeLocale, changeTheme, theme } = usePreferences();

const selectClass =
  'border-input bg-background text-foreground h-11 rounded-md border px-2 text-sm focus-visible:border-ring outline-none';

function onLocale(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (isLocale(value)) void changeLocale(value);
}

function onTheme(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (isTheme(value)) changeTheme(value);
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <div class="flex items-center gap-2">
      <label for="pref-language" class="sr-only">{{ t('nav.language') }}</label>
      <select id="pref-language" :class="selectClass" :value="locale" @change="onLocale">
        <option v-for="choice in LANGUAGE_CHOICES" :key="choice.code" :value="choice.code" :lang="choice.code">{{ choice.endonym }}</option>
      </select>
    </div>
    <div class="flex items-center gap-2">
      <label for="pref-theme" class="sr-only">{{ t('nav.theme') }}</label>
      <select id="pref-theme" :class="selectClass" :value="theme" @change="onTheme">
        <option v-for="name in THEMES" :key="name" :value="name">{{ t(`nav.themes.${name}`) }}</option>
      </select>
    </div>
  </div>
</template>
