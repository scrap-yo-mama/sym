// SPDX-License-Identifier: MIT
// Tests qui exécutent le SDK dans un process Node séparé (sortie du process, exemple du README) : ils lisent le SDK
// compilé (`dist/`). `ensureSdkBuilt` le recompile (tsc -b, incrémental) pour qu'un `vitest run` seul suffise.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SDK_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const SDK_DIST_ENTRY = join(SDK_DIR, 'dist', 'index.js');

export function ensureSdkBuilt(): void {
  const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-b'], { cwd: SDK_DIR, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`compilation du SDK impossible :\n${result.stdout}${result.stderr}`);
}
