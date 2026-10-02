// SPDX-License-Identifier: AGPL-3.0-only
// Job CI `vitrine` (22 §3.6, 22b §5) : contrôles statiques de la vitrine du dépôt, en Node seulement (aucun .py).
//   node scripts/vitrine/check.mjs            tous les contrôles ; code 1 au premier problème (tous sont listés)
//   node scripts/vitrine/check.mjs identity   PUBLIC_REPOSITORY = .github/PUBLIC_REPOSITORY = GITHUB_REPOSITORY (release)
//   node scripts/vitrine/check.mjs changed    écrit `run=true|false` (sortie GITHUB_OUTPUT) selon les fichiers modifiés
//   node scripts/vitrine/check.mjs claims     registre des allégations et CLAIMS.md seulement (sans filtre par chemin)
//   node scripts/vitrine/check.mjs published  après publication (hebdomadaire, GO) : API GitHub du dépôt public, lecture seule
// Les budgets sont dans scripts/vitrine/budgets.json. Ce script ne publie, ne pousse ni ne règle rien sur GitHub.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAllChecks, runClaimsChecks } from './lib/all.ts';
import { vitrineTouched } from './lib/changed.ts';
import { identityOf, identityProblems, publicRepository } from './lib/identity.ts';
import { fetchPublishedState, publishedProblems } from './lib/published.ts';
import { loadBudgets } from './lib/readme.ts';
import { readRepoMetadata } from './lib/surface.ts';
import { githubDir, repoRoot } from './lib/paths.ts';

const command = process.argv[2] ?? 'all';

if (command === 'identity') {
  const problems = identityProblems(process.env, readFileSync(join(githubDir, 'PUBLIC_REPOSITORY'), 'utf8'));
  for (const problem of problems) console.error(`identité : ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log('identité publique cohérente.');
} else if (command === 'changed') {
  // PR : fichiers modifiés par rapport à la branche de base ; push : depuis le commit précédent ; sinon (ou en cas de doute) : oui.
  const base = process.env['GITHUB_BASE_REF'] ? `origin/${process.env['GITHUB_BASE_REF']}` : process.env['VITRINE_BASE'];
  let run = true;
  if (base && !/^0+$/.test(base)) {
    try {
      const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      run = vitrineTouched(out.split('\n').filter(Boolean));
    } catch {
      run = true;
    }
  }
  console.log(`vitrine : run=${run}`);
  if (process.env['GITHUB_OUTPUT']) appendFileSync(process.env['GITHUB_OUTPUT'], `run=${run}\n`);
} else if (command === 'published') {
  const token = process.env['GH_TOKEN'] || process.env['GITHUB_TOKEN'];
  if (!token) {
    console.error('après publication : aucun jeton (GH_TOKEN ou GITHUB_TOKEN) pour lire l\'API GitHub');
    process.exit(1);
  }
  const identity = identityOf(publicRepository());
  const problems = publishedProblems(await fetchPublishedState(identity, token), readRepoMetadata(), loadBudgets());
  for (const problem of problems) console.error(`après publication : ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`après publication : ${identity.repository} conforme (description, sujets, site web, Discussions, signalement privé, licence, profil de communauté).`);
} else {
  const results = command === 'claims' ? runClaimsChecks() : runAllChecks();
  let failed = 0;
  for (const { name, problems } of results) {
    if (problems.length === 0) console.log(`  ok    ${name}`);
    else {
      failed += 1;
      console.error(`  ECHEC ${name}`);
      for (const problem of problems) console.error(`          - ${problem}`);
    }
  }
  if (failed > 0) {
    console.error(`\nvitrine : ${failed} contrôle(s) en échec sur ${results.length}.`);
    process.exit(1);
  }
  console.log(`\nvitrine : ${results.length} contrôles verts.`);
}
