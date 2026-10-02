// SPDX-License-Identifier: AGPL-3.0-only
// Console de SYM Browser (cdc/sym-browser 04d § 5) : servie par la passerelle en production (même origine, CSP stricte).
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  server: { host: '127.0.0.1' },
  build: {
    // Aucun script ni aucune CSS en ligne dans le HTML produit : CSP `script-src 'self'; style-src 'self'`.
    assetsInlineLimit: 0,
  },
  test: { include: ['src/**/*.test.ts'] },
});
