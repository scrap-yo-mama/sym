// SPDX-License-Identifier: AGPL-3.0-only
// Garde d'organisation homonyme (22 §3.1, 22b §3, assert_verify_snippet_works) : les README en et fr, CLAIMS.md, les
// formulaires d'issues, le gabarit des notes de version et les autres textes de .github/, la doc (site et doc
// d'exploitation), les guides et modèles de déploiement et les textes de runtime/ ne citent comme dépôt GitHub, image GHCR,
// badge shields (`img.shields.io/github/…`) ou dépôt d'une commande `-R` que l'identité publique (PUBLIC_REPOSITORY). Le
// texte brut est lu (blocs de code et badges compris), pas seulement les liens. Seuls les dépôts tiers relus de `third-party-repos.txt` font exception
// (ils ne sont jamais une source d'image ni un dépôt du projet). Les marques de réservation (`<propriétaire>`, `${…}`) sont
// ignorées.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PublicIdentity } from './identity.ts';
import { repoRoot, runtimeDir, vitrineDir } from './paths.ts';

/** Dossiers et fichiers lus (chemins depuis la racine du dépôt). */
const SCOPE_DIRS = ['runtime/apps/docs/content', 'runtime/docs', 'runtime/deploy'];
const SCOPE_FILES = ['render.yaml'];
/** Textes de .github/ lus à plat (README, CLAIMS.md, gabarits, métadonnées) et formulaires d'issues. */
const GITHUB_DIRS = ['.github', '.github/ISSUE_TEMPLATE'];
const GITHUB_TEXT = /\.(md|ya?ml|json)$/;
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
  for (const dir of GITHUB_DIRS) {
    for (const name of readdirSync(join(repoRoot, dir))) {
      const full = join(repoRoot, dir, name);
      if (GITHUB_TEXT.test(name) && statSync(full).isFile()) files.push(full);
    }
  }
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

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const REFERENCE = new RegExp(`\\b(github\\.com|ghcr\\.io)/(${OWNER})/([A-Za-z0-9._-]+)`, 'g');
/** Badge shields d'un dépôt GitHub : le propriétaire et le dépôt sont deux segments consécutifs du chemin (sa place varie). */
const SHIELDS = /\bimg\.shields\.io\/github\/([^\s"'<>()?#]+)/g;
/** `gh … -R propriétaire/dépôt` ou `--repo propriétaire/dépôt`. */
const REPO_FLAG = new RegExp(`(?:^|\\s)(?:-R|--repo)[ =]+(${OWNER})/([A-Za-z0-9._-]+)`, 'g');

const cleanName = (name: string): string => name.replace(/\.git$/, '').replace(/\.+$/, '');

/** Problèmes (liste vide : conforme) : chaque dépôt GitHub, image GHCR, badge shields ou dépôt `-R` cité est celui de l'identité publique (ou un dépôt tiers relu, jamais pour une image). */
export function ownerReferenceProblems(text: string, identity: PublicIdentity, thirdParty: readonly string[]): string[] {
  const problems: string[] = [];
  const own = identity.repository.toLowerCase();
  for (const m of text.matchAll(REFERENCE)) {
    const host = m[1] ?? '';
    const cited = `${m[2] ?? ''}/${cleanName(m[3] ?? '')}`.toLowerCase();
    if (cited === own) continue;
    if (host === 'ghcr.io') problems.push(`image GHCR d'un autre propriétaire ou dépôt que ${identity.repository} : ${m[0]}`);
    else if (!thirdParty.includes(cited)) problems.push(`lien vers un autre dépôt que ${identity.repository} (ni dépôt tiers relu) : ${m[0]}`);
  }
  for (const m of text.matchAll(SHIELDS)) {
    const segments = (m[1] ?? '').split('/').map((segment) => segment.toLowerCase());
    const pairs = segments.slice(0, -1).map((segment, i) => `${segment}/${cleanName(segments[i + 1] ?? '')}`);
    if (!pairs.includes(own) && !pairs.some((pair) => thirdParty.includes(pair))) problems.push(`badge d'un autre propriétaire ou dépôt que ${identity.repository} : ${m[0]}`);
  }
  for (const m of text.matchAll(REPO_FLAG)) {
    const cited = `${m[1] ?? ''}/${cleanName(m[2] ?? '')}`.toLowerCase();
    if (cited !== own && !thirdParty.includes(cited)) problems.push(`-R vers un autre dépôt que ${identity.repository} : ${m[0].trim()}`);
  }
  return problems;
}
