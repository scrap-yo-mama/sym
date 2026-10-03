// SPDX-License-Identifier: MIT
// Exemple du README du SDK (cdc/sym-browser 04 § 10, A13 `sdk_readme_example`) : le bloc de code qui suit le marqueur
// `<!-- sdk_readme_example -->` est extrait tel quel et exécuté (contrôle de forme ici, exécution en mode `all` par
// tests/sdk-readme.chromium.test.ts à la racine du module).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const README_PATH = fileURLToPath(new URL('../../README.md', import.meta.url));
const MARKER = '<!-- sdk_readme_example -->';

export function readmeExample(text: string = readFileSync(README_PATH, 'utf8')): string {
  const start = text.indexOf(MARKER);
  if (start < 0) throw new Error(`README du SDK : marqueur ${MARKER} absent`);
  const block = /```ts\n([\s\S]*?)\n```/.exec(text.slice(start));
  if (!block?.[1]) throw new Error('README du SDK : bloc ```ts absent après le marqueur');
  return `${block[1]}\n`;
}
