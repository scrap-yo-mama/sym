// SPDX-License-Identifier: AGPL-3.0-only
// CI locale du module SYM Browser : rejoue le job `browser` de .github/workflows/ci.yml (le job appelle ce même script).
// Usage, depuis runtime/ : `pnpm --filter @sym-browser/module ci:local [--skip-image] [--skip-chromium]`. S'arrête au premier échec (code ≠ 0).
// Périmètre : le module (apps/*, packages/*, racine) et son contrat @sym/contracts ; la suite complète reste `pnpm ci:local`.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { checkIdentity, checkNoSetuid, IDENTITY_PROBE, RUN_FLAGS, SETUID_PROBE } from './image-checks.ts';

type Step = {
  name: string;
  cmd: string[];
  env?: Record<string, string>;
  expect?: (stdout: string) => string | undefined;
  /** L'étape DOIT échouer (code ≠ 0) ; le contrôle porte sur sa sortie d'erreur. */
  expectFailure?: (stderr: string) => string | undefined;
};

const MODULE = ['--filter', '@sym/contracts', '--filter', './modules/browser/**'];
const IMAGE = 'sym-browser:ci-local';
// Clé jetable, tirée à chaque exécution : rien n'est versionné ni réutilisé. Seule la base n'est pas jointe (--check-config n'écoute pas).
const validMasterKey = randomBytes(32).toString('base64');
const imageEnv = (masterKey: string): string[] => ['-e', `MASTER_KEY=${masterKey}`, '-e', 'DATABASE_URL=postgres://symb:ci@db.invalid:5432/symb'];

const steps: Step[] = [
  { name: 'install (lockfile gelé)', cmd: ['pnpm', 'install', '--frozen-lockfile'] },
  { name: 'build (contrat puis module)', cmd: ['pnpm', ...MODULE, 'build'] },
  { name: 'typecheck', cmd: ['pnpm', ...MODULE, 'typecheck'] },
  { name: 'lint (frontière comprise)', cmd: ['pnpm', 'exec', 'eslint', 'modules/browser', 'packages/contracts'] },
  { name: 'en-têtes SPDX', cmd: ['node', 'scripts/spdx-headers.ts', '--check'] },
  { name: 'licences (SDK et contrat MIT sans copyleft)', cmd: ['node', 'scripts/check-licenses.ts'] },
  // Les tests d'intégration du schéma tournent ici sur PostgreSQL 16 (défaut) ; la matrice 17 et 18 suit (tâche 0.2).
  { name: 'tests (contrat, paquets, racine du module ; schéma sur PostgreSQL 16)', cmd: ['pnpm', ...MODULE, 'test'] },
  {
    name: 'schéma : migrations up, down, up sur PostgreSQL 17 et 18',
    cmd: ['pnpm', '--filter', '@sym-browser/db', 'test:matrix'],
    env: { PG_VERSIONS: '17,18' },
  },
  // Tâche 2.2 : contrat OpenAPI contre les réponses réelles, Schemathesis en image Docker épinglée (réseau hôte).
  { name: 'contrat OpenAPI : Schemathesis (image Docker) contre la passerelle', cmd: ['pnpm', '--filter', '@sym-browser/gateway', 'test:schemathesis'] },
];

// Nœud sur de vrais Chromium 153 (1.1 : pool_no_orphans, kill_on_close_timeout ; 1.3 : shared_context_options,
// assert_session_isolation) : utilisateur non root,
// espaces de noms utilisateur autorisés (bac à sable) et Chromium de Playwright 1.63 installé (`playwright install chromium`).
const skipChromium = process.argv.includes('--skip-chromium');
if (!skipChromium) steps.push({ name: 'tests sur Chromium réels (pool et sessions shared du nœud)', cmd: ['pnpm', '--filter', '@sym-browser/node', 'test:chromium'] });

if (!process.argv.includes('--skip-image')) {
  steps.push(
    { name: 'image : docker build', cmd: ['docker', 'build', '-f', 'modules/browser/Dockerfile', '-t', IMAGE, '.'] },
    {
      name: 'image : uid ≠ 0, filtre seccomp actif (Seccomp: 2), NoNewPrivs: 1, aucune capacité effective, tini en PID 1',
      cmd: ['docker', 'run', '--rm', ...RUN_FLAGS, IMAGE, ...IDENTITY_PROBE],
      expect: checkIdentity,
    },
    {
      name: 'image : aucun binaire setuid ou setgid',
      cmd: ['docker', 'run', '--rm', ...RUN_FLAGS, IMAGE, ...SETUID_PROBE],
      expect: checkNoSetuid,
    },
    {
      name: 'image : point d’entrée (tini → hôte de service), configuration valide',
      cmd: ['docker', 'run', '--rm', ...RUN_FLAGS, ...imageEnv(validMasterKey), IMAGE, 'node', 'modules/browser/apps/gateway/dist/main.js', '--check-config'],
      expect: (out) => (out.includes('configuration valide') ? undefined : `sortie inattendue : « ${out.trim()} »`),
    },
    {
      name: 'image : MASTER_KEY invalide, refus de démarrer (code ≠ 0, variable nommée)',
      cmd: ['docker', 'run', '--rm', ...RUN_FLAGS, ...imageEnv('invalide'), IMAGE],
      expectFailure: (err) => (err.includes('MASTER_KEY invalide') ? undefined : `message sans MASTER_KEY : « ${err.trim()} »`),
    },
  );
}

const runtimeDir = new URL('../../..', import.meta.url).pathname;

for (const [index, step] of steps.entries()) {
  console.log(`\n==> [${index + 1}/${steps.length}] browser : ${step.name}`);
  const [command = '', ...args] = step.cmd;
  const env = { ...process.env, ...(process.argv.includes('--skip-image') ? { SYM_BROWSER_SKIP_DOCKER: '1' } : {}), ...step.env };
  const result = spawnSync(command, args, { cwd: runtimeDir, env, stdio: ['inherit', step.expect ? 'pipe' : 'inherit', step.expectFailure ? 'pipe' : 'inherit'], encoding: 'utf8' });
  if (step.expect && typeof result.stdout === 'string') process.stdout.write(result.stdout);
  if (step.expectFailure && typeof result.stderr === 'string') process.stderr.write(result.stderr);
  const problem = step.expectFailure
    ? result.status === 0 || result.status === null
      ? 'code 0 : le refus de démarrer était attendu'
      : step.expectFailure(result.stderr ?? '')
    : result.status !== 0
      ? `code ${result.status ?? 'signal'}`
      : step.expect?.(result.stdout ?? '');
  if (problem !== undefined) {
    console.error(`\nci:local (browser) : échec à l'étape « ${step.name} » (${problem}).`);
    process.exit(result.status && result.status !== 0 ? result.status : 1);
  }
}
const skippedParts = [
  ...(process.argv.includes('--skip-image') ? ['image Docker non vérifiée : --skip-image'] : []),
  ...(skipChromium ? ['tests sur Chromium réels non lancés : --skip-chromium'] : []),
];
const skipped = skippedParts.length > 0 ? ` (${skippedParts.join(' ; ')})` : '';
console.log(`\nci:local (browser) : toutes les étapes sont vertes${skipped}.`);
