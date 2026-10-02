// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée de la console : thème SYM (jetons et polices de packages/ui), langue du navigateur.
import '@runtime/ui/theme.css';
import { createApp } from 'vue';
import App from './App.vue';
import { createConsoleI18n, normalizeLocale } from './i18n.js';

const locale = normalizeLocale(navigator.language);
document.documentElement.lang = locale;
createApp(App).use(createConsoleI18n(locale)).mount('#app');
