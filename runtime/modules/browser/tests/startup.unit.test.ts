// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 0.4 (cdc/sym-browser 06) au niveau du process, comme l'image le lance : `node dist/main.js` dans chaque mode.
//   Given chaque mode / When démarrage / Then /readyz 200
//   Given MASTER_KEY invalide / Then sortie code ≠ 0 et message nommant la variable
// Sécurité : seuls les enfants créés ici sont signalés, par leur objet ChildProcess (jamais par pid ni par nom).
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const GATEWAY_MAIN = 'modules/browser/apps/gateway/dist/main.js';
const NODE_MAIN = 'modules/browser/apps/node/dist/main.js';

const validEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  MASTER_KEY: randomBytes(32).toString('base64'),
  DATABASE_URL: 'postgres://symb:secret@db.invalid:5432/symb',
  PORT: '0',
  ...extra,
});
const MODE_ENV: Record<string, Record<string, string>> = {
  all: {},
  gateway: { SYMB_MODE: 'gateway', NODE_TOKEN: 'n'.repeat(32) },
  node: { SYMB_MODE: 'node', NODE_TOKEN: 'n'.repeat(32), NODE_PUBLIC_URL: 'http://node-1.internal:3000' },
};

type Started = { child: ChildProcess; port: number; mode: string; stderr: () => string; exited: Promise<number | null> };
const children: ChildProcess[] = [];

function launch(main: string, env: Record<string, string>): Promise<Started> {
  const child = spawn('node', [main], { cwd: RUNTIME, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`pas de ligne « listening » après 20 s ; stderr : ${stderr}`)), 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        try {
          const event = JSON.parse(line) as { msg?: string; port?: number; mode?: string };
          if (event.msg === 'listening' && event.port !== undefined) {
            clearTimeout(timer);
            resolve({ child, port: event.port, mode: event.mode ?? '', stderr: () => stderr, exited });
          }
        } catch {
          // ligne partielle : la suite arrive au prochain bloc
        }
      }
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`process sorti (code ${code}) avant d'écouter ; stderr : ${stderr}`));
    });
  });
}

beforeAll(() => {
  // Rejoue le build de la CI locale pour les seuls paquets lancés ici ; incrémental, quasi instantané s'il est à jour.
  execFileSync('pnpm', ['--filter', '@sym/contracts', '--filter', '@sym-browser/core', '--filter', '@sym-browser/gateway', '--filter', '@sym-browser/node', 'build'], { cwd: RUNTIME, stdio: 'pipe' });
}, 180_000);

afterAll(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

describe('Given chaque mode / When démarrage / Then /readyz 200 (tâche 0.4)', () => {
  test.each(Object.keys(MODE_ENV))('mode %s : le process écoute, /healthz et /readyz répondent 200, SIGTERM sort avec 0', async (mode) => {
    const started = await launch(GATEWAY_MAIN, validEnv(MODE_ENV[mode]));
    expect(started.mode).toBe(mode);
    const health = await fetch(`http://127.0.0.1:${started.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    const ready = await fetch(`http://127.0.0.1:${started.port}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', mode });
    started.child.kill('SIGTERM');
    expect(await started.exited).toBe(0);
  });

  test('le binaire du nœud prend le mode node par défaut', async () => {
    const started = await launch(NODE_MAIN, validEnv({ NODE_TOKEN: 'n'.repeat(32), NODE_PUBLIC_URL: 'http://node-1.internal:3000' }));
    expect(started.mode).toBe('node');
    expect((await fetch(`http://127.0.0.1:${started.port}/readyz`)).status).toBe(200);
    started.child.kill('SIGTERM');
    expect(await started.exited).toBe(0);
  });
});

describe('Given MASTER_KEY invalide / Then sortie code ≠ 0 et message nommant la variable (tâche 0.4)', () => {
  test.each(Object.keys(MODE_ENV))('mode %s', (mode) => {
    const result = spawnSync('node', [GATEWAY_MAIN], { cwd: RUNTIME, env: validEnv({ ...MODE_ENV[mode], MASTER_KEY: 'pas-une-cle-valide' }), encoding: 'utf8', timeout: 20_000 });
    expect(result.status).not.toBe(0);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/MASTER_KEY invalide/);
    expect(result.stderr).not.toContain('pas-une-cle-valide');
    expect(result.stdout).toBe('');
  });

  test('MASTER_KEY absente : le message la nomme aussi', () => {
    const env = validEnv();
    delete env['MASTER_KEY'];
    const result = spawnSync('node', [GATEWAY_MAIN], { cwd: RUNTIME, env, encoding: 'utf8', timeout: 20_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/MASTER_KEY obligatoire/);
  });

  test('--check-config : code 0 et résumé sans secret avec une configuration valide', () => {
    const env = validEnv();
    const result = spawnSync('node', [GATEWAY_MAIN, '--check-config'], { cwd: RUNTIME, env, encoding: 'utf8', timeout: 20_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/configuration valide/);
    expect(result.stdout).not.toContain('db.invalid');
  });
});
