// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm brand:sync` (22 §3.3, u8 R4) : copie `.github/assets/brand/` vers le dossier public du site de doc, pour la landing (4.11).
// VitePress sert le dossier `public/` de son srcDir (`apps/docs/content`) : c'est là que la copie va.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetsDir, runtimeDir } from './paths.ts';

const BRAND_SOURCE = join(assetsDir, 'brand');
const BRAND_TARGET = join(runtimeDir, 'apps', 'docs', 'content', 'public', 'brand');

/** Fichiers de la marque qui diffèrent de leur copie (ou manquent). */
export function brandDrift(): string[] {
  return readdirSync(BRAND_SOURCE).filter((name) => {
    const target = join(BRAND_TARGET, name);
    return !existsSync(target) || !readFileSync(target).equals(readFileSync(join(BRAND_SOURCE, name)));
  });
}

export function brandSync(): string[] {
  mkdirSync(BRAND_TARGET, { recursive: true });
  const names = readdirSync(BRAND_SOURCE);
  for (const name of names) copyFileSync(join(BRAND_SOURCE, name), join(BRAND_TARGET, name));
  return names;
}
