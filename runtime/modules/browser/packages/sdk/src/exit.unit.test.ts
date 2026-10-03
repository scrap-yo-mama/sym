// SPDX-License-Identifier: MIT
// Fermeture automatique (cdc/sym-browser 04 § 10) : le SDK libère les sessions qu'il a créées à la sortie du process
// (`SIGINT`, `SIGTERM`, `beforeExit`). Chaque cas lance un process Node ENFANT (script dans un dossier temporaire, SDK
// compilé) contre le serveur bouchon. Sécurité : le signal est envoyé par l'objet ChildProcess de l'enfant créé ici,
// jamais à un autre pid ; un enfant qui ne sort pas est arrêté de la même façon (SIGKILL sur son objet ChildProcess).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensureSdkBuilt, SDK_DIST_ENTRY } from './testing/build.js';
import { sendJson, startStubServer, type StubServer } from './testing/stub-server.js';

const ID = '0b7c4f3e-8a51-4b2f-9d0e-1c2a3b4c5d6e';
let stub: StubServer;
let dir: string;

beforeAll(async () => {
  ensureSdkBuilt();
  dir = await mkdtemp(join(tmpdir(), 'zz_symb_sdk_exit_'));
  stub = await startStubServer((req, res) => {
    const base = { id: ID, type: 'shared', expiresAt: '2026-10-02T10:02:00.000Z', createdAt: '2026-10-02T10:00:00.000Z', metadata: {} };
    if (req.method === 'POST') return sendJson(res, 201, { ...base, state: 'running', connectUrls: { cdp: null, playwright: 'ws://127.0.0.1:1/x', bidi: null } });
    if (req.method === 'DELETE') return sendJson(res, 200, { ...base, state: 'ended', endReason: 'released' });
    sendJson(res, 404, {});
  });
}, 120_000);

afterAll(async () => {
  await stub?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Script de l'enfant : crée une session puis attend (`hold`) ou se termine de lui-même. */
async function child(name: string, hold: boolean): Promise<ChildProcess & { output: () => string }> {
  const file = join(dir, `${name}.mjs`);
  await writeFile(
    file,
    [
      `import { SymBrowser } from ${JSON.stringify(SDK_DIST_ENTRY)};`,
      `const symb = new SymBrowser({ url: ${JSON.stringify(stub.url)}, apiKey: 'symb_child' });`,
      'await symb.sessions.create({ type: "shared" });',
      'console.log("ready");',
      hold ? 'setInterval(() => undefined, 1000);' : '',
    ].join('\n'),
  );
  const proc = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  proc.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  return Object.assign(proc, { output: () => out });
}

function exited(proc: ChildProcess, ms = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), ms);
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

const deletes = (): number => stub.requests.filter((r) => r.method === 'DELETE' && r.path === `/v1/sessions/${ID}`).length;

describe('libération à la sortie du process', () => {
  test.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)('%s : la session créée est libérée, puis le process sort (code %i)', async (signal, expected) => {
    const before = deletes();
    const proc = await child(`hold-${signal}`, true);
    await new Promise<void>((resolve, reject) => {
      proc.stdout?.on('data', () => (proc.output().includes('ready') ? resolve() : undefined));
      proc.once('exit', () => reject(new Error(`enfant sorti avant « ready » : ${proc.output()}`)));
    });
    proc.kill(signal);
    const result = await exited(proc);
    expect(result, proc.output()).toEqual({ code: expected, signal: null });
    expect(deletes() - before).toBe(1);
  }, 30_000);

  test('beforeExit : un script qui se termine sans libérer libère quand même sa session', async () => {
    const before = deletes();
    const proc = await child('natural', false);
    const result = await exited(proc);
    expect(result, proc.output()).toEqual({ code: 0, signal: null });
    expect(proc.output()).toContain('ready');
    expect(deletes() - before).toBe(1);
  }, 30_000);
});
