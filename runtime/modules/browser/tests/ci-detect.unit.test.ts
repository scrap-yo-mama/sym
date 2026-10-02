// SPDX-License-Identifier: AGPL-3.0-only
// Job `detect` de .github/workflows/ci.yml (ADR 23 § 6 ; cdc/sym-browser 06 tâche 0.1) : le script RÉEL de l'étape
// « Paquets touchés et dépendants » est extrait du workflow et rejoué dans des dépôts git jetables. `pnpm` y est simulé
// (paquets du module touchés depuis la base) ; le reste (choix de la base, fichiers partagés, sortie) est le vrai script.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';

const workflow = readFileSync(join(MODULE_ROOT, '../../../.github/workflows/ci.yml'), 'utf8');

/** Étape « Paquets touchés et dépendants » du job detect : variables d'environnement et script `run`. */
function detectStep(): { env: Record<string, string>; script: string } {
  const lines = workflow.split('\n');
  const job = lines.indexOf('  detect:');
  const start = lines.findIndex((line, i) => i > job && line === '      - name: Paquets touchés et dépendants');
  expect(job).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(job);
  const step: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('        ')) break;
    step.push(line);
  }
  const env: Record<string, string> = {};
  const envAt = step.indexOf('        env:');
  if (envAt >= 0) {
    for (const line of step.slice(envAt + 1)) {
      const match = /^ {10}(\w+): (.+)$/.exec(line);
      if (!match) break;
      env[match[1] ?? ''] = match[2] ?? '';
    }
  }
  const runAt = step.indexOf('        run: |');
  expect(runAt).toBeGreaterThan(-1);
  const script = step
    .slice(runAt + 1)
    .filter((line, i, all) => line.startsWith('          ') || (line.trim() === '' && all.slice(i).some((l) => l.startsWith('          '))))
    .map((line) => line.slice(10))
    .join('\n');
  return { env, script };
}

const PNPM_STUB = `#!/bin/sh
# Simulation de \`pnpm --filter "...[BASE]" ls --depth -1 --json\` : paquets du module dont un fichier a changé depuis BASE.
base=$(printf '%s' "$2" | sed -e 's/^\\.\\.\\.\\[//' -e 's/\\]$//')
if git diff --relative --name-only "$base" | grep -q '^modules/browser/'; then echo '[{"name":"runtime"},{"name":"@sym-browser/gateway"}]'; else echo '[{"name":"runtime"}]'; fi
`;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

type Repo = { root: string; git: (...args: string[]) => string; commit: (file: string) => string };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'sym-detect-'));
  dirs.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const commit = (file: string) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${file} ${Math.random()}\n`);
    git('add', '--', file);
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  commit('runtime/package.json');
  return { root, git, commit };
}

/** Rejoue le script du job ; `ctx` donne la valeur des expressions `${{ … }}` de l'environnement de l'étape. */
function detect(r: Repo, ctx: Record<string, string>): { browser: string; log: string } {
  const { env, script } = detectStep();
  const bin = join(r.root, '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'pnpm'), PNPM_STUB);
  chmodSync(join(bin, 'pnpm'), 0o755);
  const output = join(r.root, '.github-output');
  writeFileSync(output, '');
  const stepEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const expr = /^\$\{\{ ([\w.]+) \}\}$/.exec(value)?.[1];
    if (expr === undefined || !(expr in ctx)) throw new Error(`expression non simulée dans l'environnement de l'étape : ${key}=${value}`);
    stepEnv[key] = ctx[expr] ?? '';
  }
  const log = execFileSync('bash', ['-c', script], {
    cwd: join(r.root, 'runtime'),
    encoding: 'utf8',
    env: { PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`, HOME: r.root, RUNNER_TEMP: r.root, GITHUB_OUTPUT: output, ...stepEnv },
  });
  const browser = /^browser=(\w+)$/m.exec(readFileSync(output, 'utf8'))?.[1] ?? '';
  return { browser, log };
}

const ZERO = '0'.repeat(40);

describe('job detect : choix de la base et fichiers partagés', () => {
  test('script sans expression ${{ }} en ligne (valeurs passées par env:)', () => {
    expect(detectStep().script).not.toContain('${{');
  });

  test('push de main en avance rapide : la base est github.event.before, pas HEAD~1', () => {
    const r = repo();
    const before = r.git('rev-parse', 'HEAD');
    r.commit('runtime/modules/browser/apps/gateway/src/a.ts');
    r.commit('runtime/README.md');
    r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(detect(r, { 'github.event_name': 'push', 'github.ref': 'refs/heads/main', 'github.event.before': before }).browser).toBe('true');
  });

  test.each([
    ['avant nul (nouvelle branche)', ZERO],
    ['avant inconnu (historique réécrit)', 'f'.repeat(40)],
  ])('push de main, %s : repli sur HEAD~1', (_name, before) => {
    const r = repo();
    r.commit('runtime/modules/browser/apps/gateway/src/a.ts');
    r.commit('runtime/README.md');
    r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const result = detect(r, { 'github.event_name': 'push', 'github.ref': 'refs/heads/main', 'github.event.before': before });
    expect(result.log).toContain('Base de comparaison : HEAD~1');
    expect(result.browser).toBe('false');
  });

  test('workflow_dispatch sur main : HEAD~1', () => {
    const r = repo();
    r.commit('runtime/README.md');
    r.commit('runtime/modules/browser/apps/node/src/b.ts');
    r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const result = detect(r, { 'github.event_name': 'workflow_dispatch', 'github.ref': 'refs/heads/main', 'github.event.before': '' });
    expect(result.log).toContain('Base de comparaison : HEAD~1');
    expect(result.browser).toBe('true');
  });

  test.each(['runtime/.npmrc', 'runtime/.node-version', 'runtime/scripts/spdx-headers.ts', 'runtime/scripts/check-licenses.ts', 'runtime/pnpm-lock.yaml', '.github/workflows/ci.yml'])(
    'branche ci/** ou PR : %s modifié rejoue le module',
    (file) => {
      const r = repo();
      r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      r.git('checkout', '-q', '-b', 'ci/x');
      r.commit(file);
      const result = detect(r, { 'github.event_name': 'push', 'github.ref': 'refs/heads/ci/x', 'github.event.before': ZERO });
      expect(result.log).toContain('Base de comparaison : origin/main');
      expect(result.browser).toBe('true');
    },
  );

  test('branche sans rapport avec le module ni fichier partagé : module sauté', () => {
    const r = repo();
    r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    r.git('checkout', '-q', '-b', 'ci/y');
    r.commit('runtime/apps/worker/src/c.ts');
    expect(detect(r, { 'github.event_name': 'pull_request', 'github.ref': 'refs/pull/1/merge', 'github.event.before': '' }).browser).toBe('false');
  });
});

describe('job gate de ci.yml', () => {
  // Le workflow fixe `working-directory: runtime` par défaut ; `gate` ne fait pas de checkout, ce dossier n'existe donc pas
  // sur son exécuteur : sans répertoire propre, son étape échoue avant de lire les verdicts (PR #1, tous les jobs verts).
  test('sans checkout, il s’exécute à la racine de l’espace de travail et donne son verdict', () => {
    const lines = workflow.split('\n');
    const start = lines.indexOf('  gate:');
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
    const job = lines.slice(start, end === -1 ? undefined : end).join('\n');
    expect(job).not.toContain('actions/checkout');
    expect(job).toMatch(/\n {4}defaults:\n {6}run:\n {8}working-directory: \.\n/);
    const script = /run: \|\n((?: {10}.*\n?)+)/.exec(job)?.[1]?.replace(/^ {10}/gm, '');
    expect(script).toBeDefined();
    const verdict = (results: string) => {
      try {
        return execFileSync('bash', ['-e', '-c', script!], { cwd: mkdtempSync(join(tmpdir(), 'gate-')), env: { PATH: process.env['PATH'] ?? '', RESULTS: results }, encoding: 'utf8' });
      } catch (error) {
        return `échec : ${(error as { stdout?: string }).stdout ?? ''}`;
      }
    };
    expect(verdict('success skipped success')).toContain('gate : vert.');
    expect(verdict('success failure')).toMatch(/^échec : .*au moins un job a échoué/s);
    expect(verdict('cancelled success')).toMatch(/^échec : /);
  });
});
