// SPDX-License-Identifier: AGPL-3.0-only
// Extension Chrome MV3 (07 § 4, § 7) : WXT 0.21.4. Manifeste dans src/manifest.ts (assert_optional_hosts).
// Pas d'auto-imports : chaque module importe ce qu'il utilise. Popup en Vue 3 sans compilateur de gabarits.
// `wxt zip` (tâche 2.9) produit dist/scrapyomama-<version>-chrome.zip, le paquet du Chrome Web Store.
import { defineConfig } from 'wxt';
import { MANIFEST } from './src/manifest.ts';

export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',
  imports: false,
  manifestVersion: 3,
  browser: 'chrome',
  manifest: MANIFEST,
  zip: { name: 'scrapyomama', artifactTemplate: '{{name}}-{{packageVersion}}-{{browser}}.zip' },
});
