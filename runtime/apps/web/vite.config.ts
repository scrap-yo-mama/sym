// SPDX-License-Identifier: AGPL-3.0-only
// Console Vue 3.5 (ADR 0002). En production, la console est servie par `server` (même origine : cookie `__Host-`, CSP
// stricte 08b § 2) ; en développement, Vite relaie /api vers le serveur (RUNTIME_API_URL, défaut http://127.0.0.1:3000).
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const apiTarget = process.env.RUNTIME_API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
  preview: { host: '127.0.0.1', proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
  build: {
    // Aucune CSS ni aucun script en ligne dans le HTML produit : CSP `script-src 'self'; style-src 'self'`.
    assetsInlineLimit: 0,
    cssCodeSplit: true,
  },
});
