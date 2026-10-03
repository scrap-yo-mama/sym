// SPDX-License-Identifier: AGPL-3.0-only
// Borne de durée de la régression visuelle linux (pnpm visual:image, 3.17, D-88) : un conteneur bloqué a gelé un verrou de
// tests pendant près de six heures. Le conteneur porte un nom, la commande docker une durée maximale (surchargeable) ; à
// l'expiration, le conteneur est supprimé de force et la commande échoue. La CI GitHub borne aussi le job e2e et l'étape.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DEFAULT_VISUAL_TIMEOUT_MS, runBoundedContainer, visualContainerScript, visualContainerName, visualTimeoutMs, type SpawnLike } from '../scripts/visual-image-bound.ts';

const runtimeRoot = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, runtimeRoot), 'utf8');

describe('pnpm visual:image : conteneur nommé et borné dans le temps (D-88)', () => {
  test('durée maximale : 25 min par défaut, surchargeable par SYM_VISUAL_TIMEOUT_MS (entier positif seulement)', () => {
    expect(DEFAULT_VISUAL_TIMEOUT_MS).toBe(25 * 60 * 1000);
    expect(visualTimeoutMs({})).toBe(DEFAULT_VISUAL_TIMEOUT_MS);
    expect(visualTimeoutMs({ SYM_VISUAL_TIMEOUT_MS: '60000' })).toBe(60_000);
    for (const bad of ['', '0', '-5', 'abc', '1.5']) expect(() => visualTimeoutMs({ SYM_VISUAL_TIMEOUT_MS: bad }), bad).toThrow(/SYM_VISUAL_TIMEOUT_MS/);
  });

  test('le conteneur porte un nom propre au processus, pour être tué', () => {
    expect(visualContainerName(4242)).toBe('sym-visual-4242');
  });

  test('docker run reçoit --name et la borne de durée ; un run terminé à temps rend son code', () => {
    const calls: { args: readonly string[]; options: Record<string, unknown> }[] = [];
    const spawn: SpawnLike = (_command, args, options) => {
      calls.push({ args, options: options as Record<string, unknown> });
      return { status: 0, signal: null };
    };
    const result = runBoundedContainer(spawn, ['--rm', 'image', 'bash'], { name: 'sym-visual-1', timeoutMs: 1000 });
    expect(result).toEqual({ status: 0, timedOut: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 3)).toEqual(['run', '--name', 'sym-visual-1']);
    expect(calls[0]?.options['timeout']).toBe(1000);
  });

  test('à l’expiration : docker rm -f du conteneur nommé, puis échec (jamais une réussite)', () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const spawn: SpawnLike = (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'run') return { status: null, signal: 'SIGKILL', error: Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
      return { status: 0, signal: null };
    };
    const result = runBoundedContainer(spawn, ['--rm', 'image'], { name: 'sym-visual-7', timeoutMs: 10 });
    expect(result.timedOut).toBe(true);
    expect(result.status).not.toBe(0);
    expect(calls.map((c) => [c.command, ...c.args].join(' '))).toContain('docker rm -f sym-visual-7');
  });

  test('dossier de sortie rendu au propriétaire de l’hôte (root dans le conteneur, coureur non root sur GitHub) ; captures copiées seulement en échec', () => {
    const compare = visualContainerScript({ update: false, owner: '1001:121' });
    expect(compare).toContain('chown -R 1001:121 /out');
    // Le chown passe après les copies et avant la sortie, même en échec de la suite.
    expect(compare.indexOf('chown -R 1001:121 /out')).toBeGreaterThan(compare.indexOf('/out/test-results'));
    expect(compare.trimEnd().endsWith('exit $status')).toBe(true);
    expect(compare).toMatch(/if \[ "\$status" -ne 0 \] && \[ -d test-results \]; then cp -R test-results \/out\/test-results; fi/);
    expect(compare).not.toContain('/out/linux');
    expect(visualContainerScript({ update: true, owner: '501:20' })).toContain('cp -R e2e/__visual__/linux /out/linux');
    // Sans propriétaire connu (Windows), aucun chown.
    expect(visualContainerScript({ update: false, owner: null })).not.toContain('chown');
  });

  test('visual-image.ts passe par cette borne ; la CI GitHub borne le job e2e et l’étape pnpm visual:image', () => {
    const script = read('scripts/visual-image.ts');
    expect(script).toMatch(/runBoundedContainer\(/);
    expect(script).not.toMatch(/spawnSync\('docker'/);
    const workflow = read('../.github/workflows/ci.yml');
    const e2eJob = /\n {2}e2e:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/.exec(workflow)?.[1] ?? '';
    expect(e2eJob).toMatch(/^ {4}timeout-minutes: \d+$/m);
    expect(e2eJob).toMatch(/- run: pnpm visual:image\n\s+timeout-minutes: \d+/);
  });
});
