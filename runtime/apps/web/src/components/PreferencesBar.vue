<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { usePreferences } from '@/composables/usePreferences';
import { LOCALES, isLocale } from '@/i18n';
import { MOTIONS, isMotion } from '@/lib/motion';
import { THEMES, isTheme } from '@/lib/theme';

const { t, locale } = useI18n();
const { changeLocale, changeMotion, changeTheme, motion, theme } = usePreferences();

/** Noms de langue dans leur propre langue : ils ne se traduisent pas. */
const LOCALE_NAMES: Record<(typeof LOCALES)[number], string> = { en: 'English', fr: 'Français' };

const selectClass =
  'border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm focus-visible:border-ring outline-none';

function onLocale(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (isLocale(value)) void changeLocale(value);
}

function onMotion(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (isMotion(value)) changeMotion(value);
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
        <option v-for="code in LOCALES" :key="code" :value="code" :lang="code">{{ LOCALE_NAMES[code] }}</option>
      </select>
    </div>
    <div class="flex items-center gap-2">
      <label for="pref-theme" class="sr-only">{{ t('nav.theme') }}</label>
      <select id="pref-theme" :class="selectClass" :value="theme" @change="onTheme">
        <option v-for="name in THEMES" :key="name" :value="name">{{ t(`nav.themes.${name}`) }}</option>
      </select>
    </div>
    <div class="flex items-center gap-2">
      <label for="pref-motion" class="sr-only">{{ t('nav.motion') }}</label>
      <select id="pref-motion" :class="selectClass" :value="motion" @change="onMotion">
        <option v-for="name in MOTIONS" :key="name" :value="name">{{ t(`nav.motions.${name}`) }}</option>
      </select>
    </div>
  </div>
</template>
