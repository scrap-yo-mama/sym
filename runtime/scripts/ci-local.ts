// SPDX-License-Identifier: AGPL-3.0-only
// CI locale (remplace GitHub Actions tant que la facturation est bloquée) : rejoue en séquence les étapes des jobs
// quality, unit et integration de .github/workflows/ci.yml. S'arrête au premier échec (code ≠ 0).
import { spawnSync } from 'node:child_process';

type Step = { job: string; name: string; cmd: string[]; cwd?: 'root' };

const STEPS: Step[] = [
  { job: 'quality', name: 'install', cmd: ['pnpm', 'install', '--frozen-lockfile'] },
  { job: 'quality', name: 'build', cmd: ['pnpm', 'build'] },
  { job: 'quality', name: 'garde X6 (racine du dépôt)', cmd: ['node', 'runtime/scripts/check-x6.ts'], cwd: 'root' },
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
  { job: 'unit', name: 'tests unitaires + couverture', cmd: ['pnpm', 'test:coverage'] },
  // Étage S : garde SSRF sur fetch et Chromium (Playwright). Chromium : pnpm exec playwright install chromium.
  { job: 'security', name: 'sécurité (SSRF, Chromium)', cmd: ['pnpm', 'test:security'] },
  // Étage E2 (tâche 2.6) : extension construite dans Chromium (contexte persistant) contre une instance réelle (PG 16).
  { job: 'e2e', name: 'e2e extension (Playwright, Chromium)', cmd: ['pnpm', 'test:e2e'] },
  // Matrice PostgreSQL 16, 17, 18 jouée l'une après l'autre (Testcontainers, PG_VERSIONS surchargeable).
  { job: 'integration', name: 'integration (PG ' + (process.env.PG_VERSIONS ?? '16,17,18') + ')', cmd: ['pnpm', 'test:integration'] },
  { job: 'integration', name: 'contract', cmd: ['pnpm', 'vitest', 'run', '--project', 'contract'] },
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
