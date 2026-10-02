// SPDX-License-Identifier: AGPL-3.0-only
// CI locale (remplace GitHub Actions tant que la facturation est bloquée) : rejoue en séquence les étapes des jobs
// quality, docs, vitrine, unit, security, image, e2e et integration de .github/workflows/ci.yml. S'arrête au premier échec (code ≠ 0).
import { spawnSync } from 'node:child_process';

type Step = { job: string; name: string; cmd: string[]; cwd?: 'root' };

const STEPS: Step[] = [
  { job: 'quality', name: 'install', cmd: ['pnpm', 'install', '--frozen-lockfile'] },
  { job: 'quality', name: 'build', cmd: ['pnpm', 'build'] },
  { job: 'quality', name: 'garde X6 (racine du dépôt)', cmd: ['node', 'runtime/scripts/check-x6.ts'], cwd: 'root' },
  { job: 'quality', name: 'garde X6 (historique git complet)', cmd: ['node', 'runtime/scripts/check-x6.ts', '--history'], cwd: 'root' },
  { job: 'quality', name: 'typecheck', cmd: ['pnpm', 'typecheck'] },
  { job: 'quality', name: 'lint', cmd: ['pnpm', 'lint'] },
  { job: 'quality', name: 'knip', cmd: ['pnpm', 'knip'] },
  { job: 'quality', name: 'invariants', cmd: ['pnpm', 'check:invariants'] },
  { job: 'quality', name: 'deps épinglées', cmd: ['pnpm', 'check:deps-pinned'] },
  { job: 'quality', name: 'liste noire INV6', cmd: ['pnpm', 'check:blacklist'] },
  { job: 'quality', name: 'licences', cmd: ['pnpm', 'check:licenses'] },
  { job: 'quality', name: 'portes de release (workflows, image non root)', cmd: ['pnpm', 'check:release'] },
  // Tâche 4.9 : release à blanc (cosign avec une clé de test, SBOM CycloneDX, rien de publié ni de poussé).
  { job: 'quality', name: 'release à blanc', cmd: ['pnpm', 'release:dry-run'] },
  // Tâche 4.8 : site de doc (VitePress, Pagefind, llms.txt) construit, 0 lien mort, puis tests de contenu (Usage responsable en 11
  // sections, Hors périmètre, variables, commandes). Rien n'est publié.
  { job: 'docs', name: 'site de doc : build, liens, llms.txt, contenu', cmd: ['pnpm', 'docs:test'] },
  // Tâche 4.12 : job `vitrine` (README en et fr, visuels et budgets, registre des allégations, licence, surface du dépôt), Node seulement.
  { job: 'vitrine', name: 'vitrine : contrôles statiques', cmd: ['node', 'scripts/vitrine/check.mjs'] },
  { job: 'vitrine', name: 'vitrine : tests nommés', cmd: ['pnpm', 'vitest', 'run', '--project', 'unit', 'tests/vitrine', 'tests/public-showcase.unit.test.ts'] },
  // Tâche 4.11 : job `vitrine` (critère : tous les assert_landing_* verts dans ce job). Les gates de contenu et du site construit
  // (vitest, projets unit et contract), puis le volet Chromium sur la préproduction (build de production servi comme GitHub Pages, sans
  // déploiement) : cookie, requêtes tierces, traceurs, CSP vue par le navigateur, axe, mouvement, budgets de poids ; puis la sonde.
  { job: 'vitrine', name: 'landing : contenu et site construit', cmd: ['pnpm', 'vitest', 'run', '--project', 'unit', '--project', 'contract', 'apps/docs/src/landing'] },
  { job: 'vitrine', name: 'landing : gates Chromium sur la préproduction', cmd: ['pnpm', '--filter', '@runtime/docs', 'test:e2e'] },
  { job: 'vitrine', name: 'landing : sonde de préproduction', cmd: ['pnpm', '--filter', '@runtime/docs', 'landing:probe', '--preprod'] },
  { job: 'unit', name: 'tests unitaires + couverture', cmd: ['pnpm', 'test:coverage'] },
  // Étage S : garde SSRF sur fetch et Chromium (Playwright). Chromium : pnpm exec playwright install chromium.
  { job: 'security', name: 'sécurité (SSRF, Chromium)', cmd: ['pnpm', 'test:security'] },
  // F-20261001-R01 : image construite en local (rien de poussé), démarrée sous les capacités de Render (no-new-privileges)
  // puis en Docker classique : bac à sable isolé, enfants sans capacité, aucun processus root, arrêt propre.
  { job: 'image', name: 'image : privilèges du bac à sable (Render, Docker classique)', cmd: ['pnpm', 'test:image'] },
  // Étage E2 : extension construite dans Chromium contre une instance réelle (tâche 2.6, PG 16), puis gate d'accessibilité
  // de la console (tâche 3.9) : axe, parcours au clavier seul, live regions, sur la console construite et servie en local.
  { job: 'e2e', name: 'e2e extension et console (Playwright, Chromium)', cmd: ['pnpm', 'test:e2e'] },
  // Matrice PostgreSQL 16, 17, 18 jouée l'une après l'autre (Testcontainers, PG_VERSIONS surchargeable).
  { job: 'integration', name: 'integration (PG ' + (process.env.PG_VERSIONS ?? '16,17,18') + ')', cmd: ['pnpm', 'test:integration'] },
  { job: 'integration', name: 'contract', cmd: ['pnpm', 'vitest', 'run', '--project', 'contract'] },
  // Tâche 4.8 : le quickstart du site de doc rejoué sur une instance vierge (même script que le job `docs` de la CI).
  { job: 'docs', name: 'quickstart rejoué sur une instance vierge', cmd: ['pnpm', 'docs:quickstart'] },
];

const runtimeDir = new URL('..', import.meta.url).pathname;
const rootDir = new URL('../..', import.meta.url).pathname;
// Les tests d'intégration démarrent leur propre PostgreSQL (Testcontainers) : aucune base locale requise.
const env = { ...process.env };

for (const [index, step] of STEPS.entries()) {
  console.log(`\n==> [${index + 1}/${STEPS.length}] ${step.job} : ${step.name}`);
  const [command = '', ...args] = step.cmd;
  const result = spawnSync(command, args, { cwd: step.cwd === 'root' ? rootDir : runtimeDir, env, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nci:local : échec à l'étape « ${step.job} : ${step.name} » (code ${result.status ?? 'signal'}).`);
    process.exit(result.status ?? 1);
  }
}
console.log('\nci:local : toutes les étapes sont vertes.');
