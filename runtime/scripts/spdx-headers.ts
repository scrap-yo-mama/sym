// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.7 : en-têtes SPDX. Usage : `pnpm spdx:add` (ajoute les en-têtes manquants), `--check` (liste, code 1 s'il en manque).
// Licence attendue d'un fichier = champ `license` du package.json le plus proche (MIT pour packages/client et
// packages/schemas, AGPL-3.0-only ailleurs). Le choix `-only` ou `-or-later` reste à valider par un avocat (16 §1).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_LICENSE = 'AGPL-3.0-only';
export const MIT_PACKAGES = ['packages/client', 'packages/schemas'] as const;

const COMMENT_PREFIX: Record<string, string> = { ts: '//', mjs: '//', sql: '--', sh: '#' };
const HOOK_FILES = new Set(['scripts/hooks/pre-commit']);

/** Préfixe de commentaire du fichier, ou undefined si ce n'est pas une source soumise à l'en-tête. */
export function commentPrefix(path: string): string | undefined {
  if (HOOK_FILES.has(path)) return '#';
  const ext = /\.([a-z]+)$/.exec(path)?.[1];
  return ext === undefined ? undefined : COMMENT_PREFIX[ext];
}

/** Identifiant SPDX déclaré en ligne 1 (ou ligne 2 après un shebang), sinon undefined. */
export function findSpdx(content: string): string | undefined {
  const lines = content.split('\n', 3);
  const candidates = lines[0]?.startsWith('#!') ? [lines[1]] : [lines[0]];
  for (const line of candidates) {
    const match = /^(?:\/\/|--|#)\s*SPDX-License-Identifier:\s*(\S+)\s*$/.exec(line ?? '');
    if (match) return match[1];
  }
  return undefined;
}

export function addHeader(content: string, prefix: string, license: string): string {
  const header = `${prefix} SPDX-License-Identifier: ${license}`;
  if (content.startsWith('#!')) {
    const eol = content.indexOf('\n');
    return `${content.slice(0, eol + 1)}${header}\n${content.slice(eol + 1)}`;
  }
  return `${header}\n${content}`;
}

/** Sources du dépôt (suivies ou nouvelles, hors ignorées), chemins relatifs à runtime/. */
export function listSources(runtimeDir: string): string[] {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', '.'], { cwd: runtimeDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter((file) => file !== '' && commentPrefix(file) !== undefined && existsSync(join(runtimeDir, file)));
}

/** Licence attendue : champ `license` du package.json le plus proche (racine de runtime/ comprise). */
export function expectedLicense(runtimeDir: string, file: string): string {
  let dir = dirname(file);
  for (;;) {
    const manifest = join(runtimeDir, dir === '.' ? '' : dir, 'package.json');
    if (existsSync(manifest)) {
      const license = (JSON.parse(readFileSync(manifest, 'utf8')) as { license?: string }).license;
      if (license !== undefined) return license;
    }
    if (dir === '.') return DEFAULT_LICENSE;
    dir = dirname(dir);
  }
}

export function missingHeaders(runtimeDir: string): { file: string; license: string; prefix: string }[] {
  const missing: { file: string; license: string; prefix: string }[] = [];
  for (const file of listSources(runtimeDir)) {
    const prefix = commentPrefix(file);
    if (prefix !== undefined && findSpdx(readFileSync(join(runtimeDir, file), 'utf8')) === undefined) {
      missing.push({ file, license: expectedLicense(runtimeDir, file), prefix });
    }
  }
  return missing;
}

if (import.meta.main) {
  const runtimeDir = new URL('..', import.meta.url).pathname;
  const missing = missingHeaders(runtimeDir);
  if (process.argv.includes('--check')) {
    if (missing.length > 0) {
      console.error(`en-tête SPDX manquant (${missing.length}) :\n${missing.map((m) => `  - ${m.file}`).join('\n')}\nCorriger : pnpm spdx:add`);
      process.exit(1);
    }
    console.log('spdx : tous les fichiers source portent un en-tête.');
  } else {
    for (const { file, license, prefix } of missing) {
      const path = join(runtimeDir, file);
      writeFileSync(path, addHeader(readFileSync(path, 'utf8'), prefix, license));
    }
    console.log(`spdx : ${missing.length} en-tête(s) ajouté(s).`);
  }
}
