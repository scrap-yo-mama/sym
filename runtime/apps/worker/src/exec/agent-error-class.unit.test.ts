// SPDX-License-Identifier: AGPL-3.0-only
// U1.12, UX-23 : classe d'erreur du moteur agentique (code fermé, jamais le message) et test « Navigateur » vu par le
// worker : un essai `agent` qui échoue dit POURQUOI (`agent_engine_error` + classe), au lieu de `trial_error` muet après
// 60 s d'attente. Le message d'une erreur peut porter une valeur du site ou personnelle : il ne sort jamais.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmError } from '@runtime/llm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ChromiumLaunchError } from '../browser/agent-browser.js';
import { probeAgentBrowser } from '../browser/agent-browser-probe.js';
import { agentEngineErrorClass } from './agent-error-class.js';

describe('classe d’erreur du moteur agentique (UX-23)', () => {
  test('lancement de Chromium raté : le code fermé de l’erreur, sans son argument', () => {
    expect(agentEngineErrorClass(new ChromiumLaunchError('chromium_launch_signal:SIGTRAP', 'stderr zz'))).toBe('chromium_launch_signal');
    expect(agentEngineErrorClass(new ChromiumLaunchError('chromium_launch_exit:3'))).toBe('chromium_launch_exit');
    expect(agentEngineErrorClass(new ChromiumLaunchError('chromium_launch_timeout'))).toBe('chromium_launch_timeout');
    expect(agentEngineErrorClass(new ChromiumLaunchError('chromium_not_started:ENOENT'))).toBe('chromium_not_started');
  });
  test('délai dépassé, navigateur fermé, navigation en échec, erreur du modèle', () => {
    expect(agentEngineErrorClass(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(agentEngineErrorClass(new Error('Timeout 30000ms exceeded.'))).toBe('timeout');
    expect(agentEngineErrorClass(new Error('Target page, context or browser has been closed'))).toBe('browser_closed');
    expect(agentEngineErrorClass(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://zz-secret.example/?q=zz_personal'))).toBe('navigation_failed');
    expect(agentEngineErrorClass(new LlmError('rate_limited', 'x'))).toBe('llm_rate_limited');
  });
  test('toute autre erreur : classe unknown, jamais le message', () => {
    const c = agentEngineErrorClass(new Error('boom zz_test_valeur_personnelle_7'));
    expect(c).toBe('unknown');
    expect(agentEngineErrorClass('texte')).toBe('unknown');
  });
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zz_test_probe_'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function fakeChromium(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe('test « Navigateur » du worker (UX-23, Diagnostic)', () => {
  const env = { PATH: process.env['PATH'] ?? '' };
  test('Chromium tué au lancement : ok false, classe et durée, aucun message libre', async () => {
    const exe = await fakeChromium('crash.js', "setTimeout(() => process.kill(process.pid, 'SIGTRAP'), 50);");
    const out = await probeAgentBrowser({ executablePath: exe, launchTimeoutMs: 20_000, env });
    expect(out).toMatchObject({ ok: false, class: 'chromium_launch_signal' });
    expect(typeof out.ms).toBe('number');
    expect(JSON.stringify(out)).not.toMatch(/SIGTRAP/);
  });
  test('binaire absent : chromium_not_started', async () => {
    expect(await probeAgentBrowser({ executablePath: join(dir, 'absent'), launchTimeoutMs: 20_000, env })).toMatchObject({ ok: false, class: 'chromium_not_started' });
  });
});
