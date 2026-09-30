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
  { job: 'unit', name: 'tests unitaires + couverture', cmd: ['pnpm', 'test:coverage'] },
  { job: 'integration', name: 'integration + contract', cmd: ['pnpm', 'vitest', 'run', '--project', 'integration', '--project', 'contract'] },
];

const runtimeDir = new URL('..', import.meta.url).pathname;
const rootDir = new URL('../..', import.meta.url).pathname;
// Même valeur que le service postgres de ci.yml (surchargeable).
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/runtime_test' };

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
