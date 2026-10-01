// SPDX-License-Identifier: AGPL-3.0-only
// Compatibilité avec la CSP stricte de la console (08b § 2 : `script-src 'self'`, `style-src 'self'`) et garde contre le
// HTML non maîtrisé : ni script ni style en ligne dans le HTML servi, aucun `v-html` (jamais de HTML scrapé dans l'origine
// de la console ; un aperçu HTML passera par un <iframe sandbox> sans allow-same-origin, tâche 3.4).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const webRoot = new URL('..', import.meta.url).pathname;

function sources(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? sources(full, ext) : ext.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

describe('CSP stricte', () => {
  const html = readFileSync(join(webRoot, 'index.html'), 'utf8');

  test('index.html : aucun script en ligne, aucun style en ligne, aucun gestionnaire d’événement', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  test('le script d’amorçage du thème est un fichier externe', () => {
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(readFileSync(join(webRoot, 'public/theme-init.js'), 'utf8')).toContain("classList.toggle('dark'");
  });

  test('aucun composant n’embarque de bloc <style> (le CSS passe par Tailwind, fichier externe au build)', () => {
    for (const file of sources(join(webRoot, 'src'), /\.vue$/)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/<style[\s>]/i);
  });

  test('aucun v-html, innerHTML ni insertAdjacentHTML dans la console', () => {
    for (const file of sources(join(webRoot, 'src'), /\.(vue|ts)$/)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/v-html|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    }
  });
});
