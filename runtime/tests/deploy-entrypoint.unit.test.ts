// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.1 : le point d'entrée de l'image exécute une commande passée en argument (pré-déploiement des hébergeurs :
// `runtime migrate`, `runtime keygen`) au lieu de démarrer un rôle, et l'image fournit la commande `runtime`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const runtimeDir = new URL('..', import.meta.url).pathname;
const entrypoint = join(runtimeDir, 'deploy/entrypoint.sh');

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [entrypoint, ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env }, timeout: 20_000 });
}

describe('assert_entrypoint_runs_command : commande passée en argument (4.1)', () => {
  test('arguments multiples : exécutés tels quels, sans démarrer de rôle', () => {
    const res = run(['printf', '%s|%s', 'a b', 'c'], { RUNTIME_MODE: 'server' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('a b|c');
  });

  test('un seul argument contenant une commande (chaîne de pré-déploiement d’un hébergeur) : passé à sh -c', () => {
    const res = run(['echo un deux'], { RUNTIME_MODE: 'worker' });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('un deux');
  });

  test('le code de sortie de la commande est celui du conteneur', () => {
    expect(run(['sh', '-c', 'exit 7']).status).toBe(7);
  });

  test('sans argument, RUNTIME_MODE invalide reste refusé (64) : le comportement existant est conservé', () => {
    const res = run([], { RUNTIME_MODE: 'nimportequoi' });
    expect(res.status).toBe(64);
    expect(res.stderr).toMatch(/RUNTIME_MODE invalide/);
  });

  test('l’image installe la commande `runtime` (CLI) accessible dans le PATH', () => {
    const dockerfile = readFileSync(join(runtimeDir, 'deploy/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/\/usr\/local\/bin\/runtime/);
    expect(dockerfile).toMatch(/apps\/cli\/dist\/index\.js/);
  });
});
