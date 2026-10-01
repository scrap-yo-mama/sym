// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée de la console : i18n (langue active chargée avant le premier rendu), routeur, session.
import { createApp } from 'vue';
import App from './App.vue';
import './assets/main.css';
import { createAppI18n, detectLocale, LOCALE_STORAGE_KEY, setLocale } from './i18n';
import { onMfaBarrier, onUnauthorized } from './lib/api';
import { markExpired, ensureSession, loadSession } from './composables/useSession';
import { createAppRouter } from './router';
import { applyTheme } from './lib/theme';
import { theme } from './composables/usePreferences';

async function main(): Promise<void> {
  const i18n = createAppI18n();
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    /* stockage indisponible */
  }
  await setLocale(i18n.global, detectLocale(stored, navigator.language));
  applyTheme(theme.value);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(theme.value));

  onUnauthorized(markExpired);
  onMfaBarrier(() => void loadSession());
  await ensureSession();
  const router = createAppRouter();
  createApp(App).use(i18n).use(router).mount('#app');
}

void main();
