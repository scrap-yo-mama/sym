// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm vitrine:community` : régénère .github/CODE_OF_CONDUCT.md, CONTRIBUTING.md et SECURITY.md depuis runtime/ (profil de
// communauté détecté par GitHub) ; `--check` : échoue si une copie est absente, périmée ou a un lien relatif cassé.
import { communityProblems, communitySync } from './lib/community.ts';

if (process.argv.includes('--check')) {
  const problems = communityProblems();
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('.github/ porte les copies à jour du profil de communauté.');
} else {
  for (const name of communitySync()) console.log(`copié : runtime/${name} -> .github/${name}`);
}
