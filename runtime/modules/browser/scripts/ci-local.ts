// SPDX-License-Identifier: AGPL-3.0-only
// CI locale du module SYM Browser : rejoue le job `browser` de .github/workflows/ci.yml (le job appelle ce même script).
// Usage, depuis runtime/ : `pnpm --filter @sym-browser/module ci:local [--skip-image]`. S'arrête au premier échec (code ≠ 0).
// Périmètre : le module (apps/*, packages/*, racine) et son contrat @sym/contracts ; la suite complète reste `pnpm ci:local`.
import { spawnSync } from 'node:child_process';

type Step = { name: string; cmd: string[]; expect?: (stdout: string) => string | undefined };

const MODULE = ['--filter', '@sym/contracts', '--filter', './modules/browser/**'];
const IMAGE = 'sym-browser:ci-local';
const SECCOMP = ['--security-opt', 'seccomp=modules/browser/deploy/seccomp-chromium.json'];

const steps: Step[] = [
  { name: 'install (lockfile gelé)', cmd: ['pnpm', 'install', '--frozen-lockfile'] },
  { name: 'build (contrat puis module)', cmd: ['pnpm', ...MODULE, 'build'] },
  { name: 'typecheck', cmd: ['pnpm', ...MODULE, 'typecheck'] },
  { name: 'lint (frontière comprise)', cmd: ['pnpm', 'exec', 'eslint', 'modules/browser', 'packages/contracts'] },
  { name: 'en-têtes SPDX', cmd: ['node', 'scripts/spdx-headers.ts', '--check'] },
  { name: 'licences (SDK et contrat MIT sans copyleft)', cmd: ['node', 'scripts/check-licenses.ts'] },
  { name: 'tests (contrat, paquets, racine du module)', cmd: ['pnpm', ...MODULE, 'test'] },
];

if (!process.argv.includes('--skip-image')) {
  steps.push(
    { name: 'image : docker build', cmd: ['docker', 'build', '-f', 'modules/browser/Dockerfile', '-t', IMAGE, '.'] },
    {
      name: 'image : id -u du processus ≠ 0 (seccomp appliqué)',
      cmd: ['docker', 'run', '--rm', ...SECCOMP, IMAGE, 'id', '-u'],
      expect: (out) => (/^\d+$/.test(out.trim()) && Number(out.trim()) !== 0 ? undefined : `uid attendu non nul, obtenu « ${out.trim()} »`),
    },
    {
      name: 'image : point d’entrée (tini → passerelle)',
      cmd: ['docker', 'run', '--rm', ...SECCOMP, IMAGE],
      expect: (out) => (out.includes('SYM Browser gateway') ? undefined : `sortie inattendue : « ${out.trim()} »`),
    },
  );
}

const runtimeDir = new URL('../../..', import.meta.url).pathname;

for (const [index, step] of steps.entries()) {
  console.log(`\n==> [${index + 1}/${steps.length}] browser : ${step.name}`);
  const [command = '', ...args] = step.cmd;
  const result = spawnSync(command, args, { cwd: runtimeDir, stdio: ['inherit', step.expect ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8' });
  if (step.expect && typeof result.stdout === 'string') process.stdout.write(result.stdout);
  const problem = result.status !== 0 ? `code ${result.status ?? 'signal'}` : step.expect?.(result.stdout ?? '');
  if (problem !== undefined) {
    console.error(`\nci:local (browser) : échec à l'étape « ${step.name} » (${problem}).`);
    process.exit(result.status && result.status !== 0 ? result.status : 1);
  }
}
const skipped = process.argv.includes('--skip-image') ? ' (image Docker non vérifiée : --skip-image)' : '';
console.log(`\nci:local (browser) : toutes les étapes sont vertes${skipped}.`);
