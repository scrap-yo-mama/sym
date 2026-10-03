// SPDX-License-Identifier: AGPL-3.0-only
// Lancement du Chromium agentique (E5-E6, UX-23) avec un faux exécutable : un Chromium tué par un signal au lancement
// (SIGTRAP de crashpad) échoue aussitôt avec sa cause, et le Chromium reçoit un HOME à lui, inscriptible (sur Render, le
// worker hérite HOME=/root, illisible pour pwuser : Chromium s'arrêtait en SIGTRAP et l'essai attendait 60 s).
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchAgentBrowser } from './agent-browser.js';

let dir: string;
const base = { egressServer: 'http://127.0.0.1:9', allowedHosts: ['zz-test.example'], allowWriteActions: false, checkRequest: async () => true } as const;

/** Faux Chromium (script Node) : il ne touche qu'à lui-même (son propre PID), jamais à un autre processus. */
async function fakeChromium(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zz_test_agent_launch_'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Chromium agentique : lancement (UX-23)', () => {
  it('tué par un signal au lancement : échec immédiat, signal et fin de stderr dans le message (pas 60 s d’attente)', async () => {
    const exe = await fakeChromium(
      'crash.js',
      "process.stderr.write(\"chrome_crashpad_handler: --database is required\\n\");\nsetTimeout(() => process.kill(process.pid, 'SIGTRAP'), 50);",
    );
    const t0 = Date.now();
    const error = await launchAgentBrowser({ ...base, executablePath: exe, launchTimeoutMs: 20_000, env: { PATH: process.env['PATH'] ?? '' } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/SIGTRAP/);
    expect((error as Error).message).toMatch(/--database is required/);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('HOME du Chromium : un répertoire à lui sous le profil, jamais le HOME du worker (/root illisible sur Render)', async () => {
    const out = join(dir, 'home.txt');
    const exe = await fakeChromium('home.js', `require('node:fs').writeFileSync(${JSON.stringify(out)}, String(process.env.HOME));\nprocess.exit(3);`);
    const error = await launchAgentBrowser({ ...base, executablePath: exe, launchTimeoutMs: 20_000, env: { PATH: process.env['PATH'] ?? '', HOME: '/zz-test-unreadable-home' } }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/code 3/);
    const home = await readFile(out, 'utf8');
    expect(home).not.toBe('/zz-test-unreadable-home');
    expect(home.startsWith(join(tmpdir(), 'zz_agent_chromium_'))).toBe(true);
  });
});
