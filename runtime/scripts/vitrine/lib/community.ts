// SPDX-License-Identifier: AGPL-3.0-only
// Profil de communauté (22 §3.5, u8 R8 à R10, assert_community_profile_complete) : GitHub ne détecte le code de conduite,
// le guide de contribution et la politique de sécurité qu'à la racine, dans .github/ ou dans docs/. Les textes canoniques
// vivent dans runtime/ (sous-dossier, jamais détecté) : .github/ en porte une copie générée (`pnpm vitrine:community`),
// liens relatifs réécrits vers ../runtime/, et le test l'exige à jour. Le miroir public copie .github/ et la racine (D-44),
// pas docs/ : seuls la racine et .github/ comptent ici.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize, posix } from 'node:path';
import { githubDir, repoRoot } from './paths.ts';

export const COMMUNITY_FILES = ['CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SECURITY.md'] as const;
export type CommunityFile = (typeof COMMUNITY_FILES)[number];

/** Emplacements du profil de communauté présents dans le dépôt public (racine, .github/ ; docs/ n'est pas copié par le miroir). */
const PROFILE_DIRS = ['', '.github/'];
const PROFILE_EXTENSIONS = ['', '.md', '.txt', '.rst'];

const defaultExists = (path: string): boolean => existsSync(join(repoRoot, path));
const defaultRead = (path: string): string | undefined => {
  const full = join(repoRoot, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
};

/** Chemin (depuis la racine du dépôt) où GitHub détecte le fichier du profil `name` (README, LICENSE…), ou undefined. */
export function communityProfileLocation(name: string, exists: (path: string) => boolean = defaultExists): string | undefined {
  for (const dir of PROFILE_DIRS) for (const ext of PROFILE_EXTENSIONS) if (exists(`${dir}${name}${ext}`)) return `${dir}${name}${ext}`;
  return undefined;
}

/** Lien Markdown relatif (ni schéma, ni ancre seule, ni chemin absolu). */
const RELATIVE_LINK = /\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi;

/** Copie de .github/ dérivée de runtime/<name> : en-tête de génération et liens relatifs réécrits vers ../runtime/. */
export function communityCopy(name: CommunityFile, source: string): string {
  const header = `<!-- Copie générée de runtime/${name} par \`pnpm vitrine:community\` : GitHub ne lit le profil de communauté qu'à la racine, dans .github/ ou docs/. Modifier runtime/${name}, puis régénérer. -->\n`;
  return header + source.replace(RELATIVE_LINK, (_match, target: string) => `](${posix.join('../runtime', target)})`);
}

/** Problèmes (liste vide : conforme) : chaque copie de .github/ existe, est à jour de runtime/ et ses liens relatifs résolvent. */
export function communityProblems(
  read: (path: string) => string | undefined = defaultRead,
  exists: (path: string) => boolean = defaultExists,
): string[] {
  const problems: string[] = [];
  for (const name of COMMUNITY_FILES) {
    const source = read(`runtime/${name}`);
    if (source === undefined) {
      problems.push(`runtime/${name} absent (texte canonique)`);
      continue;
    }
    const copy = read(`.github/${name}`);
    if (copy === undefined) {
      problems.push(`.github/${name} : copie absente, GitHub ne détecte pas runtime/${name} (lancer \`pnpm vitrine:community\`)`);
      continue;
    }
    if (copy !== communityCopy(name, source)) problems.push(`.github/${name} : copie périmée de runtime/${name} (lancer \`pnpm vitrine:community\`)`);
    for (const m of copy.matchAll(RELATIVE_LINK)) {
      const target = (m[1] ?? '').split('#')[0] ?? '';
      const path = normalize(join('.github', decodeURIComponent(target)));
      if (target !== '' && !exists(path)) problems.push(`.github/${name} : lien relatif introuvable ${m[1] ?? ''} (${path})`);
    }
  }
  return problems;
}

/** Régénère les copies de .github/ ; renvoie les noms écrits. */
export function communitySync(): string[] {
  for (const name of COMMUNITY_FILES) writeFileSync(join(githubDir, name), communityCopy(name, readFileSync(join(repoRoot, 'runtime', name), 'utf8')));
  return [...COMMUNITY_FILES];
}
