// SPDX-License-Identifier: AGPL-3.0-only
// Garde d'organisation homonyme hors README (22 §3.1, 22b §3, assert_verify_snippet_works) : la doc (site et doc
// d'exploitation), les guides et modèles de déploiement et les textes de runtime/ ne citent comme dépôt GitHub ou image
// GHCR que l'identité publique (PUBLIC_REPOSITORY). Seuls les dépôts tiers relus de `third-party-repos.txt` font exception
// (ils ne sont jamais une source d'image ni un dépôt du projet). Les marques de réservation (`<propriétaire>`, `${…}`) sont
// ignorées.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PublicIdentity } from './identity.ts';
import { repoRoot, runtimeDir, vitrineDir } from './paths.ts';

/** Dossiers et fichiers lus (chemins depuis la racine du dépôt). */
const SCOPE_DIRS = ['runtime/apps/docs/content', 'runtime/docs', 'runtime/deploy'];
const SCOPE_FILES = ['render.yaml'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vitepress', 'public']);
const TEXT = /\.(md|ya?ml|json|sh|toml|txt)$|(^|\/)Dockerfile[^/]*$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (TEXT.test(full)) out.push(full);
  }
  return out;
}

/** Fichiers contrôlés, chemins relatifs à la racine du dépôt. */
export function ownerReferenceFiles(): string[] {
  const files = SCOPE_DIRS.flatMap((dir) => walk(join(repoRoot, dir)));
  for (const name of readdirSync(runtimeDir)) {
    const full = join(runtimeDir, name);
    if (name.endsWith('.md') && statSync(full).isFile()) files.push(full);
  }
  for (const name of SCOPE_FILES) files.push(join(repoRoot, name));
  return files.map((file) => relative(repoRoot, file)).sort();
}

/** Dépôts tiers relus (`propriétaire/dépôt`, un par ligne, `#` = commentaire). */
export function loadThirdPartyRepos(): string[] {
  return readFileSync(join(vitrineDir, 'third-party-repos.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.toLowerCase());
}

const REFERENCE = /\b(github\.com|ghcr\.io)\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)/g;

/** Problèmes (liste vide : conforme) : chaque dépôt GitHub ou image GHCR cité est celui de l'identité publique. */
export function ownerReferenceProblems(text: string, identity: PublicIdentity, thirdParty: readonly string[]): string[] {
  const problems: string[] = [];
  const own = identity.repository.toLowerCase();
  for (const m of text.matchAll(REFERENCE)) {
    const host = m[1] ?? '';
    const cited = `${m[2] ?? ''}/${(m[3] ?? '').replace(/\.git$/, '').replace(/\.+$/, '')}`.toLowerCase();
    if (cited === own) continue;
    if (host === 'ghcr.io') problems.push(`image GHCR d'un autre propriétaire ou dépôt que ${identity.repository} : ${m[0]}`);
    else if (!thirdParty.includes(cited)) problems.push(`lien vers un autre dépôt que ${identity.repository} (ni dépôt tiers relu) : ${m[0]}`);
  }
  return problems;
}
