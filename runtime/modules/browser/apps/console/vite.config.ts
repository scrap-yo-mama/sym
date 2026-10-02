// SPDX-License-Identifier: AGPL-3.0-only
// Console de SYM Browser (cdc/sym-browser 04d § 5) : servie par la passerelle en production (même origine, cookie
// `__Host-`, CSP stricte). Sous `vite`, l'authentification est simulée (src/main.ts) tant que la tâche 2.1 n'est pas là.
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  build: {
    // Aucun script ni aucune CSS en ligne dans le HTML produit : CSP `script-src 'self'; style-src 'self'`.
    assetsInlineLimit: 0,
  },
  test: { include: ['src/**/*.test.ts'] },
});
