// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 3.8, livrable « quickstart rejoué en CI de bout en bout » : le code du quickstart (docs/en/quickstart.md ; la version
// française porte le même code, tests/docs.unit.test.ts) est extrait du Markdown et exécuté TEL QUEL par `node`, comme un
// lecteur qui le copie, contre une instance SYM Browser : API REST de la passerelle (2.2) sur PostgreSQL migré, jetons de
// connexion HMAC, relais WSS public puis relais du nœud (2.3), Chromium dédié du pool (1.1, 1.4) sur l'egress de sa session
// (1.5), site de test de la tâche 0.5 comme destination. L'étape « démarrer SYM Browser » est rejouée sur l'image construite
// par tests/deploy.e2e.test.ts (quickstart_replayed_on_image) ; ici, les étapes 3 à 5 tournent sans image, sur le banc
// tests/helpers/quickstart-instance.ts.
// Prérequis : utilisateur non root (bac à sable de Chromium), `playwright install chromium`, Docker ou SYMB_TEST_PG_URL.
// Sécurité : le seul processus lancé ici est `node` sur le script du quickstart (enfant direct, arrêté par `timeout` du
// spawn) ; Chromium est arrêté par le pool (groupe de processus enregistré à son lancement).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';
import { startSite, type SiteHandle } from '../fixtures/src/site.ts';
import { extractQuickstart } from '../scripts/docs-lib.ts';
import { startQuickstartInstance, type QuickstartInstance } from './helpers/quickstart-instance.ts';

let site: SiteHandle;
let instance: QuickstartInstance;
let workDir: string;

beforeAll(async () => {
  if (process.getuid?.() === 0) throw new Error('quickstart : lance-le sous un utilisateur non root (le bac à sable de Chromium refuse root, 03 § 7).');
  site = await startSite({ host: '127.0.0.1' });
  instance = await startQuickstartInstance({ pgAdminUrl: inject('pgAdminUrl'), fixtureHosts: { 'site-a.test': '127.0.0.1' } });
  // Dans le module : `playwright-core` (seule dépendance du quickstart) se résout comme chez le lecteur.
  workDir = await mkdtemp(join(MODULE_ROOT, '.quickstart-'));
}, 180_000);

afterAll(async () => {
  await instance?.close();
  await site?.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
}, 120_000);

function runNode(script: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: workDir, env: { ...process.env, ...env }, timeout: 120_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('quickstart rejoué de bout en bout (tâche 3.8)', () => {
  test('quickstart_replayed : session créée par l’API, page ouverte par connectOverCDP au travers des relais et de l’egress, session libérée', async () => {
    const { code, blocks } = extractQuickstart(await readFile(join(MODULE_ROOT, 'docs/en/quickstart.md'), 'utf8'));
    expect(blocks).toBeGreaterThanOrEqual(3);
    const script = join(workDir, 'quickstart.mjs');
    await writeFile(script, code);

    const target = `http://site-a.test:${site.port}/`;
    const run = await runNode(script, { SYMB_URL: instance.url, SYMB_API_KEY: instance.apiKey, TARGET_URL: target });
    expect(run.stderr).toBe('');
    expect(run.code, run.stdout).toBe(0);

    const created = /^session ([0-9a-f-]{36}): running \(dedicated\)$/m.exec(run.stdout);
    expect(created, run.stdout).not.toBeNull();
    const id = created![1]!;
    expect(run.stdout).toContain('title: SYM Browser fixtures');
    expect(run.stdout).toMatch(new RegExp(`^session ${id}: ended \\(released\\)$`, 'm'));

    // Ce que le quickstart affirme est vrai côté instance : état en base, page servie au travers de l'egress de la session,
    // Chromium détruit, répertoire de session supprimé (BINV3).
    expect(await instance.sessionState(id)).toEqual({ state: 'ended', endReason: 'released' });
    expect(instance.egressHosts(id)).toContain('site-a.test');
    expect(site.journal.entries().some((r) => r.path === '/')).toBe(true);
    expect(await instance.residue()).toEqual({ chromiumProcesses: 0, sessionDirs: [] });
  });
});
